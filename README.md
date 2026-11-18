# pi-toolset-permissions

<p align="center">
  <img src="docs/preview.png" alt="The /permissions screen: the toolsets with their pattern counts, the sandboxes, the path scope, and the paths" width="760">
</p>

_Do you find managing sandboxes and permissions complicated?_

This extension adopts a different modular, on-the-fly approach: you can toggle sets of tools and
sandboxes using a simple menu during the session.

You can even tell the AI what it should disable e.g. _"forbid writing on that file"_, or _"run in read-only mode now"_. The extension provides a tool to modify the list of allowed toolsets.

The AI can request state changes when the `permissions` toolset is on. Turn that toolset off to block these requests.

**Bonus**: The sandbox layer used in this extansion is able to intercept *any* tool, even
third-party extensions.

## Install

```text
pi install npm:pi-toolset-permissions
```

Try it for one session without saving it:

```text
pi -e npm:pi-toolset-permissions
```

Then open the screen with `/permissions`.

On Linux, this extension delegates tool execution to a sandboxed Pi process, so every tool runs inside the boundary. On macOS it wraps `bash` only. On Windows no backend exists, and the screen says to start Pi inside WSL2. [Isolated executor](docs/ISOLATED.md) describes the boundary.

## Main features

- Four toolsets that ship with the extension: read, write, execute, and permissions.
- Editable patterns. Press enter on a toolset to see its regular expressions and the tools that they match.
- Custom toolsets that match tool names with regular expressions.
- The most powerful sandbox out there, capable of intercepting *any* tool, even third-party tools.
- Two sandbox layers: a filesystem layer with off, read, and read+write states, and a no-network layer.
- One path scope for the file tools.
- One `permissions` tool for the model. Each change asks you to agree.
- One question for each tool that no toolset matches.
- One state file for all sessions.
- Support for herdr view of agent state.

## Concept

A toolset is a group of tool names. Each toolset has one state: off, on, or ask.

A pattern is a regular expression. The extension tests each pattern against a tool name.

A sandbox is an operating-system boundary for shell commands.

A path scope is the set of directories that file tools can touch. Project scope allows the project directory and the extra paths. Everywhere scope removes the path limit.

The `permissions` toolset holds the `permissions` tool. Off blocks state changes through that tool, but still permits approval requests for ask tools.
The `/permissions` command always works. Use that command to turn the toolset back on.

The `permissions` toolset has only the on and off states. It does not accept ask, because every change through the tool already asks you to confirm. `set_toolset` refuses `mode: ask` for this toolset, and a stored ask value loads as on.

Bash is one tool. Its patterns sit in the execute toolset. The sandbox is a second layer. It starts the whole call inside the boundary, and it does not read the command text.

The model changes the state with the `permissions` tool. The tool asks you to agree before each change. Without a dialog, the tool cannot change the state.

## Install

Install the package from a local path:

```sh
pi install /path/to/pi-toolset-permissions
```

Or load the extension for one session:

```sh
pi -e /path/to/pi-toolset-permissions/src/index.ts
```

An installed copy reloads with `/reload`. A session that starts with `pi -e` reads the file at startup, so start pi again after an edit.

The read-only sandbox needs `bubblewrap` on Linux. macOS uses the built-in `sandbox-exec`. Native Windows has no backend. Start pi inside WSL2 to use the Linux backend.

## Use

Open the settings screen with `/permissions`.

The screen has the toolsets, the sandboxes, the scope, and the paths.

| Key | Action |
| space | change the state of a toolset, a sandbox, or the scope |
| enter | open the patterns of the selected toolset |
| s | switch the scope between project and everywhere |
| a | add a directory to the paths |
| d | remove a directory or a custom toolset |
| esc | close the screen |

The extension saves each change at once.

A toolset has three states.

- off: its tools do not run.
- on: its tools run.
- ask: its tools run after you agree.

The write toolset is off at the start. Turn it on before the model writes a file.

The Filesystem sandbox limits the directories that the tools reach. It is off, read, or read+write. The No network sandbox blocks network access. On Linux the sandbox limits every tool. On macOS it limits `bash` only.

You can also tell the model what you want, for example "turn on the write toolset". The model calls the `permissions` tool, and each change asks you to agree. Turn the `permissions` toolset off to block that tool. The `/permissions` command always works.

A tool that no toolset matches does not run. Pi asks you one question about it.

Your settings live in `~/.pi/agent/permissions.json`. A missing or corrupt file gives the default settings.

## License

GPL-3.0-only. Copyright (C) 2026 00sapo. The full text is in [LICENSE](LICENSE).
