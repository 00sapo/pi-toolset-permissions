# Design

This document describes the design of the extension. It explains the layers, the decisions, and the module boundaries.

## Terms

A toolset is a group of tool names with one state: off, on, or ask. A pattern is a regular expression that the extension tests against a tool name.

A path scope is the set of directories that file tools can touch. A sandbox is an operating-system boundary for shell commands.

The `permissions` toolset holds the `permissions` tool. Off blocks state changes but preserves the approval channel for ask tools.

The `permissions` toolset supports only the on and off states. Each change through the tool already asks the user to confirm, so a second approval for the same call adds no protection. The tool refuses `mode: ask` for this toolset, the screen skips ask in its cycle, and a stored ask value loads as on.

## Layers

1. State. One JSON file holds the toolsets, the scope, the paths, and the sandboxes.
2. Classification. The classifier returns the enabled toolsets that match a tool name.
3. Gate. The gate is a pure function. It reads the state, the tool name, the input, and the project directory, and it returns a decision.
4. Approval. Ask mode requires a model reason and an exact-call approval. Unknown tools keep their separate question.
5. Sandbox. The bash tool wrapper starts the command inside the operating-system boundary.
6. Tool. The `permissions` tool reads the state and changes it after the user agrees.
7. Screen. The `/permissions` command opens a small screen for the same state. The main view holds toolsets, sandboxes, and scope. Custom Paths under Scope opens the path submenu. The pattern view shows one toolset: each pattern with the tool names that it matches, and the keys to edit, add, and delete a pattern.

## Call flow

1. The model calls a tool.
2. Pi sends the call to the `tool_call` handler.
3. The gate blocks paths outside the scope before any approval. The `permissions` tool is the exception: its `path` argument names a directory to allow, so the tool checks that directory and asks the user before it saves the change.
4. The classifier collects the on and ask toolsets that match. On takes priority over ask.
5. If only off toolsets match, the gate blocks without a dialog. Ask calls pause inside the gate until the user answers.
6. The bash wrapper adds the sandbox command. A missing backend blocks the call.
7. The tool starts.

## Ask approval

The AI explains its action and reason before the target call. The gate opens the dialog for that waiting call.
Approval resumes the same call. Refusal blocks it. The dialog shows field labels in bold.
The input preview shows at most four terminal rows. A longer input appears as `[...]`, but approval covers its full value.
Bash commands use syntax colors. The enable choice names the affected toolsets.
The user can allow once, deny, deny with an explanation, or allow and enable the matching ask toolsets.

One approval permits one call with the exact approved input. Object key order does not affect matching.
Repeated gate events for the same call reuse its approval. A tool result removes that call authorization.
Local state changes and session boundaries clear pending approvals. Each target still passes the path gate and the shell sandbox.

The approval channel remains available when the `permissions` toolset is off. It cannot approve a target that matches only off toolsets.
Without an interactive dialog, the extension denies approval. Denial feedback returns to the AI as tool output.
In RPC mode, `ctx.ui.custom` exists but returns `undefined`, so the approval uses `ctx.ui.select`. The full-screen dialog runs only when `ctx.mode` is `tui`, because the screen component needs a terminal.

## Reporting a waiting question

Herdr shows the pane as blocked and notifies the user while an agent waits for an answer. Its Pi integration reads one event on the Pi event bus: `herdr:blocked` with `{ active: true, label }` opens a block, and `{ active: false }` closes one. Herdr counts the open blocks.

Pi already announces each blocking extension dialog. It publishes `ui_prompt_start` and `ui_prompt_end` around `ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.input()`, `ctx.ui.editor()`, and `ctx.ui.custom()`. `src/notify.ts` follows those events, so one place reports the approval dialog, the unknown-tool question, the `permissions` confirmations, and a dialog that the isolated executor forwards from the sandbox. The outer process shows a forwarded dialog in its own window, so that dialog also raises the outer prompt events.

Pi opens one span for a group of nested dialogs. The reporter therefore tracks one open block, so Herdr sees one opening for one closing.

A prompt that the user starts is not a question for the user. The `/permissions` command runs inside `suppressPrompts`, so browsing the screen reports nothing, and the suppressed end consumes no block. The check counts the screens that are open, because the start event arrives on a microtask.

A shutdown with a dialog still open emits one closing event, so a pane never stays blocked. A missing bus, a throwing listener, and a host without Herdr change nothing: every emit call is guarded, and the dialog never waits for the host.

## The exception list

A tool that must run on the host keeps the host implementation, even while a layer is on. The state file holds the exception list as regular expressions, and the executor tests each pattern against the tool name. A pattern that does not compile matches nothing, so a broken entry never removes the boundary from another tool.

The list belongs to the user alone. The screen opens it from Unsandboxed tools inside Sandboxes, and `set_unsandboxed_tools` keeps it behind a confirmation that names every pattern. The covered tools stay inside the boundary, so the list is the one place where a tool leaves it.

## Subagent sessions

A subagent runs in the same process as its parent, in a child session with its own resource loader. Each session gets its own copy of every extension module, so the copies share no ordinary module state.

Two channels bridge them, both on `globalThis`:

- A session claim. The first copy of the extension to claim a session owns its gate. A later copy that loads into the same session stands down. The claim is per session, not per process, so a child session installs its own gate.
- A child registry and a forwarder per session. A session with a UI registers a forwarder. A child whose ask needs a human looks up its parent and calls that forwarder, which runs the normal dialog in the parent window.

A child has no UI, so `approvals.request` forwards instead of prompting. The reply travels back as a promise across the shared process. A missing parent, a parent without a forwarder, a closed request, and a timeout all fail closed with a reason that the child model reads as tool output.

The registration of the parent events uses `pi.events`, and the child announcement arrives before the child binds, so the child gate exists for its first call.

Pi filters extension tools through the child capability list before it builds the executable registry. `setActiveTools()` cannot restore an excluded tool. This extension leaves that list unchanged.

Before a child run, the extension adds instructions for permission changes when `ask_parent` is active. The child asks its parent for the exact action and ends its turn. The parent calls `permissions` and obtains user consent before it resumes the child. A child question does not authorize a change.

The gate leaves `ask_parent` and `notify_parent` available when the session exposes `ask_parent`. These tools carry questions and progress, not file access. Scope restrictions, disabled toolsets, and normal ask approvals still apply to capability tools.

## The pattern screen

The list view opens the pattern view for one toolset. The pattern view reads the tool names with `pi.getAllTools()`, compiles each pattern with the same flag as the gate, and shows the names that match.

Every edit returns a new list or an error. `appendPattern` refuses a duplicate and a full list, `replacePattern` refuses a duplicate of another entry, and `removePattern` refuses the last entry. A save runs only on a list that `checkPatterns` accepts, so the state file always loads again.

## Decisions

- Deny a tool that no toolset matches, but ask the user first. A silent allow is not safe, and a silent deny stops work.
- Gate state changes through the `permissions` toolset. Keep `request_tool` available only as an approval channel for ask targets. The `/permissions` command runs outside the gate.
- Do not read the `path` argument of the `permissions` tool as a target file path. The gate would block `add_path` before its own dialog, and the scope could never grow. The tool still checks that the directory exists, saves the canonical path, and asks before the change. The `permissions` toolset mode still applies, so an off toolset blocks the change.
- Keep the default patterns in the code and let the state file replace them. A user can tune a shipped toolset without a fork. The state file records the full list, so a pattern edit is saved like a custom toolset.
- Keep the `permissions` toolset in the state file. The screen shows it next to the other toolsets, so the user sees the whole picture.
- Treat bash as one tool. The execute toolset sets the outer limit, and the sandbox sets the inner limit. Command text analysis is fragile, so the extension does not use it.
- Put the sandbox in the kernel. Linux uses bubblewrap or unshare, macOS uses Seatbelt, and native Windows fails closed.
- Keep one state file for each root session. A new session starts from the defaults, a resumed session reads its own file, and a child reads the file of its root. `PI_PERMISSIONS_FILE` pins one file for tests.
- Treat the `permissions` toolset as binary. It is on or off. Ask would ask the user twice for one change, once in the gate and once in the tool dialog.
- Treat a link inside the project as a project path. The project contains the link, so the gate accepts a path through it before link resolution. A direct path to the link target still needs an allowed root. Extra roots keep canonical containment, because the user names those directories explicitly.
- Fail closed. A missing backend or a broken gate blocks the call.
- Follow Pi's prompt events instead of reporting each dialog by hand. Pi already announces every blocking dialog and merges nested ones, so one listener covers the approval dialog, the unknown-tool question, and the change confirmations. A report that the host misses never blocks the dialog.
- Load the extension once per session. A session claim stops a second copy in the same session, and it lets a child session install its own gate.
- Write the state file with a temporary file and a rename. A crash cannot leave half a file.

## Modules

| File | Job |
| --- | --- |
| `src/index.ts` | Wiring: state, gate, question, bash and PowerShell overrides, command, footer |
| `src/types.ts` | Shared types and mode helpers. No runtime imports |
| `src/approval.ts` | Approval dialog and exact-call grants |
| `src/state.ts` | Defaults, repair, load, atomic save, store |
| `src/classify.ts` | Tool name to matching toolsets |
| `src/scope.ts` | Path resolution, containment, directory test |
| `src/sandboxes.ts` | Sandbox descriptors, backend detection, command wrappers |
| `src/gate.ts` | Pure call decision |
| `src/tool.ts` | The `permissions` tool |
| `src/patterns.ts` | Pure edits of a pattern list, and the tool names that a pattern matches |
| `src/ui.ts` | The `/permissions` screen and the pattern editor |
| `src/sessions.ts` | Cross-session registry: session claims, child links, ask forwarding |
| `src/notify.ts` | Reports a waiting question to the terminal host through `herdr:blocked` |

## State

The defaults are the read toolset on, the write toolset off, the execute toolset on, the `permissions` toolset on, project scope, no extra paths, and both sandboxes off. The exception list is empty, so every tool stays inside the boundary.

State version 3 adds custom scope. Project scope exposes only the project root. Custom scope also exposes saved extra paths.

Older project state with extras migrates to custom. Explicit version 3 project state keeps extras inactive without deleting them.

The gate, the isolated executor, and shell backends use the same selected roots. Everywhere turns the filesystem layer off.

`mergeState` accepts unknown JSON and repairs it. It fills missing fields, drops invalid toolsets, restores the four shipped toolsets, and caps the list sizes.

A stored shipped toolset keeps its name and its builtin mark. The file sets the off, on, or ask state and the pattern list, so a user can change the default patterns. `checkPatterns` checks a list in one place, and both the state file and the pattern editor use it. A pattern list that does not load again is never saved. A version 1 file loses its flags and keeps its custom toolsets.

`StateStore.update` reads the file again before it applies a change. Two pi processes can then keep both changes.

The exception list is a list of patterns, and an empty list is valid. `checkPatterns` therefore takes a flag that allows an empty list, and the stored list loads as empty when it does not pass the check.

## Sandbox backends

| Platform | Filesystem layer | Network layer |
| --- | --- | --- |
| Linux | `bwrap --ro-bind / /` | `bwrap --unshare-net`, or `unshare -n` |
| macOS | `sandbox-exec` with `(deny file-write*)` | `sandbox-exec` with `(deny network*)` |
| Windows | Blocked with a message about WSL2 | Blocked with a message about WSL2 |

The backend choice is data. `SandboxTools` carries the program paths, the shell, and the platform. Tests pass a fixed value.

## Tests

Start the suite with `node --test src/`.

The tests cover the classifier, the scope, the state store, the gate, and the sandbox plans. The core tests use only Node.js, so they start without pi.

`src/tool.test.ts` imports the real `tool.ts`. A loader hook replaces the `typebox` and host imports, which the repository does not install. The test then calls the permissions tool with a fake dialog, so the `add_path` consent path runs without pi.

The suite does not import `index.ts` or `ui.ts`, because those files need the pi runtime. A manual start with `pi -e .` covers the wiring, the screen, and a real sandbox call.

## Limits

The path scope covers the usual path arguments of the file tools. The extension does not inspect other arguments.

On Linux, the sandbox covers delegated tool execution, including third-party tools. Extension initialization, hooks, and commands remain on the host.

On macOS, the sandbox covers bash only. Commands that the user types with `!` remain on the host.

The Pi 1.5.2 registry adapter and its limits are described in [Isolated executor](ISOLATED.md#api-integration).

The operating system is the real boundary.

No tool guarantees compliance with ASD-STE100. The official dictionary is free at asd-ste100.org.
