# Chat settings and archive retention

Date: 2026-10-07

User/job: keep chat controls in Settings and manage archived chats, including permanent deletion and a configurable retention period.

Current behavior: per-chat options live behind a header gear and reset after sending. Archived chats can be browsed in both a header selector and Settings; Settings offers restoration only.

Desired outcome: Settings → Chat contains persistent instructions and five checked-by-default options. Settings → Archived contains search, restore, permanent deletion and a persisted days policy. The header retains only current-chat actions.

Actions and consequences:
- Chat defaults are editable preferences for subsequent submissions, not changes to runtime capabilities or approval enforcement. Defaults follow the explicit user request.
- Restore returns one archived chat and its history to the active list.
- Delete permanently removes the selected archived chat and its owned history. An inline confirmation names that chat and offers Cancel before deletion.
- Retention defaults to -1 (never). It accepts -1 or a positive whole number of days measured from archiving. Saving a finite policy requires inline review and explicitly includes older existing archives. Active chats and unfinished runs are excluded.
- Preferences and policies persist; saving a policy is not contingent on keeping Settings open.

Design decisions use the existing Codex-inspired system: inherited system font, restrained surfaces, 13px controls, visible loading/error states and responsive rows. Product rules: rule/name-object-scope-consequence, rule/destructive-names-action, rule/destructive-proportional, rule/inline-before-modal, rule/no-nested-modals, rule/cover-reachable-states and rule/keyboard-complete-flow.

Verification: isolated runtime/DB tests for purge boundaries, restore/rearchive, dependency cleanup, unchanged unrelated data, persistence and guards; UI tests for defaults, submission, restore, deletion cancel/failure/success, retention validation/review/save, and desktop/phone layout. No actual user chat will be deleted or finite retention enabled during implementation testing.
