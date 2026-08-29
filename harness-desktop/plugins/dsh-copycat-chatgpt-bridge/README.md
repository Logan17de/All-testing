# Copycat ↔ Harness Bridge

This plugin exposes one authenticated loopback API that lets Copycat put messages into ordinary DeepSeek Harness sessions.

The important design rule is that the bridge does **not** duplicate Harness tools. A message submitted through `POST /api/bridge/message` is sent through Harness's normal Session prompt API, so the receiving Harness agent gets the same mounted tools, plugins, permissions, model configuration, filesystem access, shell access, Git access, and skills that it would have from the normal Harness UI.

## Discovery and pairing

The server binds only to loopback (`127.0.0.1` by default).

On activation it writes:

```text
%USERPROFILE%\.dsh\copycat-bridge\bridge.json
```

(or under the active `DSH_HOME`). The file contains the current `baseUrl`, port, process id, and pairing token. Copycat Desktop should read this file instead of hardcoding a port.

A token is generated once and stored beside the discovery file. Set `COPYCAT_BRIDGE_TOKEN` before Harness starts if you want to supply your own token.

Optional environment settings:

```text
COPYCAT_BRIDGE_HOST=127.0.0.1
COPYCAT_BRIDGE_PORT=43119
COPYCAT_BRIDGE_TOKEN=<your token>
```

If the default port is busy and `COPYCAT_BRIDGE_PORT` was not explicitly set, the plugin chooses a free loopback port and records it in `bridge.json`.

Every request must include either:

```http
Authorization: Bearer <token>
```

or:

```http
X-Copycat-Token: <token>
```

## API

### `GET /api/bridge/status`

Returns bridge health and the current listening address.

### `GET /api/bridge/sessions`

Returns Harness's normal Session list.

### `POST /api/bridge/session`

Creates a normal Harness Session.

```json
{
  "cwd": "D:\\Projects\\AIKO"
}
```

You may pass `workspace_id` instead of `cwd` when Copycat already knows a Harness Workspace id.

### `POST /api/bridge/message`

Sends ChatGPT/Copycat text into Harness as a normal queued Session prompt.

```json
{
  "session_id": "<Harness Session id>",
  "text": "Run the tests, investigate the failures and fix them.",
  "attachments": [
    "D:\\Temp\\screenshot.png"
  ]
}
```

If `session_id` is omitted the bridge creates a new Harness Session and returns its id.

Attachments remain local. The bridge adds their paths to the prompt so Harness can inspect them with its already-mounted file/image tools; it does not bypass Harness filesystem policy.

The HTTP response means the prompt was accepted. Harness's actual work and assistant response arrive through the event stream.

### `GET /api/bridge/session/:sessionId`

Returns recent history for a Harness Session.

### `POST /api/bridge/cancel`

```json
{
  "session_id": "<Harness Session id>"
}
```

Cancels the current Harness turn for that Session.

### `GET /api/bridge/events`

Server-Sent Events stream. Use an HTTP client that can attach the bearer token (Copycat Desktop can use `fetch`). The plugin forwards Harness's existing `mux` and `host` event streams without inventing a second agent protocol.

Example event:

```text
event: harness
data: {"type":"harness.event","stream":"mux","payload":{...}}
```

Copycat should use the Session id in Harness events to correlate assistant output with the ChatGPT conversation it mapped to that Harness Session.

## Minimal Copycat Desktop flow

```js
const discovery = JSON.parse(await fs.promises.readFile(
  path.join(os.homedir(), '.dsh', 'copycat-bridge', 'bridge.json'),
  'utf8',
))

const headers = {
  Authorization: `Bearer ${discovery.token}`,
  'Content-Type': 'application/json',
}

const sent = await fetch(`${discovery.baseUrl}/message`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    session_id: harnessSessionId,
    text: chatGptCompletedResponse,
  }),
}).then(r => r.json())

harnessSessionId = sent.session_id
```

Keep a long-lived authenticated fetch open to `${discovery.baseUrl}/events` and forward the relevant completed Harness assistant response back through Copycat's existing browser bridge.

## Responsibility split

```text
ChatGPT       plan / review / decide
     ↕
Copycat       browser + desktop transport
     ↕
This plugin   authenticated local Session API
     ↕
Harness       agents + all existing tools/plugins/skills
     ↕
PC
```

The bridge intentionally does not implement filesystem, shell, Git, goal, todo, or coding APIs. Harness already owns those capabilities.
