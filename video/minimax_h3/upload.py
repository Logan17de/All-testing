#!/usr/bin/env python3
from pathlib import Path

OUT = Path("/content/minimax_h3/inputs")
OUT.mkdir(parents=True, exist_ok=True)

try:
    from google.colab import files
except ImportError as exc:
    raise SystemExit("This uploader is intended for Google Colab.") from exc

print("Choose any H3 inputs: images, MP4 videos, WAV/MP3 audio, etc.")
uploaded = files.upload()
for name, data in uploaded.items():
    dest = OUT / Path(name).name
    dest.write_bytes(data)
    print(f"Saved: {dest}")
