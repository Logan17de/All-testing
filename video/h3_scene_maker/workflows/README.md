# ComfyUI workflow adapter

Place the **API-format** export of the working MiniMax H3 workflow here as:

```text
h3_api.json
```

In ComfyUI enable developer options if needed, then use **Save (API Format)**.

The Scene Maker does not depend on hard-coded H3 node internals. Instead `config.json` maps the API workflow inputs that the director must change for each generated clip:

```json
"workflow_bindings": {
  "prompt": {"node_id": "123", "input": "text"},
  "seed": {"node_id": "456", "input": "seed"},
  "output_prefix": {"node_id": "789", "input": "filename_prefix"}
}
```

For the first MVP, export a workflow that produces **one H3 clip per API call**. The Scene Maker itself provides the long-form loop, review, retry, checkpoints and story memory.

Later adapters can target:

- H3 Extender motion-context continuation
- H3 Multishot / context pinning
- first/last-frame continuation
- separate upscaling / interpolation passes

The orchestration layer should remain unchanged when the rendering graph changes.
