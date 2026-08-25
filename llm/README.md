# Qwen 3.8 27B on Google Colab → DeepSeek Harness

This directory contains a working architecture for running **Qwen 3.8 27B** on a Google Colab GPU and using it from **DeepSeek Harness on Windows** as an OpenAI-compatible model provider.

The key design decision is that **Google Colab is never exposed as a public inbound API server**. Instead, Colab behaves as an outbound worker, Supabase acts as the relay, and a lightweight bridge on Windows exposes a local OpenAI-compatible endpoint to Harness.

---

## 1. Goal

The system should allow DeepSeek Harness to use Qwen as if it were a normal local/OpenAI-compatible provider:

```text
DeepSeek Harness
      ↓
http://127.0.0.1:8787/v1
      ↓
Windows Qwen bridge
      ↓
Supabase relay
      ↓
Google Colab worker
      ↓
vLLM
      ↓
Qwen 3.8 27B on A100
```

Harness does not need to know that the actual model is running inside Colab.

---

## 2. Final Architecture

```text
┌──────────────────────── Windows PC ────────────────────────┐
│                                                            │
│  DeepSeek Harness                                          │
│         │                                                  │
│         │ OpenAI-compatible HTTP/SSE                       │
│         ▼                                                  │
│  http://127.0.0.1:8787/v1                                 │
│         │                                                  │
│  Qwen Harness Bridge                                       │
│         │                                                  │
└─────────┼──────────────────────────────────────────────────┘
          │
          │ HTTPS outbound
          ▼
┌────────────────────────────────────────────────────────────┐
│                  Supabase / Growing-Trader                 │
│                                                            │
│  qwen_relay_jobs                                           │
│  qwen_relay_chunks                                         │
│  qwen_relay_workers                                        │
│  isolated SECURITY DEFINER RPC functions                   │
│                                                            │
└─────────┬──────────────────────────────────────────────────┘
          ▲
          │ HTTPS outbound
          │
┌─────────┼────────────── Google Colab ──────────────────────┐
│         │                                                  │
│   Qwen Relay Worker                                        │
│         │                                                  │
│         ▼                                                  │
│   vLLM                                                     │
│   http://127.0.0.1:8000/v1                                │
│         │                                                  │
│         ▼                                                  │
│   Qwen 3.8 27B                                             │
│   A100 GPU                                                 │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

The important property is:

> **The GPU machine never needs to accept an inbound Internet connection.**

Both Windows and Colab communicate outward to Supabase.

---

## 3. Why This Architecture Exists

The initial idea was to expose vLLM directly from Colab through a public tunnel:

```text
Harness → public tunnel → Colab → vLLM → Qwen
```

This was abandoned because public reverse-tunnel solutions added too many failure modes:

- Cloudflare Quick Tunnel was not a good fit for the required streaming path.
- `localhost.run` could allocate public hostnames, but its edge repeatedly returned `503` instead of reaching the Colab backend.
- ngrok would add another external account/token dependency.
- A public tunnel also makes every Colab session depend on a temporary public endpoint.

The final design therefore reverses the connection direction:

```text
Instead of:
Internet → Colab

Use:
Colab → Internet
```

Colab is a worker, not a public server.

---

## 4. Components

### 4.1 DeepSeek Harness

Harness is the agent/coding environment.

It expects an OpenAI-compatible model provider, so it is configured to use the local Windows bridge:

```text
Provider:        qwen
Protocol:        openai-completions
Base URL:        http://127.0.0.1:8787/v1
Model ID:        qwen3.8-27b
Context Window:  262144
```

Harness uses endpoints such as:

```text
GET  /v1/models
POST /v1/chat/completions
```

Harness never talks directly to Supabase or Colab.

---

### 4.2 Windows Harness Bridge

File:

```text
qwen_harness_bridge.py
```

The bridge runs on the same Windows machine as Harness and listens only on:

```text
127.0.0.1:8787
```

It exposes an OpenAI-compatible API to Harness.

Its responsibilities are:

1. Accept model requests from Harness.
2. Create a Supabase relay job.
3. Poll response chunks from Supabase.
4. Convert those chunks back to OpenAI-compatible SSE.
5. Return the stream to Harness.

Harness therefore sees a normal API such as:

```text
http://127.0.0.1:8787/v1/chat/completions
```

while the actual inference happens remotely in Colab.

The bridge is bound to `127.0.0.1`, not `0.0.0.0`, so it is not exposed to the LAN or Internet.

---

### 4.3 Supabase Relay

The relay is installed in the existing **Growing-Trader** Supabase project.

Existing Growing-Trader application tables were not modified.

The relay uses isolated objects:

```text
qwen_relay_jobs
qwen_relay_chunks
qwen_relay_workers
```

The relay handles:

- request queueing,
- atomic worker job claiming,
- worker heartbeat/availability,
- response chunk transport,
- completion/error status,
- cleanup.

Supabase does **not** perform inference.

It acts as:

```text
request mailbox
+
worker coordination
+
response mailbox
```

---

## 5. Relay Security

The final relay does **not** require placing a Supabase `service_role` key on Windows or Colab.

Instead it uses:

```text
Supabase publishable key
+
dedicated Qwen relay secret
+
SECURITY DEFINER RPC functions
```

The powerful administrator/service-role credential stays inside Supabase.

The Python clients use only the dedicated Qwen RPC surface.

Required client-side secret:

```text
QWEN_RELAY_SECRET
```

The relay schema and RPCs are defined in:

```text
supabase_qwen_relay.sql
```

---

## 6. Colab Worker

Main real-worker file:

```text
qwen3_8_27b_supabase_colab.py
```

The Colab worker never exposes a public port.

Its local vLLM server runs at:

```text
http://127.0.0.1:8000/v1
```

The worker continuously:

1. Sends a heartbeat to Supabase.
2. Looks for queued jobs.
3. Atomically claims a job.
4. Sends the request to local vLLM.
5. Reads vLLM's streaming response.
6. Writes response chunks to Supabase.
7. Marks the job complete or failed.

Conceptually:

```text
Supabase
   ↓
Colab worker
   ↓
vLLM
   ↓
Qwen 3.8 27B
   ↓
vLLM streaming response
   ↓
Colab worker
   ↓
Supabase chunks
```

---

## 7. Qwen / vLLM Runtime

The A100 80 GB path is configured around:

```text
Model:          Qwen/Qwen3.8-27B
Weights:        BF16
Context target: 262,144 tokens
KV cache:       FP8
Prefix caching: enabled
Serving:        vLLM OpenAI-compatible API
```

The vLLM endpoint is private to the Colab runtime.

The current launcher also supports a lower-memory fallback path using the official FP8 checkpoint for smaller GPUs.

---

## 8. Full Request Lifecycle

Suppose the user asks Harness:

```text
Explain how attention works.
```

The request path is:

```text
1. User
   ↓
2. DeepSeek Harness
   ↓ POST /v1/chat/completions
3. Windows bridge
   ↓ create relay job
4. Supabase
   ↓ queued job
5. Colab worker
   ↓ claim job
6. Local vLLM
   ↓
7. Qwen 3.8 27B on A100
```

The response travels back in the opposite direction:

```text
Qwen generation
   ↓
vLLM SSE
   ↓
Colab worker
   ↓
Supabase response chunks
   ↓
Windows bridge
   ↓
OpenAI-compatible SSE
   ↓
DeepSeek Harness
   ↓
User
```

---

## 9. Streaming

Harness expects OpenAI-style Server-Sent Events.

Typical output looks like:

```text
data: {"choices":[{"delta":{"content":"The"}}]}

data: {"choices":[{"delta":{"content":" attention"}}]}

data: {"choices":[{"delta":{"content":" mechanism"}}]}

...

data: [DONE]
```

The Windows bridge recreates this stream from Supabase relay chunks.

Therefore Harness behaves as if it were connected directly to a normal OpenAI-compatible inference server.

---

## 10. No-GPU Integration Test

Before loading Qwen on an A100, the notebook includes a dedicated **Section 3 test worker**.

File:

```text
qwen_relay_test_colab.py
```

This mode does not use:

```text
Qwen
vLLM
Torch/CUDA inference
model weights
GPU
```

Instead every valid Harness request returns exactly:

```text
succeed
```

The test path is:

```text
Harness
   ↓
Windows bridge
   ↓
Supabase
   ↓
Colab test worker
   ↓
"succeed"
   ↑
Supabase
   ↑
Windows bridge
   ↑
Harness
```

If Harness displays `succeed`, the full transport architecture is proven.

That validates:

```text
Harness request creation               ✅
Harness → localhost bridge             ✅
Windows bridge                         ✅
Windows → Supabase                     ✅
Supabase RPC authentication            ✅
Supabase job queue                     ✅
Colab outbound connectivity            ✅
Colab worker                           ✅
Colab → Supabase response              ✅
Supabase → Windows response            ✅
Windows SSE translation                ✅
Harness response rendering             ✅
```

After this passes, failures in the real worker can be isolated to the GPU/model layer rather than networking.

---

## 11. Important Harness Authentication Fix

A major issue occurred where:

```text
Fetch available models → worked
Actual chat request     → AUTH failure
```

The problem was not the bridge or relay.

The problematic provider configuration contained:

```yaml
apiKeyEnv: QWEN_API_KEY
```

For this custom pi-ai provider, that forced Harness's real chat path to resolve a separate credential reference named `QWEN_API_KEY` instead of using the credential stored directly for the `qwen` provider.

The fix was to **remove `apiKeyEnv` entirely** and let Harness use its stored provider credential.

Correct provider configuration:

```yaml
agent-default-model:
  provider: qwen
  model: qwen3.8-27b
  reasoningEffort: low

llm-pi-ai:
  providers:
    qwen:
      displayName: Qwen
      api: openai-completions
      baseURL: http://127.0.0.1:8787/v1
      models:
        - id: qwen3.8-27b
          name: Qwen
          contextWindow: 262144
          maxTokens: 8192
```

Do **not** add:

```yaml
apiKeyEnv: QWEN_API_KEY
```

The API key can be entered in Harness's Models UI for the `qwen` provider.

For the localhost bridge, a dummy value such as:

```text
local-qwen
```

is sufficient because the bridge itself is restricted to `127.0.0.1` and does not treat the Harness bearer value as a remote security boundary.

---

## 12. Colab Notebook Structure

Notebook:

```text
Qwen3_8_27B_API_Colab.ipynb
```

The notebook intentionally contains three sections.

### Section 1 — Install / Update

Pulls the latest implementation from GitHub and installs the `llm` package.

Run this at the beginning of every Colab session.

### Section 2 — Real Qwen Worker

Starts the production path:

```text
relay preflight
   ↓
runtime verification
   ↓
GPU detection
   ↓
model preparation
   ↓
vLLM
   ↓
Qwen worker
   ↓
wait for Harness jobs
```

Use this for real inference.

### Section 3 — No-GPU Test Worker

Starts the fake worker that returns:

```text
succeed
```

Use this only for debugging the relay/API architecture.

Do not run Section 2 and Section 3 at the same time for normal use.

---

## 13. Normal Startup Procedure

Once the initial setup has been completed, the normal workflow is short.

### Google Colab

1. Open the Qwen Colab notebook.
2. Select an **A100 GPU** runtime.
3. Run **Section 1**.
4. Run **Section 2**.
5. Wait until the worker reports that it is ready and waiting for Harness jobs.
6. Keep the Colab runtime alive.

Do **not** run Section 3 during normal Qwen usage.

### Windows

Start the local bridge.

If the repository is already cloned:

```powershell
powershell -ExecutionPolicy Bypass -File .\llm\Start-QwenHarnessBridge.ps1
```

The bridge must remain running while Harness is using Qwen.

It exposes:

```text
http://127.0.0.1:8787/v1
```

### DeepSeek Harness

Open Harness and use the already configured Qwen provider.

You should not need to recreate:

- Supabase schema,
- relay configuration,
- model entry,
- provider configuration,
- Base URL.

The Base URL remains stable because it is localhost, not a temporary Colab tunnel URL.

---

## 14. Testing Procedure

If the real setup is not working and you need to isolate the problem:

### Step 1 — Use CPU Colab

No GPU is necessary.

### Step 2 — Run

```text
Section 1
Section 3
```

### Step 3 — Start Windows bridge

Keep the bridge open.

### Step 4 — Send any Harness message

Example:

```text
hello
```

Expected response:

```text
succeed
```

If `succeed` appears, the transport plane is working and the remaining problem is in the real model/vLLM/GPU path.

---

## 15. Failure Isolation

| Symptom | Most likely layer |
|---|---|
| Harness cannot fetch models | Windows bridge |
| Model fetch works but chat reports AUTH before POST | Harness credential configuration |
| Test worker never receives jobs | Windows/Supabase relay |
| Test worker receives a job but Harness gets no response | response/chunk relay |
| Section 3 works but Section 2 fails | Qwen/vLLM/GPU |
| Colab worker reports offline | Colab runtime / relay heartbeat |
| Local `/v1/models` fails in Colab | vLLM |
| CUDA OOM | model/context/KV cache configuration |
| Large prompt fails | context capacity / vLLM / VRAM |
| Harness stops receiving streamed output | Windows SSE bridge / relay chunks |

The Section 3 test is the fastest way to distinguish networking/integration problems from inference problems.

---

## 16. Persistent vs Session Components

### Persistent configuration

These normally only need to be created/configured once:

```text
Growing-Trader Supabase relay schema
Supabase relay RPC functions
QWEN_RELAY_SECRET
Harness Qwen provider
Windows bridge code
GitHub repository
```

### Must be running each session

```text
Google Colab runtime
Colab Qwen worker
Windows bridge
DeepSeek Harness
```

If Colab disconnects, Harness and the Windows bridge may still be running, but there will be no active inference worker.

---

## 17. Repository Files

Important files in this directory:

```text
llm/
├── Qwen3_8_27B_API_Colab.ipynb
├── qwen3_8_27b_supabase_colab.py
├── qwen3_8_27b_api_colab.py
├── qwen_relay_test_colab.py
├── qwen_harness_bridge.py
├── qwen_supabase_relay.py
├── supabase_qwen_relay.sql
├── Start-QwenHarnessBridge.ps1
├── pyproject.toml
└── README.md
```

### File roles

#### `Qwen3_8_27B_API_Colab.ipynb`
Main Colab interface with install, real worker, and no-GPU testing sections.

#### `qwen3_8_27b_supabase_colab.py`
Production Colab worker that loads/uses Qwen through local vLLM.

#### `qwen3_8_27b_api_colab.py`
Compatibility entrypoint that forwards to the Supabase worker architecture. The old public-tunnel implementation has been retired.

#### `qwen_relay_test_colab.py`
CPU-only relay test worker. Every request returns `succeed`.

#### `qwen_harness_bridge.py`
Windows OpenAI-compatible local API used by Harness.

#### `qwen_supabase_relay.py`
Shared Python relay client used by the Windows bridge and Colab workers.

#### `supabase_qwen_relay.sql`
Supabase relay schema/RPC migration.

#### `Start-QwenHarnessBridge.ps1`
Convenience launcher for the Windows bridge.

#### `pyproject.toml`
Python package configuration and dependencies.

---

## 18. Three-Plane Mental Model

The easiest way to reason about the system is to split it into three planes.

### Agent Plane

```text
DeepSeek Harness
```

Responsible for:

- agent behavior,
- conversation state,
- tools,
- context management,
- LLM requests.

### Transport Plane

```text
Windows bridge
+
Supabase relay
```

Responsible for:

- OpenAI API compatibility,
- request transport,
- worker coordination,
- response streaming.

### Compute Plane

```text
Google Colab
+
vLLM
+
Qwen
+
A100
```

Responsible for:

- tokenization,
- prefill,
- attention,
- KV cache,
- sampling,
- generation.

Diagram:

```text
                    AGENT PLANE
               ┌─────────────────┐
               │ DeepSeek Harness│
               └────────┬────────┘
                        │
                        │ OpenAI API
                        ▼

                   TRANSPORT PLANE
             ┌──────────────────────┐
             │ Windows Local Bridge │
             │   127.0.0.1:8787    │
             └──────────┬───────────┘
                        │
                        │ HTTPS
                        ▼
             ┌──────────────────────┐
             │ Growing-Trader       │
             │ Supabase             │
             │                      │
             │ qwen_relay_jobs      │
             │ qwen_relay_chunks    │
             │ qwen_relay_workers   │
             │ relay RPC auth       │
             └──────────┬───────────┘
                        │
                        │ HTTPS
                        ▼

                    COMPUTE PLANE
             ┌──────────────────────┐
             │ Google Colab         │
             │                      │
             │ Qwen Relay Worker    │
             │        ↓             │
             │ vLLM :8000           │
             │        ↓             │
             │ Qwen 3.8 27B         │
             │        ↓             │
             │ A100 80 GB           │
             └──────────────────────┘
```

---

## 19. Extending the Architecture

The relay is not fundamentally tied to Qwen.

A future worker could expose additional models such as:

```text
Qwen
Llama
DeepSeek
GLM
Mistral
Gemma
fine-tuned models
research models
```

The bridge could advertise multiple IDs from `/v1/models`, and each relay job could specify which backend should process it.

This makes the architecture a reusable remote-inference layer for Harness rather than a one-off tunnel replacement.

---

## 20. Future Optimization

The current architecture prioritizes reliability and debug isolation over minimum possible latency.

Current path:

```text
Harness
→ Windows bridge
→ Supabase
→ Colab
→ vLLM
→ Qwen
```

This introduces some relay overhead.

For long model generations or large-context prefill, inference time will usually dominate this transport overhead.

If the model later moves from Colab to a permanent GPU VM, the transport architecture can be simplified to:

```text
Harness
   ↓
HTTPS
   ↓
GPU VM
   ↓
vLLM
```

The Harness-facing OpenAI-compatible contract can remain the same.

---

## 21. Quick Reference

### Normal use

```text
Colab:
Section 1 → Section 2

Windows:
Start-QwenHarnessBridge.ps1

Harness:
Open Qwen provider and chat
```

### Debug relay/API only

```text
Colab CPU runtime:
Section 1 → Section 3

Windows:
Start bridge

Harness:
send "hello"

Expected:
succeed
```

### Harness Base URL

```text
http://127.0.0.1:8787/v1
```

### Harness model

```text
qwen3.8-27b
```

### Harness protocol

```text
openai-completions
```

### Context window

```text
262144
```

### Important Harness config rule

Do **not** add:

```yaml
apiKeyEnv: QWEN_API_KEY
```

for this custom provider setup.

---

## Status

The no-GPU integration path has been successfully validated end-to-end:

```text
Harness → Windows → Supabase → Colab → Supabase → Windows → Harness ✅
```

The test worker returned:

```text
succeed
```

This proves the transport plane is operational. The real inference path uses the same relay architecture and replaces only the fake test worker with the Qwen/vLLM worker.
