from __future__ import annotations

import json
import random
from pathlib import Path

from llm_client import MultimodalLLM
from models import ClipPlan, ProjectState, ScenePlan, StoryBeat
from prompts import DIRECTOR_SYSTEM


class Director:
    def __init__(self, llm: MultimodalLLM, story: dict):
        self.llm = llm
        self.story = story

    def plan_story(self) -> tuple[str, list[StoryBeat]]:
        schema = {
            "story_bible": "compact canonical story/character/style rules",
            "beats": [
                {
                    "id": "beat_001",
                    "start_seconds": 0,
                    "end_seconds": 240,
                    "summary": "...",
                    "purpose": "..."
                }
            ]
        }
        data = self.llm.json_call(
            system=DIRECTOR_SYSTEM,
            user_text=(
                "Create Level-0 story beats for this project. Preserve the user's story and ending. "
                f"Target runtime: {self.story['target_minutes']} minutes.\n\n"
                f"PROJECT:\n{json.dumps(self.story, ensure_ascii=False, indent=2)}\n\n"
                f"Return JSON shaped like:\n{json.dumps(schema, indent=2)}"
            ),
        )
        return str(data["story_bible"]), [StoryBeat.model_validate(x) for x in data["beats"]]

    def plan_scene(self, state: ProjectState) -> ScenePlan:
        beat = state.beats[state.current_beat_index]
        schema = {
            "id": "scene_001",
            "beat_id": beat.id,
            "target_seconds": 90,
            "summary": "...",
            "location": "...",
            "start_state": state.continuity.model_dump(),
            "end_goal": "..."
        }
        data = self.llm.json_call(
            system=DIRECTOR_SYSTEM,
            user_text=(
                "Expand only the current beat into the NEXT scene. Do not plan later scenes.\n"
                f"Story bible: {state.story_bible}\n"
                f"Current beat: {beat.model_dump_json()}\n"
                f"Accepted continuity: {state.continuity.model_dump_json()}\n"
                f"Remaining project seconds: {max(0, state.target_seconds-state.elapsed_seconds):.1f}\n"
                f"Return JSON shaped like: {json.dumps(schema)}"
            ),
        )
        return ScenePlan.model_validate(data)

    def plan_clip(self, state: ProjectState, correction: str = "") -> ClipPlan:
        if not state.current_scene:
            raise RuntimeError("No current scene")
        duration = min(10.0, max(5.0, float(self.story.get("clip_seconds", 8.0))))
        schema = {
            "id": f"clip_{len(state.accepted_clips)+1:05d}",
            "scene_id": state.current_scene.id,
            "duration_seconds": duration,
            "prompt": "H3 prompt with reference mappings and exact continuity instructions",
            "expected_end_state": state.continuity.model_dump(),
            "seed": 123456789
        }
        data = self.llm.json_call(
            system=DIRECTOR_SYSTEM,
            user_text=(
                "Write only the NEXT H3 clip.\n"
                f"Story bible: {state.story_bible}\n"
                f"Scene: {state.current_scene.model_dump_json()}\n"
                f"Canonical state before clip: {state.continuity.model_dump_json()}\n"
                f"Character/reference mapping: {json.dumps(self.story.get('characters', []), ensure_ascii=False)}\n"
                f"Environment refs: {json.dumps(self.story.get('environment_references', []), ensure_ascii=False)}\n"
                f"Hard rules: {json.dumps(self.story.get('hard_rules', []), ensure_ascii=False)}\n"
                f"Reviewer correction from prior attempt: {correction or 'none'}\n"
                f"Return JSON shaped like: {json.dumps(schema)}"
            ),
        )
        plan = ClipPlan.model_validate(data)
        if plan.seed is None:
            plan.seed = random.randint(1, (1 << 53) - 1)
        return plan
