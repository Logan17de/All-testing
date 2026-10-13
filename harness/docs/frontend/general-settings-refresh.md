# General settings reference refresh

Date: 2026-10-07.

The user supplied two Codex General screenshots and requested useful controls with the same UI treatment. The existing page only embedded a setup step for folder selection. The job is to configure everyday chat behavior without leaving Settings; success requires persisted settings, observable behavior and clear approval/browser capability boundaries.

Selected direction: preserve the existing Settings popup/navigation and system font. Use Permissions, General and Notifications headings; 16px rounded #232323 groups with #383838 borders; 13px labels and 12px descriptions; separated compact rows; controls aligned right; blue 32×20 switches. Narrow content wraps controls below descriptions instead of compressing labels. This follows the supplied screenshots rather than introducing a different design system.

Chosen controls: shared workspace-change preference and link to Chat permissions; existing trusted default folder picker in an inline row; Enter versus Ctrl/Command+Enter; close warnings for drafts/running tasks; full-view default; completion/approval notifications; explicit browser permission and optional chime. Browser-local choices persist without changing task parameters already submitted. Folder trust stays an explicit runtime action. Notification permission is requested only by the Enable button.

Decisions follow rule/smallest-intervention, rule/inline-before-modal, rule/no-nested-modals, rule/name-object-scope-consequence, rule/keyboard-complete-flow and rule/cover-reachable-states. Native global hotkeys, unrestricted OS permissions, language translation, steering and other unavailable screenshot capabilities are not represented as working controls.

Implementation includes protected IME input, generic notification content, repeat-poll deduplication, all observed chats in the current runtime scope, valid active-run approval filtering, and audio activation after a real user interaction. Alerts require the coding workspace to remain mounted in a browser tab.

## Verification

- All web tests: 55 files, 272 tests passed.
- Final web production build and TypeScript passed, including close warnings for all observed tasks.
- Changed-file ESLint and formatting passed.
- Independent browser review: 71/71 checks passed across controls, persistence, shared permissions, folder trust, composer shortcuts, close warnings, side-panel defaults, notifications and 320/390/1440px layouts. Final captures had no console or hydration errors.
- Independent browser tests use isolated Edge profiles and mocked notification/audio/folder/model APIs. No real OS permission prompt, notification, audio, provider call or folder change is performed.

Evidence: `D:\Owie\z-harness-fbd3b114\ui-review\general-settings-refresh`.
Baseline, desktop/phone screenshots, test scripts and JSON reports are saved there. See [user guide](../general-settings.md).
