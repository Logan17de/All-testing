# Using the graph editor

Open **Graph editor** from the workspace navigation, or visit `/editor`. The **Guide** button in the editor opens the in-app version of this guide.

A graph is a workflow: nodes perform steps and connections pass values or determine which step runs next. The editor saves Graph JSON; the runtime compiler validates it before execution.

## Your first graph

You can try this without a model provider:

1. Search the **Node library** for **Text box** and click it to add one. Type `Hello from my graph` inside it.
2. Search for **Output box** and add one. Move it to the right of the Text box.
3. Click the Text box's **Text** output port on its right, then the Output box's **Text** input port on its left. You can also drag between those ports.
4. To connect without dragging, choose **Connect nodes** in the top toolbar. Leave the type as **Data**, select the Text box's **Text** output and the Output box's **Text** input, then choose **Connect ports**.
5. When the toolbar says **Ready to run**, choose **Run graph**. The run page shows the recorded result in the Output box.

To add a model, place a **Model** node between those two boxes: Text box **Text** → Model **Prompt**, then Model **Text** → Output box **Text**. Select Model to configure its model ID, instructions, or output limit. An empty model ID lets the runtime choose an available connected model. Configure a provider through the Models/settings screens first.

## Find, add, and configure nodes

- Search by node name, description, or plugin name. Click a library item to add it near the visible canvas center, or drag it to a position.
- Select a node to open its configuration and inputs in the right inspector. Its Connections section lists incoming and outgoing connections.
- Unconnected, non-secret inputs can accept typed values. Connecting an input removes its previous typed value or binding. **Undo** restores the prior document, including the binding.
- Secret inputs need a secret reference; the editor does not accept raw secrets in the ordinary input field.
- Missing nodes usually mean the providing plugin is disabled or unavailable. Enable it on the Plugins page, then reload the editor.

## Connect ports

| Connection | Ports | Purpose |
| --- | --- | --- |
| Data | Right side output → left side input | Pass a value, such as text into a prompt. |
| Control | Bottom output → top input | Run the destination after the source finishes on that path. |

Click an output and then a matching input, drag from output to input, or use the **Connect nodes** form. The form uses ordinary keyboard-accessible select controls. Control ports may have names for branches, outcomes, or lanes; unnamed ports appear as **After** and **Before** in the form.

Data ports connect only to data ports; control ports connect only to control ports. A node cannot connect to itself. Duplicate connections are rejected. An input normally accepts one data connection, so disconnect it before replacing it; plugins can explicitly allow multiple connections. Schema compatibility and structured control-flow rules are checked by the runtime compiler.

Control connections order execution and do not pass data. A skipped control branch also skips downstream steps on that branch. Route, Wait, loop, and interrupt nodes have specific control contracts; follow the port names and resolve compiler diagnostics before running.

## Disconnect, delete, and recover

- Select a line, then choose **Disconnect** in the inspector. Lines have a wider invisible selection area to make them easier to select.
- Alternatively, use the unlink button beside any entry in **Connections**. Its accessible label describes the connection being removed.
- Select a node and choose **Delete node** to remove it and its connections. On the canvas, **Delete** or **Backspace** removes the selection.
- **Undo** restores the last edit, including deleted nodes, connections, values, and positions. **Redo** reapplies it. Up to 80 edits are kept during the current visit; a new edit clears the redo stack.
- Use **Ctrl/⌘ Z** to undo, **Ctrl/⌘ Shift Z** or **Ctrl/⌘ Y** to redo when focus is in the editor. Text fields keep their native text-editing shortcuts.

## Arrange your workspace

Drag nodes to move them. Pan the canvas by dragging empty space. Zoom and **Fit View** are at the top-left of the canvas; Fit View brings all nodes into view. The minimap helps navigate larger graphs.

Drag the separators between the library, canvas, and inspector to resize the side panels. Tab to a separator and use Left/Right arrows for 10-pixel steps, or Shift + arrows for 40-pixel steps. Home/End selects the minimum/maximum; Enter or double-click restores the default. Width preferences are stored in this browser. On smaller screens, the inspector moves below the canvas; on phones, panels stack and horizontal resize controls are hidden.

## Validate and run

The compiler checks executable changes automatically after a short pause. Moving a node only changes layout and does not cause a new compile. The toolbar reports whether the graph is ready; an unfinished graph is not covered in errors while you draw.

If the status says **Not ready to run yet**, choose **Run graph** to reveal the problems. Select a diagnostic in the graph overview to focus its node or connection, fix the configuration, and wait for **Ready to run**. Once valid, choose **Run graph** again. A run stores a new revision and opens its run page. Runtime execution and permission rules still apply.

If the runtime cannot be reached, start or reconnect the runtime and reload the page. A graph cannot be run while validation is unavailable or pending.

## Save, export, and import

The working draft autosaves in this browser as you edit. It is local to this browser profile and origin, is not a cross-device backup, and can be lost if site data is cleared. A warning appears if storage fails.

Select empty canvas or **Graph overview** to find **Document** controls:

- **Export JSON** opens the finalized Graph JSON. Copy it into a `.json` file for backup or sharing. Review typed values and configuration before sharing.
- **Import JSON** accepts a Graph JSON v1 document. Paste it and choose **Load this JSON**. Import replaces the draft; Undo can restore the previous graph during the same visit. Shape validation occurs on import, and executable validation occurs in the compiler.
- **Clear** asks for confirmation before clearing the graph. It can also be undone during the same visit.

Opening a conversation's workflow asks before replacing a nonempty draft. Each execution has its own immutable revision; changing the draft does not rewrite an earlier run. Undo/redo history is kept in memory and resets when you leave or reload the editor, even though the latest draft is saved.

## Which graph am I looking at?

The chat's **Graph** panel is a read-only preview of its workflow or execution. Open the workflow in **Graph editor** to change nodes and connections. The **My Assistant** connection controls configure assistant resources and permissions; they are separate from graph data/control connections.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Cannot connect two ports | Check output → input direction and data/control type. Use Connect nodes for a specific explanation. |
| Input already connected | Disconnect the old edge, then connect the new source. Undo recovers an accidental removal. |
| Node is missing from the library | Clear the search, check Plugins, and verify the runtime is reachable. |
| Node is outside the visible canvas | Choose Fit View. |
| Graph cannot run | Choose Run graph to reveal compiler problems; inspect required inputs, configuration, and control wiring. |
| Graph ready but model run fails | Check that a model/provider is connected and inspect the recorded run error. |
| Browser storage warning | Export JSON before navigating away. |

For source-format and compiler architecture, see [GRAPH.md](../GRAPH.md).
