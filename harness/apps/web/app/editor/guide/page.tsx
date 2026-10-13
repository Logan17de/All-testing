import Link from "next/link";
import { Icon } from "../../ui/workspace-icon";
import "./guide.css";

export const metadata = { title: "Graph guide — Zet Harness" };

export default function GraphGuidePage() {
  return (
    <main className="page graphGuide">
      <nav className="crumbs">
        <Link href="/editor">Graph editor</Link>
        <span aria-hidden="true">/</span>
        <span>Guide</span>
      </nav>
      <header className="graphGuide__header">
        <p className="eyebrow">WORKFLOW BASICS</p>
        <h1>From an idea to a running graph.</h1>
        <p>
          A node is a step. A connection passes a value or decides what happens next. Build, check,
          and run your workflow in one place.
        </p>
        <Link className="btn btn--primary" href="/editor">
          <Icon name="graph" /> Open graph editor
        </Link>
      </header>
      <nav className="graphGuide__contents" aria-label="On this page">
        <a href="#quick-start">Quick start</a>
        <a href="#connections">Connections</a>
        <a href="#editing">Editing & recovery</a>
        <a href="#workspace">Workspace</a>
        <a href="#run">Run & troubleshoot</a>
        <a href="#save">Save & share</a>
      </nav>
      <section id="quick-start">
        <p className="eyebrow">01 / QUICK START</p>
        <h2>Your first graph in a minute</h2>
        <p>This example needs no model provider. The Text box sends your text to an Output box.</p>
        <div
          className="graphGuide__example"
          aria-label="Text box Text output connects to Output box Text input"
        >
          <span>
            <strong>Text box</strong>
            <small>Text output</small>
          </span>
          <Icon name="chevron-right" />
          <span>
            <strong>Output box</strong>
            <small>Text input</small>
          </span>
        </div>
        <ol>
          <li>
            Search the Node library for <strong>Text box</strong> and click to add it. Type a short
            message inside it.
          </li>
          <li>
            Add an <strong>Output box</strong> and move it to the right.
          </li>
          <li>
            Click the Text box&apos;s <strong>Text</strong> port on its right, then the Output
            box&apos;s <strong>Text</strong> port on its left. Dragging between the ports also
            works.
          </li>
          <li>
            Wait for <strong>Ready to run</strong>, then choose <strong>Run graph</strong> in the
            top toolbar. The run page shows the recorded output.
          </li>
        </ol>
        <p>
          To add AI, insert a <strong>Model</strong> node: Text box <strong>Text</strong> → Model{" "}
          <strong>Prompt</strong>, then Model <strong>Text</strong> → Output box{" "}
          <strong>Text</strong>. Connect a model provider first. Select Model to set instructions or
          a model ID; leaving the ID empty lets the runtime choose an available connected model.
        </p>
      </section>
      <section id="connections">
        <p className="eyebrow">02 / CONNECTIONS</p>
        <h2>Connect with a click, drag, or keyboard</h2>
        <p>
          <strong>Connect nodes</strong> in the toolbar opens a form in the inspector. Choose Data
          or Control, select an output and input, then choose <strong>Connect ports</strong>. Every
          field works with the keyboard.
        </p>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Ports</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Data</td>
                <td>Right → left</td>
                <td>Passes a value, such as text into a prompt.</td>
              </tr>
              <tr>
                <td>Control</td>
                <td>Bottom → top</td>
                <td>Runs the destination after the source finishes on that path.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Ports must match their connection type. Self-connections and duplicates are blocked. An
          input usually accepts one data connection: disconnect it first to use another source. Some
          plugins explicitly allow multiple connections.
        </p>
        <p>
          Named control ports describe branches, outcomes, or lanes. Unnamed control ports appear as{" "}
          <strong>After</strong> and <strong>Before</strong> in the form. Control connections do not
          carry data. A skipped branch skips its downstream steps. The compiler checks schemas and
          structured control-flow rules.
        </p>
        <p>
          Select a line and choose <strong>Disconnect</strong>, or use the unlink icon in the
          inspector&apos;s Connections list. Selecting a node filters the list to that node&apos;s
          connections.
        </p>
      </section>
      <section id="editing">
        <p className="eyebrow">03 / EDITING & RECOVERY</p>
        <h2>Make changes with a way back</h2>
        <p>
          Select a node to edit its configuration and inputs. An unconnected input can take a typed
          value. Adding a data connection removes that input&apos;s previous value or binding;{" "}
          <strong>Undo</strong> restores the prior document. Secret inputs require a secret
          reference instead of an ordinary typed value.
        </p>
        <p>
          <strong>Delete node</strong> removes a node and its connections. The toolbar&apos;s Undo
          and Redo restore nodes, connections, values, and positions. Up to 80 edits are kept in
          memory for this visit; a new edit clears redo.
        </p>
        <dl className="graphGuide__shortcuts">
          <div>
            <dt>Undo / Redo</dt>
            <dd>Ctrl/⌘ Z · Ctrl/⌘ Shift Z or Ctrl/⌘ Y</dd>
          </div>
          <div>
            <dt>Delete selection</dt>
            <dd>Delete or Backspace on the canvas</dd>
          </div>
          <div>
            <dt>Text editing</dt>
            <dd>Text fields keep their native undo shortcuts.</dd>
          </div>
        </dl>
      </section>
      <section id="workspace">
        <p className="eyebrow">04 / WORKSPACE</p>
        <h2>Give your graph room</h2>
        <p>
          Search the library by node name, description, or plugin. Click to add near the canvas
          center, or drag to choose a position. Drag empty canvas to pan; use Zoom and{" "}
          <strong>Fit View</strong> at the top-left to bring your work into view.
        </p>
        <p>
          Drag the separators beside the canvas to resize the library and inspector. You can also
          Tab to a separator and use Left/Right arrows. Hold Shift for larger steps, use Home/End
          for the limits, or press Enter or double-click to reset. Panel widths are remembered in
          this browser.
        </p>
        <p>
          On smaller screens the inspector moves below the canvas. On phones the panels stack and
          horizontal resize handles are hidden.
        </p>
      </section>
      <section id="run">
        <p className="eyebrow">05 / RUN & TROUBLESHOOT</p>
        <h2>Check the graph, then run it</h2>
        <p>
          The runtime compiler checks executable edits after a short pause. Moving nodes only
          changes their layout. If the graph is unfinished, choose <strong>Run graph</strong> to
          reveal its problems. Select a diagnostic in Graph overview to focus the relevant node or
          connection. Fix the inputs or configuration, wait for <strong>Ready to run</strong>, then
          run again.
        </p>
        <p>
          Each run records a new revision and opens its run page. Runtime execution and permission
          rules still apply. A model provider must be connected for Model nodes to execute.
        </p>
        <ul>
          <li>
            <strong>Ports will not connect:</strong> check output → input direction and data/control
            type. Use Connect nodes for a specific explanation.
          </li>
          <li>
            <strong>Missing node:</strong> clear search and check that its plugin is enabled.
          </li>
          <li>
            <strong>Lost on the canvas:</strong> choose Fit View.
          </li>
          <li>
            <strong>Runtime unavailable:</strong> start or reconnect the runtime and reload the
            editor.
          </li>
          <li>
            <strong>Run failed:</strong> open the recorded error in the run page and check provider
            configuration or required inputs.
          </li>
        </ul>
      </section>
      <section id="save">
        <p className="eyebrow">06 / SAVE & SHARE</p>
        <h2>Keep a copy of your workflow</h2>
        <p>
          Your draft autosaves in this browser profile and origin. It is not a cross-device backup.
          If site data is cleared, the draft can be lost. A storage warning means you should export
          before leaving.
        </p>
        <p>
          Click empty canvas or <strong>Graph overview</strong> to find Document controls.{" "}
          <strong>Export JSON</strong> opens the document so you can copy it to a JSON file.{" "}
          <strong>Import JSON</strong> replaces the draft with a Graph JSON v1 document; Undo
          recovers the prior draft during the same visit. <strong>Clear</strong> asks before
          removing everything and can also be undone.
        </p>
        <p>
          Review typed values and configuration before sharing JSON. Undo history resets when you
          leave or reload the editor; the latest draft remains saved. Editing a draft does not
          rewrite earlier run revisions.
        </p>
      </section>
      <aside className="graphGuide__note">
        <h2>Graph editor, chat preview, or assistant connections?</h2>
        <p>
          The chat&apos;s Graph panel is a read-only view of a workflow or execution. Open its
          workflow in Graph editor to edit it. My Assistant&apos;s connection controls manage
          assistant resources and permissions separately from graph data and control ports.
        </p>
      </aside>
    </main>
  );
}
