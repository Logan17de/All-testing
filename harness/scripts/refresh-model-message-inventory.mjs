import ts from "typescript";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const files = [
  "apps/runtime/src/runtime-coding-desktop-tools.ts",
  "apps/runtime/src/runtime-coding-image-store.ts",
  "apps/runtime/src/runtime-coding-worktrees.ts",
  "apps/runtime/src/runtime-windows-coding.ts",
  "apps/runtime/src/runtime-windows-process-sandbox.ts",
  "apps/runtime/src/runtime-public-model-state.ts",
  "apps/web/app/agent/desktop-image-consent.tsx",
  "apps/web/app/agent/desktop-image-consent-view.ts",
  "scripts/agent-cli.mjs",
  "packages/mcp/src/mcp-input-schema.ts",
  "apps/runtime/src/runtime-workspace-instructions.ts",
  "apps/runtime/src/runtime-agent-tool-policy.ts",
  "apps/runtime/src/runtime-agent-plugin-tools.ts",
  "apps/runtime/src/runtime-coding-plugin-scopes.ts",
  "apps/web/app/agent/chat-plugin-scope.tsx",
  "apps/web/app/agent/chat-plugin-view.ts",
  "apps/web/app/agent/chat-graph-panel.tsx",
  "apps/web/app/agent/chat-graph-canvas.tsx",
  "apps/web/app/agent/chat-messages.tsx",
  "apps/runtime/src/runtime-git-command.ts",
  "apps/runtime/src/runtime-coding-git-tools.ts",
  "apps/runtime/src/runtime-coding-file-tools.ts",
  "scripts/browser-cli.mjs",
  "apps/runtime/src/runtime-workflows.ts",
  "apps/runtime/src/runtime-browser-policy.ts",
  "apps/runtime/src/runtime-browser-session.ts",
  "apps/runtime/src/runtime-browser-driver.ts",
  "apps/runtime/src/runtime-browser-service.ts",
  "apps/runtime/src/runtime-browser-http.ts",
  "apps/runtime/src/runtime-browser-tools.ts",
  "apps/runtime/src/runtime-windows-desktop.ts",
  "apps/web/app/agent/agent-workspace.tsx",
  "apps/web/app/agent/chatgpt-connection.tsx",
  "apps/web/app/agent/mutation-approval.tsx",
  "apps/web/app/agent/desktop-session.tsx",
  "apps/web/app/desktop/page.tsx",
  "packages/github/src/github-plugin.ts",
  "packages/tools/src/native-fs-tools.ts",
  "packages/tools/src/workspace-path.ts",
  "packages/tools/src/command-allowlist.ts",
  "packages/tools/src/process-runner.ts",
  "packages/models/src/model-json.ts",
  "apps/runtime/src/runtime-agent-nodes.ts",
  "apps/runtime/src/runtime-coding-service.ts",
  "apps/runtime/src/runtime-assistant-tools.ts",
  "apps/runtime/src/runtime-assistant-service.ts",
  "apps/runtime/src/runtime-assistant-controller.ts",
  "apps/runtime/src/runtime-assistant-http.ts",
  "apps/runtime/src/runtime-assistant-access.ts",
  "apps/runtime/src/runtime-assistant-tool-access.ts",
  "apps/runtime/src/runtime-plugin-maker.ts",
  "apps/runtime/src/runtime-plugin-maker-tools.ts",
  "apps/runtime/src/runtime-plugin-maker-host.ts",
  "apps/runtime/src/runtime-plugin-maker-controller.ts",
  "apps/runtime/src/runtime-plugin-maker-http.ts",
  "apps/web/app/assistant/child-tool-rights.tsx",
  "apps/web/app/plugin-maker/plugin-maker-workspace.tsx",
  "apps/runtime/src/runtime-coding-tools.ts",
  "apps/runtime/src/runtime-coding-mutation-tools.ts",
  "apps/runtime/src/runtime-coding-subagents.ts",
  "apps/runtime/src/runtime-coding-search-tool.ts",
  "apps/runtime/src/runtime-process-sandbox.ts",
  "apps/runtime/src/runtime-action-tools.ts",
  "apps/runtime/src/runtime-goal-actions.ts",
  "apps/runtime/src/runtime-memory-actions.ts",
  "apps/runtime/src/runtime-chatgpt-auth.ts",
  "apps/runtime/src/runtime-chatgpt-auth-http.ts",
  "apps/runtime/src/runtime-chatgpt-model.ts",
  "apps/runtime/src/runtime-codex-search.ts",
  "apps/runtime/src/runtime-desktop-session.ts",
  "apps/runtime/src/runtime-desktop-http.ts",
  "apps/web/app/agent/desktop-consent.tsx",
  "apps/runtime/src/runtime-human-approvals.ts",
  "apps/runtime/src/runtime-effect-recovery.ts",
  "packages/models/src/model-http.ts",
  "packages/models/src/openai-compatible-model.ts",
  "packages/mcp/src/mcp-client.ts",
  "packages/mcp/src/mcp-tools.ts",
  "packages/tools/src/native-process-tools.ts",
  "packages/db/src/durable-goal-records.ts",
  "packages/db/src/durable-memory-records.ts",
];
let output = "";
let total = 0;
for (const file of files) {
  if (!fs.existsSync(root + file)) continue;
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(root + file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const entries = [];
  function add(node, label) {
    const text = node
      .getText(source)
      .replace(/\r?\n\s*/g, " ")
      .replace(/\|/g, "\\|");
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    let owner = node.parent;
    let context = "module scope";
    while (owner) {
      if ((ts.isFunctionDeclaration(owner) || ts.isMethodDeclaration(owner)) && owner.name) {
        context = owner.name.getText(source);
        break;
      }
      if (
        ts.isVariableDeclaration(owner) &&
        owner.initializer &&
        (ts.isArrowFunction(owner.initializer) || ts.isFunctionExpression(owner.initializer))
      ) {
        context = owner.name.getText(source);
        break;
      }
      owner = owner.parent;
    }
    const visibility = file.startsWith("apps/web/")
      ? "user UI"
      : /runtime-(?:chatgpt-auth|desktop|windows-desktop|browser-policy|human-approvals|coding-service|effect-recovery)/u.test(
            file,
          )
        ? "user/runtime; no automatic model injection"
        : /runtime-(?:coding-tools|coding-mutation-tools|coding-subagents|coding-search-tool|action-tools|goal-actions|memory-actions)|packages\/(?:tools|github|mcp)\//u.test(
              file,
            )
          ? "model metadata/result only when tool is offered or invoked; otherwise runtime"
          : "runtime/provider transport; model delivery only through documented envelope";
    entries.push({
      line,
      label: `${label}; trigger/context ${context}; ${visibility}; recovery: applicable family above`,
      text,
    });
  }
  function walk(node) {
    if (ts.isNewExpression(node) && /Error$/.test(node.expression.getText(source)))
      add(node, "Error construction; see delivery rules");
    if (
      ts.isCallExpression(node) &&
      /^(?:Error|TypeError|RangeError)$/.test(node.expression.getText(source))
    )
      add(node, "Error construction; see delivery rules");
    if (
      ts.isCallExpression(node) &&
      ["invalidInput", "budgetExceeded"].includes(node.expression.getText(source))
    )
      add(node, "Correctable refusal / budget gate");
    if (
      ts.isPropertyAssignment(node) &&
      ["inputSchema", "outputSchema"].includes(node.name.getText(source))
    )
      add(
        node.initializer,
        "Exact tool schema source; referenced constants resolve in this module",
      );
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "description")
      add(node.initializer, "Tool/schema description when offered");
    if (
      ts.isCallExpression(node) &&
      ["actionTool", "tool"].includes(node.expression.getText(source)) &&
      node.arguments[2]
    )
      add(node.arguments[2], "Action tool description");
    if (
      ts.isCallExpression(node) &&
      ["actionTool", "tool"].includes(node.expression.getText(source)) &&
      node.arguments[3]
    )
      add(node.arguments[3], "Exact action-tool input schema source");
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source).endsWith(".end") &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text
    )
      add(node.arguments[0], "User-visible HTTP response notice, not model input");
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "setError" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text
    )
      add(node.arguments[0], "User-visible UI error, not model input");
    if (ts.isJsxText(node) && node.getText(source).trim())
      add(node, "User-visible JSX wording, not model input");
    ts.forEachChild(node, walk);
  }
  walk(source);
  if (!entries.length) continue;
  total += entries.length;
  output += `\n### ${file}\n\n| Line | Trigger/delivery category | Exact source expression |\n|---|---|---|\n`;
  for (const entry of entries)
    output += `| ${entry.line} | ${entry.label}; implemented | <code>${entry.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/`/g, "&#96;")}</code> |\n`;
}
const documentPath = root + "Harness msgs to the models.md";
const existing = fs.readFileSync(documentPath, "utf8");
const section = existing.indexOf("## Source-derived exact expressions");
const marker = existing.indexOf("\n### ", section);
if (section < 0 || marker < 0) throw new Error("Missing source inventory section.");
const beforeAppendix = existing.slice(0, marker).trimEnd();
const generated =
  beforeAppendix +
  output +
  `\nInventory coverage: ${files.length} selected implementation modules; ${total} fixed schema/description/error/UI expressions. Tests, provider-owned text, user files and unrelated llm/tts projects are excluded. Runtime transport serializers and their exact role/result shapes are documented above. New integrations must add their implemented wording and visibility before claiming inventory completion. UI JSX/source expressions preserve code spelling; whitespace follows normal JSX rendering. Per-module entries inherit the applicable trigger/delivery and recovery rules above; errors do not themselves grant authority or automatically authorize a retry.\n`;
if (process.argv.includes("--check")) {
  if (existing !== generated) {
    console.error("Model message inventory is stale; run npm run inventory:refresh.");
    process.exitCode = 1;
  }
} else fs.writeFileSync(documentPath, generated);
console.log({ files: files.length, expressions: total });
