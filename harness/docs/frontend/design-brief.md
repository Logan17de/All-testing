# Harness workspace refresh

Date: 2026-10-07

The user wants a production-oriented coding harness with the calm, task-focused layout of Codex and Claude Code, an easier graph editor, consistent typography, essential chat controls, and adjustable side panels.

## Product decisions

- User/job: someone working with code and agent workflows needs to keep the conversation readable while inspecting workflow wiring.
- Current behavior: fixed columns consume conversation space, secondary actions sit beneath the composer, and graph wiring relies on small canvas handles.
- Desired outcome: preserve existing chat, model, session, permission and compiler behavior while making graph connection/disconnection explicit and panels adjustable.
- Success signals: wiring and disconnection work with pointer and keyboard controls; resize works with drag and keys, survives reload, and cannot collapse a panel into unusable dimensions; no extra action strip appears below the chat.
- Objects and consequences: panel width is a reversible local preference; graph connection edits change workflow data and require validation before execution; moving chat actions changes placement only.
- Authorization: existing model, tool, terminal and run permissions remain enforced.
- Boundaries: this refresh does not establish live provider, native desktop or deployment acceptance for the entire harness.

Decisions follow the user's explicit constraints and product-design rules: `rule/keyboard-complete-flow` for a connection form and focusable separators, `rule/inline-before-modal` for advanced actions, `rule/preserve-mental-model` for retaining current routes and data, and `rule/name-object-scope-consequence` for explicit Disconnect labels. Layout dimensions and visual styling are implementation choices under Frontend Studio.

## Visual direction

- Perform-a-task workspace; medium information density.
- Use the installed Codex reference: #181818 workspace, #212121 navigation/side panel, #282828 composer, pale text and quiet borders. See [Codex UI reference](codex-ui-reference.md) for inspected bundle sources.
- Use the existing system sans-serif family through `--app-font-sans` for all harness UI and text editors.
- One shared 24-unit SVG icon vocabulary, 1.6px stroke, 16–18px rendered sizes.
- Keep navigation and inspector controls in headers; model, approval status and send/stop belong inside the composer.
- Shared 768px conversation/composer width, 44px desktop toolbar, 22px composer corners, 16px bottom inset, and 288px navigation (matching the observed navigation area without Codex's separate product rail). Blue user bubbles visually follow the running app; their exact runtime color was not extracted.
- Narrow chat screens use collapsible navigation and a modal inspector. The graph editor stacks its inspector. Desktop separators expose drag, arrow keys, Home/End and reset.
- Motion is limited to short feedback transitions; reduced-motion preferences remain respected.

## Verification scope

Routes: /agent, /editor, /editor/guide, representative settings and other shared typography surfaces.
Check at 320, 390, 768 and 1440px, including an open inspector, graph connections, keyboard controls and reload persistence.
Use the bundled Node 24.20.0 and npm 12.0.2. Record commands and actual outcomes in the QA report.
