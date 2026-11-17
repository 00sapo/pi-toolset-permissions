# pi-toolset-permissions

An extension for pi that checks each tool call before it runs.

The extension sorts tools into three risk classes: read, write, and execute.
Each class has a flag. A flag set to off blocks every tool in that class.
A path scope limits the directories that tools can reach.
Two optional sandboxes run bash inside an operating-system boundary: a read-only filesystem view, and a separate network namespace.

## Install

Run pi with the extension:

```sh
pi install /path/to/pi-toolset-permissions
```

Or load the extension for one run:

```sh
pi -e /path/to/pi-toolset-permissions/src/index.ts
```

After you edit the code of an installed copy, run `/reload` in pi.
A run started with `pi -e` reads the file when pi starts, so restart pi instead.
Run `/permissions` to open the settings screen.

The read-only sandbox needs bubblewrap (`bwrap`). The no-network sandbox also accepts `unshare` from util-linux.

## Default state

| Setting | Default |
| --- | --- |
| Read tools | on |
| Write tools | off |
| Execute tools | on |
| Path scope | project |
| Extra paths | none |
| Bash read-only | off |
| Bash no-network | off |

Project scope allows the project directory and the extra paths.
The scope `everywhere` removes the path check.

Three builtin toolsets ship with the extension. A toolset maps tool names to a risk class.
A custom toolset maps more names to a risk class.

The footer shows a short status line, for example `read:on write:off exec:on project`.

## The settings screen

Run `/permissions`. The main page shows the three flags, the scope, and three pages.

| Key | Action |
| --- | --- |
| up, down | move the selection |
| space, enter | toggle the selected row, or open its page |
| s | switch the scope between project and everywhere |
| p | open the paths page |
| t | open the toolsets page |
| b | open the sandboxes page |
| esc | return to the main page, or close the screen |

The paths page lists the project root and the extra paths.
Press `a` to add a directory. The extension checks that the path is an existing directory, and it stores the resolved path, so a symlink cannot widen the scope more than the dialog shows.
Press `d` to remove the selected extra path. The project root cannot be removed.

The toolsets page lists the three builtin toolsets, marked `builtin`, and the custom toolsets.
The builtin toolsets are read only.
Press space to turn a custom toolset on or off, and `d` to delete it.
Ask the assistant to add a toolset, with its name patterns and its risk class.

The sandboxes page lists the two sandboxes with a short description.
Press space to toggle the selected sandbox.

Every change is saved at once, so esc loses no work.

## The permissions tool

The model reads and changes the same settings with the `permissions` tool.
Every change opens a confirmation dialog. The message names the state before and after the change.
A declined dialog changes nothing.

| Action | Parameters | Effect |
| --- | --- | --- |
| status | none | print the flags, the scope, the paths, the toolsets, and the sandboxes |
| set_flag | flag, enabled | turn the read, write, or execute flag on or off |
| set_scope | scope | set the scope to project or everywhere |
| add_path | path | allow one more directory in project scope |
| remove_path | path | remove one extra directory |
| add_toolset | name, risk, patterns | add a custom toolset |
| remove_toolset | name | delete a custom toolset |
| set_toolset | name, enabled | turn a custom toolset on or off |
| set_sandbox | sandbox, enabled | turn a bash sandbox on or off |

The `status` action only reads. The other eight actions change the state.
The extension refuses a change when the session has no dialog interface, for example with `pi -p` or in JSON mode.

## How the gate decides

1. No toolset matches the tool name: the call is blocked, and the user is asked to allow it once, always, or never. "Always" adds a toolset that matches the exact tool name. The risk class is read for a tool that declares `readOnlyHint`, and execute for every other tool.
2. The risk flag of the match is off: the call is blocked and the reason names the flag.
3. A read or write call names a path outside the allowed roots: the call is blocked.

Bash is one tool. The execute flag allows or blocks it as a whole.
The sandboxes do not read the command. They run the whole bash call inside an operating-system boundary.
The gate reads the `path`, `file_path`, `file`, `paths`, and `files` arguments of file tools.
A read or write tool with no path argument passes the path scope check.

A session without a dialog interface blocks an unknown tool. The reason names the tool.

The `permissions` tool always passes the gate. It asks the user itself.

## Sandboxes

The read-only filesystem sandbox runs every bash command with the root directory bound read-only.
The kernel rejects any write, including writes to `/tmp`, so no command text is checked.
The sandbox needs `bwrap` from bubblewrap.

The no-network sandbox runs every bash command in a separate network namespace.
Every network operation fails, including name resolution.
It needs `bwrap` from bubblewrap, or `unshare` from util-linux as a fallback for the network isolation alone.

Both sandboxes can be on at once.
When the program that a sandbox needs is missing, the bash call fails with a clear message. It never runs unsandboxed.
A sandbox works on its own: the write flag does not change it, and it does not change the write flag.

Commands that you type yourself with `!` are not sandboxed. The sandboxes apply to the `bash` tool that the model calls.

## State file

The state lives in one JSON file at `~/.pi/agent/permissions.json`.
Set `PI_PERMISSIONS_FILE` to use another path.
Set `PI_CODING_AGENT_DIR` to move the agent directory.
The extension writes a temporary file and renames it, so a crash cannot leave half a file.
A missing file gives the default state. A corrupt file gives the default state too.

## Limitations

The sandboxes use Linux namespaces. The read-only sandbox needs bubblewrap.
On macOS, bubblewrap is not available through the usual package managers, so the sandboxes fail with a message. Use a container for that case.

A sandbox limits the process tree that the `bash` tool starts. It does not limit pi itself, other tools, or commands that you type with `!`.
The operating system is the real boundary. User accounts, containers, and network policy hold a process back even when the extension is wrong.

A command that changes files through a server or a device outside the filesystem can still have an effect. The read-only sandbox covers the filesystem, not every device.

The path scope covers the usual path arguments of read tools and write tools.
A tool that takes a path in another argument is not checked by the path scope.
Add a custom toolset only for tools that you trust.
