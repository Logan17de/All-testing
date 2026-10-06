# Testing the native harness

Use the verified commit linked in the testing-build report. This is a local application; the draft PR is not a deployment.

```sh
git clone --branch zet-harness-v1 https://github.com/Logan17de/All-testing.git
cd All-testing/harness
npm ci
npm run build
npm start
```

Use Node 24.20.x and npm 12.x. The launcher prints the runtime and web addresses; open the web address, select an ordinary project folder in Setup, and use `/agent`, `/assistant`, `/plugin-maker` and `/plugins`.

Keep runtime state and installed trusted plugins outside the selected coding workspace. For example, on Linux, before launching:

```sh
export ZET_TEST_STATE="$HOME/.local/state/zet-harness-test"
mkdir -p "$ZET_TEST_STATE/plugins"
export ZET_RUNTIME_DB_PATH="$ZET_TEST_STATE/runtime.sqlite"
export ZET_RUNTIME_PLUGINS_DIR="$ZET_TEST_STATE/plugins"
export ZET_NPM_CLI="$(readlink -f "$(command -v npm)")"
npm start
```

Linux project execution and generated-plugin tests require a working bubblewrap namespace sandbox; the application refuses host execution when it is unavailable. CI installs a pinned verified bubblewrap and a narrowly scoped executable-specific Ubuntu user-namespace profile. Do not disable global kernel protections to make the application run.

For the assistant, create a root and explicitly connect only chats you want it to read/control. Child tool assignment and the parent delegation ceiling are separate user decisions. A child can request additional tools; a parent may grant only within the ceiling and its frozen turn authority. Changes revoke active turns, so start a fresh turn afterwards. Filesystem/process/Git mutations still require exact per-call approval.

The plugin maker proposes inert source. Inspect every file, materialize the exact artifact, review it, and separately authorize sandbox testing. Enabling requires a successful exact-artifact sandbox test and explicit trust in code that will run with daemon authority after restart. It installs outside the model workspace and adds no capability grants. The configured trusted plugin directory must already exist. A host configured to require package integrity refuses an unsigned proposal before installation; add valid reviewed manifest digests before requesting activation. Windows maker write/test/enable actions currently fail closed; scaffold/edit/inspection remain available. Marketplace publishing and Zetbros site integration are deferred.

Live provider login and consent are user actions. The OpenAI/ChatGPT integration has not been verified with a real registration/account here. Claude subscription OAuth is not offered as a third-party native login; using an official Claude bridge or API billing requires choosing that supported option. General third-party Grok subscription OAuth is not established by the documented Grok Build CLI flow. The harness does not extract cookies/tokens or silently substitute API billing. See [capability acceptance](CODEX-ACCEPTANCE.md) and [provider boundaries](STANDALONE-ARCHITECTURE.md).

Repository tests use scripted model fixtures; passing them does not demonstrate a live paid provider or real desktop capture/input. Current Windows and MCP limitations are recorded in the acceptance checklist. Download a source archive only from the exact verified commit linked in the report; no binary release or external service is published.
