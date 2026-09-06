from __future__ import annotations

import json
from pathlib import Path

from frame_sampler import sample_video, seam_frames
from llm_client import MultimodalLLM
from models import ClipPlan, ClipReview, ProjectState
from prompts import REVIEWER_SYSTEM


class ContinuityReviewer:
    def __init__(self, llm: MultimodalLLM, thresholds: dict, sample_rate: float = 1.0):
        self.llm = llm
        self.thresholds = thresholds
        self.sample_rate = sample_rate

    def review(
        self,
        *,
        state: ProjectState,
        clip: ClipPlan,
        video_path: str | Path,
        work_dir: str | Path,
        reference_images: list[str | Path],
        previous_video: str | Path | None = None,
    ) -> ClipReview:
        work_dir = Path(work_dir)
        current_frames = sample_video(video_path, work_dir / "sampled", self.sample_rate)
        current_seams = seam_frames(video_path, work_dir / "current_seams")
        previous_seams: list[Path] = []
        if previous_video:
            previous_seams = seam_frames(previous_video, work_dir / "previous_seams")

        images = [Path(x) for x in reference_images if Path(x).exists()]
        # Reference images first, then previous seam, then sampled current clip.
        images += previous_seams
        images += current_seams
        images += current_frames

        schema = {
            "accept": False,
            "scores": {
                "identity": 0.0,
                "wardrobe_props": 0.0,
                "environment": 0.0,
                "camera_spatial": 0.0,
                "action_continuity": 0.0,
                "seam_continuity": 0.0,
                "prompt_fulfillment": 0.0
            },
            "critical_error": None,
            "problems": [],
            "correction_prompt": "",
            "observed_end_state": state.continuity.model_dump()
        }

        data = self.llm.json_call(
            system=REVIEWER_SYSTEM,
            user_text=(
                "Review this generated clip for continuity. Image order is: reference images, previous seam frames if any, "
                "current first/last seam frames, then current clip sampled at one frame per second.\n\n"
                f"Clip intent: {clip.model_dump_json()}\n"
                f"Canonical pre-clip state: {state.continuity.model_dump_json()}\n"
                f"Thresholds: {json.dumps(self.thresholds)}\n"
                f"Return JSON shaped like: {json.dumps(schema)}"
            ),
            images=images,
            temperature=0.1,
        )
        review = ClipReview.model_validate(data)

        # Deterministic acceptance gate: do not trust a model-provided boolean alone.
        t_identity = float(self.thresholds.get("identity", 0.88))
        t_seam = float(self.thresholds.get("seam_continuity", 0.80))
        t_avg = float(self.thresholds.get("average", 0.82))
        review.accept = bool(
            not review.critical_error
            and review.scores.identity >= t_identity
            and review.scores.seam_continuity >= t_seam
            and review.scores.average() >= t_avg
        )
        return review
