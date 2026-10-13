# Installed Codex UI reference

Inspected on 2026-10-07 from the installed Windows package `OpenAI.Codex_26.930.4958.0_x64__2p2nqsd0c76g0`. Inspection covered packaged UI assets and a read-only capture of the running window. The installed application was not modified.

Install directory: `C:\Program Files\WindowsApps\OpenAI.Codex_26.930.4958.0_x64__2p2nqsd0c76g0\app`. The directory contains the `Codex.exe` launcher, `ChatGPT.exe` shell, and UI resources in `resources\app.asar`.

The asset paths below are entries within that archive.

## Typography and dimensions

| Element | Installed desktop value | Source |
| --- | --- | --- |
| Default UI font | `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | `webview/assets/app-shared-6fb15e58cd7f.css`, `--font-sans-default` |
| UI/body size | 14 px | Same asset, desktop `body` sets `--font-ui-size: var(--text-base)` |
| Small controls/navigation text | 13 px; extra-small text 12 px | Same asset, `[data-codex-window-type=electron]` overrides `--text-sm` and `--text-xs` |
| Spacing grid | 4 px | Same asset, `--spacing: .25rem` |
| Leading icon | 16 px | Same asset, `--icon-leading-size` |
| Small composer control | 28 px | Same asset, desktop `body` sets `--spacing-token-button-composer-sm` to seven spacing units |
| Titlebar / toolbar | 44 px / 46 px | Same asset, `--height-titlebar` / `--height-toolbar` |
| Thread/composer content width | 768 px (`48rem`) maximum | Same asset, desktop `body` sets `--thread-content-max-width` |
| Composer bottom inset | 16 px | Same asset, `--thread-composer-bottom-inset` |
| Default composer radius | 22 px, round corners | Same asset, final `--composer-radius` and `--composer-corner-shape` |
| Composer editor | 20 px line height; 44 px minimum height; 12 px inline input padding | Same asset, final root composer variables |
| Sidebar default width | 340 px total; clamp 240–520 px and viewport minus 240 px | `webview/assets/app-initial-146770bfc1f4.js`, `HIt`/`eC` and `sidebar-width` |

The live app capture reported by the main task shows a 52 px global rail plus 288 px navigation, consistent with the 340 px static default. OpenAI Sans font files are bundled, but the default UI stack above uses the Windows system font.

## Dark surfaces

These values resolve the native desktop defaults in `webview/assets/app-shared-6fb15e58cd7f.css`:

| Token/role | Value |
| --- | --- |
| Main conversation surface, `--app-color-background-surface` | `#181818` |
| Shell/editor surface, `--app-color-background-shell` | `#212121` |
| Elevated primary surface | `#212121` at 96% opacity |
| Opaque elevated primary / composer, `--color-background-composer-surface` | `#282828` |
| Main text, `--app-color-text-foreground` | `#dfdfdf` |
| Secondary text | Main foreground at 65% opacity |
| Tertiary text | White at 50% opacity |
| Border / subtle border | White at 8% / 4% opacity |
| Secondary control hover | White at 8% opacity |

The sidebar layout also blends the main surface at 65% opacity over its shell in `webview/assets/app-initial-341eb5dd9ad5.css`; its apparent shade depends on the containing surface. Use these neutral tokens for the harness palette instead of its previous blue-tinted grays.

## User bubbles

`webview/assets/user-message-f152e09d34c3.css` specifies a standard bubble radius of 22 px and a maximum width of 70%. Its compact variant uses a 16 px radius and a maximum width of 456 px.

The generic native Codex background token is `color-mix(in oklab, var(--color-text) 5%, transparent)`. The installed messaging UI has a separate outgoing bubble variant: `webview/assets/app-initial-341eb5dd9ad5.css` uses `--messaging-outgoing-background` with `--color-background-info` as its fallback, a 22 px radius, and 10 px by 16 px padding. The live capture shows blue outgoing bubbles; an exact blue value was not established from the inspected static tokens. Treat that live color as a variant, rather than an exact static Codex default.

For the harness, the directly supported adjustments are the neutral surface palette, 768 px content width, 22 px composer corners, 16 px icons, 13 px small controls, and 16 px composer bottom inset.
