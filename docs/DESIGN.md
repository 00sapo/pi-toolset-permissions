# Design

This document describes the design of the extension. It explains the layers, the decisions, and the module boundaries.

## Terms

A toolset is a group of tool names with one state: off, on, or ask. A pattern is a regular expression that the extension tests against a tool name.

A path scope is the set of directories that file tools can touch. A sandbox is an operating-system boundary for shell commands.

The `permissions` toolset holds the `permissions` tool. Off blocks state changes but preserves the approval channel for ask tools.

## Layers

1. State. One JSON file holds the toolsets, the scope, the paths, and the sandboxes.
2. Classification. The classifier returns the enabled toolsets that match a tool name.
3. Gate. The gate is a pure function. It reads the state, the tool name, the input, and the project directory, and it returns a decision.
4. Approval. Ask mode requires a model reason and an exact-call approval. Unknown tools keep their separate question.
5. Sandbox. The bash tool wrapper starts the command inside the operating-system boundary.
6. Tool. The `permissions` tool reads the state and changes it after the user agrees.
7. Screen. The `/permissions` command opens a small screen for the same state. The screen has two views. The list view holds the toolsets, the sandboxes, the scope, and the paths. The pattern view shows one toolset: each pattern with the tool names that it matches, and the keys to edit, add, and delete a pattern.

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
- Keep one state file for all sessions. Permission state is not conversation state.
- Save the canonical path when the user adds a directory. A symlink cannot add a larger tree than the dialog shows.
- Fail closed. A missing backend or a broken gate blocks the call.
- Load the extension once. A global marker stops a second copy after `pi install` and `-e`. The shutdown handler clears the marker, so `/reload` works.
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

## State

The defaults are the read toolset on, the write toolset off, the execute toolset on, the `permissions` toolset on, project scope, no extra paths, and both sandboxes off.

`mergeState` accepts unknown JSON and repairs it. It fills missing fields, drops invalid toolsets, restores the four shipped toolsets, and caps the list sizes.

A stored shipped toolset keeps its name and its builtin mark. The file sets the off, on, or ask state and the pattern list, so a user can change the default patterns. `checkPatterns` checks a list in one place, and both the state file and the pattern editor use it. A pattern list that does not load again is never saved. A version 1 file loses its flags and keeps its custom toolsets.

`StateStore.update` reads the file again before it applies a change. Two pi processes can then keep both changes.

## Sandbox backends

| Platform | Read-only filesystem | No network |
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

The sandbox covers the shell tools. It does not cover pi, the file tools, other extensions, or commands that the user types with `!`.

The operating system is the real boundary.

No tool guarantees compliance with ASD-STE100. The official dictionary is free at asd-ste100.org.
