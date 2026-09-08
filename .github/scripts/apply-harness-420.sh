set -euo pipefail

# Reuse the original 4.20 payload, then inject the small type-only correction
# discovered by the first verification run before executing it.
git show 404d581b7de8ccfbab1a18b84169689d3b50482c:.github/scripts/apply-harness-420.sh > /tmp/apply-harness-420-base.sh
python - <<'PY'
from pathlib import Path

path = Path('/tmp/apply-harness-420-base.sh')
text = path.read_text()
anchor = 'npm run typecheck\n'
fix = '''python - <<'PYFIX'\nfrom pathlib import Path\n\npath = Path("apps/runtime/src/runtime-fault-injection.test.ts")\ntext = path.read_text()\ntext = text.replace(\n    "readonly readyQueue: readonly Readonly<Record<string, unknown>>[];",\n    'readonly readyQueue: ReturnType<typeof reconstructExecutionFrontier>["readyQueue"];',\n)\ntext = text.replace(\n    "readonly classifications: readonly Readonly<Record<string, unknown>>[];",\n    "readonly classifications: ReturnType<typeof classifyPreCrashRunningAttempts>;",\n)\npath.write_text(text)\nPYFIX\n'''
if anchor not in text:
    raise SystemExit('4.20 base helper typecheck anchor not found')
path.write_text(text.replace(anchor, fix + anchor, 1))
PY
bash /tmp/apply-harness-420-base.sh
