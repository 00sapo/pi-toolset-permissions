# pi-toolset-permissions

An extension for pi that checks each tool call before it runs.

The extension sorts tools into three risk classes: read, write, and execute.
Each class has a flag. A flag set to off blocks every tool in that class.
A path scope limits the directories that tools can reach.
Two optional sandboxes check bash commands for file changes and network access.

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
Press `a` to add a directory. The extension checks that the path is an existing directory.
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

1. No toolset matches the tool name: the call is blocked and the reason asks for a new toolset.
2. The risk flag of the match is off: the call is blocked and the reason names the flag.
3. A read or write call names a path outside the allowed roots: the call is blocked.
4. An execute call can change files while the write flag is off: the call is blocked.
5. An execute call can reach the network while the no-network sandbox is on: the call is blocked.
6. An execute call names a path outside the allowed roots in project scope: the call is blocked.

The `permissions` tool always passes the gate. It asks the user itself.

## Sandboxes

The bash read-only sandbox blocks commands that can change the filesystem.
The list includes `rm`, `mv`, `cp`, `tee`, output redirection, `git commit`, `git push`, package installers, and `sudo`.

The bash no-network sandbox blocks commands that can reach the network.
The list includes `curl`, `wget`, `ssh`, `scp`, `git clone`, `git pull`, `docker pull`, and `gh api`.

While the write flag is off, bash must stay read only, also when the sandbox is off.

## State file

The state lives in one JSON file at `~/.pi/agent/permissions.json`.
Set `PI_PERMISSIONS_FILE` to use another path.
Set `PI_CODING_AGENT_DIR` to move the agent directory.
The extension writes a temporary file and renames it, so a crash cannot leave half a file.
A missing file gives the default state. A corrupt file gives the default state too.

## Limitations

The bash checks are heuristics. They read the command text, not the behavior of the program.
A wrapper script hides its content. A renamed network client escapes the list. A path built at run time escapes the scan.

The operating system is the real boundary.
User accounts, file permissions, containers, and network policy hold a process back.
Use them for work that must stay contained.

The path scope covers the `path` argument of read tools and write tools.
A tool that takes a path in another argument is not checked by the path scope.
Add a custom toolset only for tools that you trust.
