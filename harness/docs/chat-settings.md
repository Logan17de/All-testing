# Chat settings and archived chats

Open **Settings** from the workspace navigation.

## Chat defaults

Choose **Chat** to set shared instructions and tools for your next tasks. Workspace changes, Subagents, Web research, Browser tools and Desktop tools are checked by default. Uncheck any option to disable it for later submissions.

Changes save in this browser and apply across chats. They do not change a task already submitted. Tool connections and runtime approval requirements still apply. The model picker remains in the composer; manage providers under Configuration and Account in Settings.

## Archive and restore

Use **Archive chat** in a chat's action menu, or its sidebar archive control. Then open **Settings → Archived** to search archived chats.

**Restore** returns a chat to the active list with its history intact. Archiving again starts a new retention period.

## Delete permanently

In **Settings → Archived**, choose **Delete permanently** beside the chat. Review the named chat, then choose **Delete chat permanently**. **Cancel** or Escape dismisses the inline confirmation.

Deletion removes the saved conversation, messages and owned execution history. It cannot be restored through the harness. Project files, goals and project memories remain. Chats with unfinished work or execution history shared with another chat cannot be deleted until that dependency is resolved.

## Automatic deletion

Under **Automatically delete archived chats**, enter:

| Value | Behavior |
| --- | --- |
| `-1` | Never delete automatically. This is the default. |
| A positive whole number, such as `30` | Delete eligible chats after that many days since they were archived. |

Choose **Save retention**. A finite policy opens a review explaining that existing older archives are included; choose **Save and apply auto-delete** to apply it. Returning the value to `-1` disables future automatic deletion.

The policy is stored in the runtime database and survives restarts. Cleanup runs when the runtime starts, when you apply a policy, and every minute while it is running. Large backlogs are processed in batches. Unfinished or shared work is skipped. Restoring a chat removes it from cleanup eligibility.

If a save or deletion fails, the Settings page keeps the chat or entered value visible and shows the error. Resolve the issue, retry, or refresh the archived list.
