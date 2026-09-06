from __future__ import annotations

from pathlib import Path
import cv2


def sample_video(video_path: str | Path, out_dir: str | Path, fps_sample: float = 1.0) -> list[Path]:
    video_path = Path(video_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(video_path))
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frame_count / src_fps if src_fps else 0.0

    paths: list[Path] = []
    t = 0.0
    index = 0
    while t <= max(0.0, duration - 1e-3):
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        if not ok:
            break
        p = out_dir / f"t_{index:04d}_{t:07.2f}s.jpg"
        cv2.imwrite(str(p), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        paths.append(p)
        index += 1
        t += 1.0 / max(0.01, fps_sample)

    cap.release()
    return paths


def seam_frames(video_path: str | Path, out_dir: str | Path) -> list[Path]:
    video_path = Path(video_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(video_path))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    result: list[Path] = []
    for name, idx in [("first", 0), ("last", max(0, total - 1))]:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if ok:
            p = out_dir / f"{name}.jpg"
            cv2.imwrite(str(p), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 94])
            result.append(p)
    cap.release()
    return result
