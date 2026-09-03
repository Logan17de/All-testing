#!/usr/bin/env python3
"""Patch H3 Extender's Nodes 2.0 DOM timeline so it stretches to full node width.

Upstream intentionally uses fixed 318 px clip cards inside a horizontal scroller.
On some current ComfyUI Nodes 2.0 builds the DOM-widget host can collapse to one
card width after Add/Remove Clip, leaving a large unused black area in the node.
This patch only fixes the host/timeline width; it does not change H3 generation.
"""

from pathlib import Path
import sys

MARKER = "H3_COLAB_FULL_WIDTH_PATCH_V1"


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "/content/ComfyUI/custom_nodes/ComfyUI_MiniMax_H3_Extender/web/extender.js")
    if not path.exists():
        raise SystemExit(f"Extender frontend not found: {path}")

    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        print("H3 Extender full-width UI patch already applied.")
        return

    needle = """function render(node, runtime) {\n    const { state, cards, counter, status } = runtime;\n    cards.replaceChildren();\n"""
    replacement = f"""function render(node, runtime) {{\n    const {{ state, cards, counter, status }} = runtime;\n\n    // {MARKER}\n    // ComfyUI Nodes 2.0 can recompute a DOM-widget wrapper to its intrinsic\n    // content width after the clip list changes. Keep the Extender timeline\n    // stretched across the actual node while preserving fixed-width cards.\n    const timelineRoot = runtime.root;\n    const timelineHost = timelineRoot?.parentElement;\n    if (timelineHost) {{\n        timelineHost.style.width = \"100%\";\n        timelineHost.style.maxWidth = \"100%\";\n        timelineHost.style.minWidth = \"0\";\n        timelineHost.style.justifySelf = \"stretch\";\n        timelineHost.style.alignSelf = \"stretch\";\n        timelineHost.style.boxSizing = \"border-box\";\n    }}\n    if (timelineRoot) {{\n        timelineRoot.style.width = \"100%\";\n        timelineRoot.style.maxWidth = \"100%\";\n        timelineRoot.style.minWidth = \"0\";\n        timelineRoot.style.boxSizing = \"border-box\";\n    }}\n    cards.style.width = \"100%\";\n    cards.style.maxWidth = \"100%\";\n    cards.style.minWidth = \"0\";\n\n    cards.replaceChildren();\n"""

    if needle not in text:
        raise SystemExit("Upstream extender.js changed: render() anchor not found; refusing a blind patch.")

    backup = path.with_suffix(path.suffix + ".pre-colab-width-patch")
    if not backup.exists():
        backup.write_text(text, encoding="utf-8")

    path.write_text(text.replace(needle, replacement, 1), encoding="utf-8")
    print(f"Patched H3 Extender timeline width: {path}")
    print("Restart ComfyUI and hard-refresh the browser tab to load the patched JS.")


if __name__ == "__main__":
    main()
