# General settings

Open **Settings → General** to customize the coding workspace. The grouped rows follow the supplied Codex reference.

## Permissions and folder

**Default permissions** controls workspace change requests and stays synchronized with **Workspace changes** in Settings → Chat. Protected actions still require their existing approvals. **Manage** opens the other chat tool preferences.

**Default task folder** is used for new chats when a project does not supply its own folder. Choose **Change**, **Choose**, or **Review** to open the folder picker. Selecting a folder opens a trust review; it is saved only after **Trust and use as default** succeeds. Selecting a folder does not move files.

## Chat behavior

| Setting | Behavior |
| --- | --- |
| Send shortcut: Enter | Enter sends; Shift+Enter inserts a new line. |
| Send shortcut: Ctrl / ⌘ + Enter | Ctrl+Enter or Command+Enter sends; Enter inserts a new line. |
| Confirm before leaving | Requests the browser's standard warning before closing/reloading with an unsent draft or an observed running task. Browser rules determine whether the warning appears. |
| Full view by default | Starts newly selected chats with the side panel closed on desktop. Manual panel changes remain in effect for the current chat. Small screens start with the panel closed. |

Composition through an input method does not submit a partial message.

## Notifications

Choose **Enable** beside Browser notifications to ask the browser for permission. The harness never asks automatically on page load.

- **Task completion notifications:** Only when unfocused, Always, or Never.
- **Permission request notifications:** alerts for new pending approvals.
- **Notification sound:** Off or Chime. **Test sound** previews the chime.

Alerts monitor observed tasks across chats while the coding workspace is open in this tab, including when Settings is open over it. Completed history is not replayed as new notifications. Notification text is generic and does not include prompts or file content. Clicking one focuses the harness window.

Sound is off by default. When Chime was previously selected, the first genuine click or key press after reopening the page enables audio for that visit. The browser must support notifications and audio. If notification permission is blocked, use the browser's site settings to change it.

General preferences save in this browser. Folder selection is saved by the runtime. If browser storage is unavailable, the page reports that changes may not survive a refresh.
