# Design

This document describes the design of the extension. It explains the layers, the decisions, and the module boundaries.

## Terms

A toolset is a group of tool names that share one risk class. A risk class is read, write, or execute.

A path scope is the set of directories that file tools can touch. A sandbox is an operating-system boundary for shell commands.

## Layers

1. State. One JSON file holds the flags, the scope, the paths, the toolsets, and the sandboxes.
2. Classification. The classifier maps a tool name to a risk class with the toolset patterns.
3. Gate. The gate is a pure function. It reads the state, the tool name, the input, and the project directory, and it returns a decision.
4. Question. When no toolset matches, the wiring asks the user to allow the call once, allow it always, or block it.
5. Sandbox. The bash tool wrapper starts the command inside the operating-system boundary.
6. Tool. The `permissions` tool reads the state and changes it after the user agrees.
7. Screen. The `/permissions` command opens a small screen for the same state.

## Call flow

1. The model calls a tool.
2. Pi sends the call to the `tool_call` handler.
3. The gate classifies the tool name.
4. If no toolset matches, the extension asks the user. A refusal blocks the call.
5. If the risk flag is off, the gate blocks the call.
6. If a file tool names a path outside the scope, the gate blocks the call.
7. The bash wrapper adds the sandbox command. A missing backend blocks the call.
8. The tool starts.

## Decisions

- Deny a tool that no toolset matches, but ask the user first. A silent allow is not safe, and a silent deny stops work.
- Treat bash as one tool. The execute flag sets the outer limit, and the sandbox sets the inner limit. Command text analysis is fragile, so the extension does not use it.
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
| `src/types.ts` | Shared types. No runtime imports |
| `src/state.ts` | Defaults, repair, load, atomic save, store |
| `src/classify.ts` | Tool name to risk class |
| `src/scope.ts` | Path resolution, containment, directory test |
| `src/sandboxes.ts` | Sandbox descriptors, backend detection, command wrappers |
| `src/gate.ts` | Pure call decision |
| `src/tool.ts` | The `permissions` tool |
| `src/ui.ts` | The `/permissions` screen |

## State

The defaults are read on, write off, execute on, project scope, no extra paths, and both sandboxes off.

`mergeState` accepts unknown JSON and repairs it. It fills missing fields, drops invalid toolsets, restores the three builtin toolsets, and caps the list sizes.

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

The suite does not import `index.ts`, `tool.ts`, or `ui.ts`, because those files need the pi runtime. A manual start with `pi -e .` covers the wiring, the screen, and a real sandbox call.

## Limits

The path scope covers the usual path arguments of the file tools. The extension does not inspect other arguments.

The sandbox covers the shell tools. It does not cover pi, the file tools, other extensions, or commands that the user types with `!`.

The operating system is the real boundary.

No tool guarantees compliance with ASD-STE100. The official dictionary is free at asd-ste100.org.
