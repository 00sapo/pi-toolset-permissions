# pi-toolset-permissions

_Do you find managing sandboxes and permissions complicated?_

This extension adopts a different modular, on-the-fly approach: you can toggle set of tools and
sandboxes using a simple menu during the session.

You can even tell the AI what it should disable e.g. _"forbid writing on that file"_, or _"run in read-only mode now"_. The exetension provides tool to change the allowed operations.

The AI can ask to change the permissions, but you can even disable that with _"Disable the
permission tool"_

## Main features

- Three permission flags: read, write, and execute.
- A path scope for the file tools.
- Two sandboxes for shell commands: a read-only filesystem, and no network.
- Custom toolsets that match tool names with regular expressions.
- One `permissions` tool for the model. Each change asks you to agree.
- A question for each tool that no toolset matches.
- One state file for all sessions.

## Concept

A sandbox is an operating-system boundary for shell commands.

A risk class is one of three groups: read, write, or execute. The extension puts each tool in one risk class.

A toolset is a group of tool names that share one risk class. The extension ships three toolsets, one for each risk class. You can add a toolset with your own patterns.

A flag allows or blocks each risk class. If the write flag is off, pi blocks every write tool.

A path scope is the set of directories that file tools can touch. Project scope allows the project directory and the extra paths. Everywhere scope removes the path limit.

Bash is the only tool in the execute class. The execute flag allows or blocks every bash call. The sandbox is a second layer that starts the whole call inside the boundary. The sandbox does not read the command text.

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

The read-only sandbox needs bubblewrap on Linux. macOS uses the built-in `sandbox-exec`. Native Windows has no backend. Start pi inside WSL2 to use the Linux backend.

## Use

Open the settings screen:

```text
/permissions
```

The screen shows the flags, the scope, and three pages:

```text
 Permissions

   Read            [ON]
   Write           [OFF]
   Execute         [ON]
   Scope           [PROJECT]
   Paths (1)          >
   Toolsets (3)       >
   Sandboxes (0)      >

 space/enter toggle · s scope · p paths · t toolsets · b sandboxes · esc close
```

| Key | Action |
| --- | --- |
| up, down | move the selection |
| space, enter | change the selected row, or open its page |
| s | switch the scope between project and everywhere |
| p | open the paths page |
| t | open the toolsets page |
| b | open the sandboxes page |
| esc | go back to the main page, or close the screen |

Each change is saved at once. The esc key never loses work.

The default state:

| Setting | Default |
| --- | --- |
| Read tools | on |
| Write tools | off |
| Execute tools | on |
| Path scope | project |
| Extra paths | none |
| Read-only filesystem sandbox | off |
| No-network sandbox | off |

The write flag is off at the start. Turn it on before the model can change files with the write and edit tools.

## The paths page

The page lists the project root and the extra paths.

Press `a` to add a directory. Type a path. The extension makes sure that the path is an existing directory. Press `d` to remove the selected extra path.

The project root cannot be removed. The extension saves the resolved path, so a symlink cannot add a larger tree than the dialog shows.

## The toolsets page

The page lists the three builtin toolsets and the custom toolsets. The builtin toolsets are read-only.

Press space to turn a custom toolset on or off. Press `d` to delete a custom toolset.

Ask the assistant to add a toolset. Give the name, the risk class, and the patterns.

When a custom toolset is off, its patterns match nothing. If no other toolset matches the tool, pi asks you about the tool.

## The sandboxes page

The page lists two sandboxes.

Press space to turn the selected sandbox on or off. The change applies to the next bash call.

## The permissions tool

The model uses one tool with nine actions.

| Action | Parameters | Effect |
| --- | --- | --- |
| status | none | show the flags, the scope, the paths, the toolsets, and the sandboxes |
| set_flag | flag, enabled | turn the read, write, or execute flag on or off |
| set_scope | scope | set the scope to project or everywhere |
| add_path | path | allow one more directory in project scope |
| remove_path | path | remove one extra directory |
| add_toolset | name, risk, patterns | add a custom toolset |
| remove_toolset | name | delete a custom toolset |
| set_toolset | name, enabled | turn a custom toolset on or off |
| set_sandbox | sandbox, enabled | turn a sandbox on or off |

The `status` action only reads. The other eight actions ask you to agree before they change the state.

You can tell the assistant what you want in your own words. Examples:

- "Allow write tools." The model calls `set_flag`.
- "Enlarge the scope to ../shared." The model calls `add_path`.
- "Turn on the no-network sandbox." The model calls `set_sandbox`.

## Unknown tools

A tool that no toolset matches is blocked. Pi then asks you one question with three answers:

- Allow once: the call starts, and the state does not change.
- Always allow: the extension adds a toolset for the exact tool name, then the call starts.
- Block: the call does not start.

A tool with `readOnlyHint` joins the read class. Every other tool joins the execute class. Without a dialog, the call is blocked.

## Sandboxes

A sandbox starts the bash call inside an operating-system boundary. It does not read the command text.

The read-only filesystem sandbox makes the filesystem read-only. Every write fails, including writes to `/tmp`.

- On Linux, the sandbox uses `bwrap` from bubblewrap with a read-only bind of the root.
- On macOS, the sandbox uses `sandbox-exec` with a Seatbelt profile. The profile denies `file-write*` and allows writes to the standard devices only.

The no-network sandbox removes network access. Name resolution also fails.

- On Linux, the sandbox uses a separate network namespace. It needs `bwrap`, or `unshare` from util-linux.
- On macOS, the Seatbelt profile adds `(deny network*)`.

You can turn on both sandboxes at once.

If a program that a sandbox needs is missing, the bash call fails with a message. The call never starts without the sandbox.

A sandbox does not change the flags, and a flag does not change a sandbox. Turn on the read-only sandbox when bash must not change files.

Commands that you type with `!` are not sandboxed. A sandbox covers only the shell tools that the model calls.

## State file

The state lives in one file: `~/.pi/agent/permissions.json`.

- `PI_PERMISSIONS_FILE` sets another path for the file.
- `PI_CODING_AGENT_DIR` moves the agent directory.

The extension writes a temporary file and renames it. A crash cannot leave half a file.

A missing file gives the default state. A corrupt file gives the default state too.

## Limits

The path scope covers the usual path arguments of the file tools. A tool that takes a path in another argument is not covered. Add a custom toolset only for tools that you trust.

Native Windows has no sandbox backend, so the shell tools block the call while a sandbox is on. Start pi inside WSL2, or turn the sandbox off.

Seatbelt is deprecated by Apple but still present on current macOS versions. If `sandbox-exec` is missing, the call fails with a message.

A sandbox limits the process tree that a shell tool starts. It does not limit pi, other tools, or commands that you type with `!`.

The operating system is the real boundary. User accounts, containers, and network policy hold a process back even when the extension is wrong.

No tool guarantees compliance with ASD-STE100. The official dictionary is free at asd-ste100.org.
