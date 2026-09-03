# Workflows

The actual H3 Extender workflow is intentionally **not vendored** here.

`prepare_workflow.py` takes the workflow from the currently installed upstream H3 Extender node and writes:

```text
ComfyUI/user/default/workflows/MiniMax_H3_Extender_Colab.json
```

It also normalizes the model selectors to the official model profile downloaded by `download_models.py`.

This keeps the Colab setup aligned with the installed Extender version instead of freezing an old workflow JSON in this repository.
