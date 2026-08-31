# Harness Desktop Theme Pack

Eight theme presets based on the supplied Harness Desktop concepts:

- Deep Ocean
- Midnight Purple
- Carbon Green
- Amber Night
- Ocean Blue
- Forest Green
- Purple Twilight
- Warm Sand

The plugin itself does not patch application files. It contributes a bounded `themes.json` palette from Harness Desktop managed plugin storage. Harness Desktop's generic theme loader discovers active UI plugins, validates the supported color variables, and exposes them in **Settings → Appearance**.

Theme selection is local to Harness Desktop and survives restarts. If this plugin is disabled while one of its themes is selected, Harness Desktop falls back to its built-in Control Room theme.
