from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from comfy_client import ComfyClient
from director import Director
from llm_client import MultimodalLLM
from models import AcceptedClip, ProjectState
from reviewer import ContinuityReviewer


def load_json(path: str | Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_state(path: Path, state: ProjectState) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(state.model_dump_json(indent=2), encoding="utf-8")


def flatten_refs(story: dict) -> list[Path]:
    refs: list[Path] = []
    for char in story.get("characters", []):
        refs += [Path(x) for x in char.get("reference_images", [])]
    refs += [Path(x) for x in story.get("environment_references", [])]
    return refs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--story", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    story_path = Path(args.story).resolve()
    config_path = Path(args.config).resolve()
    base_dir = story_path.parent
    story = load_json(story_path)
    cfg = load_json(config_path)

    # Resolve relative paths from the story/config directory.
    workflow_path = Path(cfg["workflow_path"])
    if not workflow_path.is_absolute():
        workflow_path = (config_path.parent / workflow_path).resolve()

    run_root = Path(cfg.get("output_dir", "runs"))
    if not run_root.is_absolute():
        run_root = (config_path.parent / run_root).resolve()
    project_dir = run_root / story["title"].lower().replace(" ", "_")
    project_dir.mkdir(parents=True, exist_ok=True)
    state_path = project_dir / "project_state.json"

    llm = MultimodalLLM(cfg["llm"])
    director = Director(llm, {**story, "clip_seconds": cfg.get("clip_seconds", 8)})
    reviewer = ContinuityReviewer(
        llm,
        cfg.get("review_thresholds", {}),
        sample_rate=float(cfg.get("frames_per_review_second", 1)),
    )
    comfy = ComfyClient(cfg["comfy_base_url"], workflow_path, cfg["workflow_bindings"])

    if args.resume and state_path.exists():
        state = ProjectState.model_validate_json(state_path.read_text(encoding="utf-8"))
    else:
        story_bible, beats = director.plan_story()
        state = ProjectState(
            title=story["title"],
            story_bible=story_bible,
            beats=beats,
            target_seconds=float(story["target_minutes"]) * 60.0,
        )
        save_state(state_path, state)

    refs = []
    for ref in flatten_refs(story):
        refs.append(ref if ref.is_absolute() else (base_dir / ref).resolve())

    max_retries = int(cfg.get("max_retries", 3))

    while state.elapsed_seconds < state.target_seconds:
        if state.current_beat_index >= len(state.beats):
            print("No more planned beats. Stopping before target runtime.")
            break

        if state.current_scene is None:
            state.current_scene = director.plan_scene(state)
            save_state(state_path, state)

        correction = ""
        accepted = False

        for attempt in range(1, max_retries + 1):
            clip = director.plan_clip(state, correction)
            clip_dir = project_dir / "clips" / clip.id / f"attempt_{attempt:02d}"
            clip_dir.mkdir(parents=True, exist_ok=True)
            (clip_dir / "clip_plan.json").write_text(clip.model_dump_json(indent=2), encoding="utf-8")

            prefix = f"scene_maker/{clip.id}_a{attempt:02d}"
            workflow = comfy.build_prompt(
                prompt=clip.prompt,
                seed=int(clip.seed or 1),
                output_prefix=prefix,
            )
            prompt_id = comfy.queue(workflow)
            history = comfy.wait(prompt_id)
            relative_video = comfy.first_video_output(history)

            # In a same-machine Colab setup, Comfy outputs are under ComfyUI/output.
            comfy_root = Path(cfg.get("comfy_output_root", "/content/ComfyUI/output"))
            generated_video = comfy_root / relative_video
            if not generated_video.exists():
                raise FileNotFoundError(
                    f"Generated video not found at {generated_video}. Set comfy_output_root in config.json."
                )

            local_video = clip_dir / generated_video.name
            shutil.copy2(generated_video, local_video)

            previous_video = state.accepted_clips[-1].video_path if state.accepted_clips else None
            review = reviewer.review(
                state=state,
                clip=clip,
                video_path=local_video,
                work_dir=clip_dir / "review",
                reference_images=refs,
                previous_video=previous_video,
            )
            (clip_dir / "review.json").write_text(review.model_dump_json(indent=2), encoding="utf-8")

            if review.accept:
                accepted_video = project_dir / "accepted" / f"{clip.id}.mp4"
                accepted_video.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(local_video, accepted_video)

                state.continuity = review.observed_end_state
                state.accepted_clips.append(
                    AcceptedClip(
                        clip_id=clip.id,
                        scene_id=clip.scene_id,
                        video_path=str(accepted_video),
                        prompt=clip.prompt,
                        review=review,
                        continuity_after=state.continuity,
                    )
                )
                state.elapsed_seconds += float(clip.duration_seconds)
                save_state(state_path, state)
                print(f"ACCEPTED {clip.id} | total {state.elapsed_seconds:.1f}/{state.target_seconds:.1f}s")
                accepted = True
                break

            correction = review.correction_prompt
            print(f"RETRY {clip.id} attempt {attempt}: {review.problems}")

        if not accepted:
            print("Paused: retry limit reached. Inspect the latest review and resume after adjustment.")
            save_state(state_path, state)
            break

        # MVP scene boundary: when accumulated accepted time reaches the scene target,
        # close it and let the director plan the next scene from the actual continuity state.
        scene_clip_seconds = sum(
            x.review.scores.prompt_fulfillment * 0 + float(cfg.get("clip_seconds", 8))
            for x in state.accepted_clips
            if x.scene_id == state.current_scene.id
        )
        if scene_clip_seconds >= state.current_scene.target_seconds:
            state.current_scene = None
            beat = state.beats[state.current_beat_index]
            if state.elapsed_seconds >= beat.end_seconds:
                state.current_beat_index += 1
            save_state(state_path, state)


if __name__ == "__main__":
    main()
