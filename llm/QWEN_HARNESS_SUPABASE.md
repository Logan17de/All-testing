# Qwen3.8-27B Colab → DeepSeek Harness (outbound-only)

This replaces all public Colab tunnels. Colab runs vLLM privately on `127.0.0.1:8000` and exchanges jobs with a local Windows bridge through Supabase over ordinary outbound HTTPS.

## 1. Supabase (one time)

Use a dedicated/test Supabase project and apply `supabase_qwen_relay.sql` as a migration.

Get the project URL and a server-side **Secret key** (`sb_secret_...`) from Supabase. Do not use the publishable/anon key for this relay and do not commit the secret.

## 2. Colab Secrets

Add and enable notebook access for:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- optional `QWEN_RELAY_ID` (default `qwen3-8-27b`)

Then open `Qwen3_8_27B_API_Colab.ipynb` and Run all. The cell stays running as the worker. No public URL is created.

## 3. Windows bridge

Install from GitHub:

```powershell
py -m pip install --upgrade "git+https://github.com/Logan17de/All-testing.git#subdirectory=llm"
```

Create a `.env` based on `.env.example` with the same `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `QWEN_RELAY_ID`, then start:

```powershell
qwen-harness-bridge
```

The bridge listens only on Windows localhost:

- Base URL: `http://127.0.0.1:8787/v1`
- API key: `local-qwen` (or `QWEN_BRIDGE_API_KEY` if changed)
- Model: `qwen3.8-27b`
- Context window: `262144`

## 4. DeepSeek Harness

Create/update the custom provider:

- Provider ID: `qwen`
- Base URL: `http://127.0.0.1:8787/v1`
- API protocol: `openai-completions`
- API key: `local-qwen`
- Model ID: `qwen3.8-27b`
- Display name: `Qwen 3.8 27B`
- Context window: `262144`

`Fetch available models` now calls the local bridge, not Colab.

## Data flow

```text
DeepSeek Harness
    ↕ localhost HTTP/SSE
Windows qwen-harness-bridge
    ↕ outbound Supabase HTTPS
Supabase jobs + private Storage + response chunks
    ↕ outbound Supabase HTTPS
Colab worker
    ↕ localhost HTTP/SSE
vLLM / Qwen3.8-27B
```

Large Harness requests are gzip-compressed in private Supabase Storage rather than placed directly in queue rows. vLLM SSE events are batched into small database chunks and replayed by the local bridge as OpenAI-compatible SSE.
