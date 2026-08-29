# Harness Desktop native client specification

## Product brief

Harness Desktop is a first-class Windows application for developers and power
users who want to run Harness every day without operating a browser surface.
The desktop application owns the window, navigation, conversation, workspace,
provider, plugin, recovery, and log interfaces. DeepSeek Harness (DSH) remains
the execution engine and is reached through authenticated local process IPC;
normal operation does not start, navigate to, or embed an HTTP user interface.

The primary job is: choose a project, configure a model provider, run and
continue agent sessions, and update plugins without risking the last working
configuration.

Success means a user can complete this loop without leaving the application or
repairing files by hand:

`install -> launch -> configure -> run -> receive plugin -> validate -> build -> activate -> restart -> verify -> rollback -> recover`

Non-goals for v0.1 are reimplementing the DSH agent/tool runtime, cloud sync,
and exposing every advanced DSH browser setting.

## Product objects and actions

| Object | Durable identity | Primary actions | Consequence language |
| --- | --- | --- | --- |
| Workspace | DSH workspace id and canonical path | choose, open, persist | “Use folder”; never implies deletion |
| Session | DSH session id | create, select, prompt, cancel, archive | “New task”, “Send”, “Stop run” |
| Provider | provider route plus secret reference | validate, save, replace | “Test connection”, “Save provider” |
| Plugin candidate | staged candidate id | inspect, activate, discard | “Activate & restart” names the restart |
| Plugin version | package name and exact version | disable, roll back | “Disable & restart”, “Restore previous version” |

## Application structure

The navigation rail has four destinations: Work, Plugins, Settings, and Logs.
Work is the default and contains the workspace/session navigator, conversation,
run status rail, and composer. Plugins owns the transactional update surface.
Settings owns provider configuration and recovery controls. Logs owns the
filterable app/engine/plugin/build/runtime record.

The visual direction is a restrained developer control room: charcoal and
slate surfaces, parchment-white text, cobalt for the primary action, amber for
recoverable attention, and red only for failures or destructive consequences.
Segoe UI Variable is used for interface text and Cascadia Mono for runtime
details. The signature element is the run rail beside a conversation, showing
queued, running, complete, cancelled, failed, or recovered state from real
engine events.

## Reachable state model

| Surface | Required states |
| --- | --- |
| Application | starting, ready, safe mode, startup failed, recovering, restarting |
| Workspace | none selected, choosing, ready, unavailable, persisted |
| Session list | loading, empty, ready, failed |
| Conversation | loading, empty, ready, streaming/running, cancelled, failed |
| Composer | ready, submitting, queued, disabled for unroutable model; draft is preserved on failure |
| Provider | absent, editing, checking, valid, invalid, saved |
| Plugin candidate | receiving, inspecting, invalid, staged, building, checked, activation pending |
| Installed plugin | active, disabled, broken, restoring, restored |
| Logs | loading, empty, populated, read failure |

Safe Mode must leave Work diagnostics, Plugins rollback/disable, Settings, and
Logs reachable while preventing automatic engine/plugin startup. An engine
failure must never hide recovery actions behind the failed surface.

## Interaction and accessibility rules

- `rule/cover-reachable-states`: every state above has an intentional inline
  representation; failures do not become blank panes.
- `rule/preserve-user-input`: a prompt or provider edit is cleared only after a
  confirmed successful handoff/save.
- `rule/keyboard-complete-flow`: all navigation, session selection, prompting,
  cancellation, provider actions, plugin actions, and recovery actions are
  reachable by keyboard with visible focus.
- `rule/name-object-scope-consequence`: risky labels name the affected plugin or
  current run and explicitly mention restart/restore consequences.

The desktop preload exposes narrow, allowlisted commands. The renderer receives
serializable values only. The engine bridge accepts a fixed method allowlist,
uses request ids, rejects malformed messages, and emits structured lifecycle
events. No renderer gets Node.js, filesystem, shell, or arbitrary IPC access.
