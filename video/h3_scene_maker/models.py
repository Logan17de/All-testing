from __future__ import annotations

from typing import Dict, List, Optional
from pydantic import BaseModel, Field


class CharacterState(BaseModel):
    wardrobe: str = ""
    hair: str = ""
    carrying: List[str] = Field(default_factory=list)
    screen_position: str = ""
    notes: List[str] = Field(default_factory=list)


class CameraState(BaseModel):
    side: str = ""
    height: str = ""
    lens_feel: str = ""
    movement: str = ""


class ContinuityState(BaseModel):
    characters: Dict[str, CharacterState] = Field(default_factory=dict)
    location: str = ""
    time: str = ""
    weather: str = ""
    camera: CameraState = Field(default_factory=CameraState)
    action_state: str = ""
    dialogue_state: str = ""
    props: Dict[str, str] = Field(default_factory=dict)


class StoryBeat(BaseModel):
    id: str
    start_seconds: float
    end_seconds: float
    summary: str
    purpose: str = ""


class ScenePlan(BaseModel):
    id: str
    beat_id: str
    target_seconds: float
    summary: str
    location: str = ""
    start_state: ContinuityState = Field(default_factory=ContinuityState)
    end_goal: str = ""


class ClipPlan(BaseModel):
    id: str
    scene_id: str
    duration_seconds: float = 8.0
    prompt: str
    expected_end_state: ContinuityState = Field(default_factory=ContinuityState)
    seed: Optional[int] = None


class ReviewScores(BaseModel):
    identity: float = 0.0
    wardrobe_props: float = 0.0
    environment: float = 0.0
    camera_spatial: float = 0.0
    action_continuity: float = 0.0
    seam_continuity: float = 0.0
    prompt_fulfillment: float = 0.0

    def average(self) -> float:
        values = list(self.model_dump().values())
        return sum(values) / len(values) if values else 0.0


class ClipReview(BaseModel):
    accept: bool = False
    scores: ReviewScores = Field(default_factory=ReviewScores)
    critical_error: Optional[str] = None
    problems: List[str] = Field(default_factory=list)
    correction_prompt: str = ""
    observed_end_state: ContinuityState = Field(default_factory=ContinuityState)


class AcceptedClip(BaseModel):
    clip_id: str
    scene_id: str
    video_path: str
    prompt: str
    review: ClipReview
    continuity_after: ContinuityState


class ProjectState(BaseModel):
    version: int = 1
    title: str = ""
    story_bible: str = ""
    beats: List[StoryBeat] = Field(default_factory=list)
    current_beat_index: int = 0
    current_scene: Optional[ScenePlan] = None
    continuity: ContinuityState = Field(default_factory=ContinuityState)
    accepted_clips: List[AcceptedClip] = Field(default_factory=list)
    elapsed_seconds: float = 0.0
    target_seconds: float = 0.0
