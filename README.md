# pi-toolset-permissions

_Do you find managing sandboxes and permissions complicated?_

This extension adopts a different modular, on-the-fly approach: you can toggle set of tools and
sandboxes using a simple menu during the session.

You can even tell the AI what it should disable e.g. _"forbid writing on that file"_, or _"run in read-only mode now"_. The exetension provides tool to change the allowed operations.

The AI can ask to change the permissions, but you can even disable that with _"Disable the
permission tool"_

## Main features

- Four toolsets that ship with the extension: read, write, execute, and permission.
- Editable patterns. Press enter on a toolset to see its regular expressions and the tools that they match.
- Custom toolsets that match tool names with regular expressions.
- Two bash sandboxes: a read-only filesystem and no network.
- One path scope for the file tools.
- One `permissions` tool for the model. Each change asks you to agree.
- One question for each tool that no toolset matches.
- One state file for all sessions.

## Concept

A toolset is a group of tool names. You turn the whole group on or off together.

A pattern is a regular expression. The extension tests each pattern against a tool name.

A sandbox is an operating-system boundary for shell commands.

A path scope is the set of directories that file tools can touch. Project scope allows the project directory and the extra paths. Everywhere scope removes the path limit.

The permission toolset holds the `permissions` tool. It is a normal toolset. If you turn it off, the model cannot call that tool, but the `/permissions` command still works. Use the command to turn the toolset back on.

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

Open the settings screen:

```text
/permissions
```

The screen holds one list with four sections: the toolsets, the sandboxes, the scope, and the paths.

```text
 Permissions

 Toolsets
   > read                    [ON] 4 patterns
     write                   [OFF] 4 patterns
     execute                 [ON] 4 patterns
     permission              [ON] 1 pattern

 Sandboxes
     Read-only filesystem    [OFF]
     No network              [OFF]

 Scope
   > All paths               [PROJECT]

 Paths
     /home/user/project  project root

 space toggle · enter patterns · s scope · a add path · d remove path · esc close
```

| Key | Action |
| --- | --- |
| up, down | move the selection |
| space | turn the selected toolset or sandbox on or off, or switch the scope |
| enter | open the patterns of the selected toolset. On a sandbox or the scope, enter does what space does |
| s | switch the scope between project and everywhere |
| a | add a directory to the paths |
| d | remove the selected extra path |
| esc | close the screen, or leave the pattern screen |

Each change is saved at once. The esc key never loses work.

The default state:

| Setting | Default |
| --- | --- |
| Read toolset | on |
| Write toolset | off |
| Execute toolset | on |
| Permission toolset | on |
| Path scope | project |
| Extra paths | none |
| Read-only filesystem sandbox | off |
| No-network sandbox | off |

The write toolset is off at the start. Turn it on before the model can change files with the write and edit tools.

## The toolsets

The extension ships four toolsets. Read tools, write tools, and execute tools hold the usual tool names of pi. The permission toolset holds only the `permissions` tool.

Press space to turn a toolset on or off. A toolset that is off matches no tool.

The permission toolset is on at the start. If you turn it off, the model cannot ask you for a change. Open the screen with `/permissions` and turn the toolset back on. The screen is not a tool, so it always opens.

Ask the assistant to add a toolset. Give the name and the patterns. The dialog shows both before you agree.

Press `d` on a toolset row to delete a custom toolset. A shipped toolset cannot be deleted. You can change the patterns of a shipped toolset, and the state file keeps your change.

When a toolset is off, its patterns match nothing. If no other toolset matches a tool, pi asks you about that tool.

## The patterns

Press enter on a toolset row to open its pattern screen.

```text
 Permissions › read  [ON]
 builtin · 4 of 32 patterns · on, so these tools may run

   > ^(read|ls|find|grep|tool_search)$    read, ls, find, grep
     ^hypa_(read|ls|find|grep)$           hypa_read, hypa_ls, hypa_find, hypa_grep
     ^(read|list|search|get)_             no tool
     _(read|list|grep)$                   hypa_grep

 enter edit · a add · d delete · space toggle · esc back
```

Each row holds one regular expression and the tool names that it matches. The extension tests each pattern against the name of every tool that pi knows, and it ignores case.

The screen uses these keys:

| Key | Action |
| --- | --- |
| space | turn the toolset on or off |
| enter | edit the selected pattern |
| a | add a pattern |
| d | delete the selected pattern |
| esc | go back to the toolset list |

The editor checks each pattern. A pattern must compile as a JavaScript regular expression, must not be empty, and must be 500 characters at most. A toolset holds at least one pattern and at most 32.

The four shipped toolsets start with default patterns. A change to one of them is saved like a custom toolset, and the state file holds the new list. To go back to the default list of one toolset, delete its entry from the state file and reload.

## The paths

The path list starts with the project root. It then holds the extra paths.

Press `a` to add a directory. Type a path. The extension makes sure that the path is an existing directory. Press `d` to remove the selected extra path.

The project root cannot be removed. The extension saves the resolved path, so a symlink cannot add a larger tree than the dialog shows.

## The sandboxes

The screen lists two sandboxes.

Press space to turn the selected sandbox on or off. The change applies to the next bash call.

A sandbox starts the bash call inside an operating-system boundary. It does not read the command text.

The read-only filesystem sandbox makes the filesystem read-only. Every write fails, including writes to `/tmp`.

- On Linux, the sandbox uses `bwrap` from bubblewrap with a read-only bind of the root.
- On macOS, the sandbox uses `sandbox-exec` with a Seatbelt profile. The profile denies `file-write*` and allows writes to the standard devices only.

The no-network sandbox removes network access. Name resolution also fails.

- On Linux, the sandbox uses a separate network namespace. It needs `bwrap`, or `unshare` from util-linux.
- On macOS, the Seatbelt profile adds `(deny network*)`.

You can turn on both sandboxes at once.

If a program that a sandbox needs is missing, the bash call fails with a message. The call never starts without the sandbox.

A sandbox does not change a toolset, and a toolset does not change a sandbox. Turn on the read-only sandbox when bash must not change files.

Commands that you type with `!` are not sandboxed. A sandbox covers only the shell tools that the model calls.

## The permissions tool

The model uses one tool with eight actions.

| Action | Parameters | Effect |
| --- | --- | --- |
| status | none | show the toolsets, the sandboxes, the scope, and the paths |
| set_scope | scope | set the scope to project or everywhere |
| add_path | path | allow one more directory in project scope |
| remove_path | path | remove one extra directory |
| add_toolset | name, patterns | add a custom toolset |
| remove_toolset | name | delete a custom toolset |
| set_toolset | name, enabled | turn a toolset on or off |
| set_sandbox | sandbox, enabled | turn a sandbox on or off |

The `status` action only reads. The other seven actions ask you to agree before they change the state.

The model can turn off the permission toolset, because it is a normal toolset. If the model turns it off, the model cannot call the tool again in that session. Run `/permissions` to turn it back on.

`set_toolset` changes the on/off state of a toolset. The model cannot change a pattern with the tool. You change a pattern on the screen, where the list of matches shows the effect at once.

You can tell the assistant what you want in your own words. Examples:

- "Allow the write toolset." The model calls `set_toolset`.
- "Enlarge the scope to ../shared." The model calls `add_path`.
- "Turn on the no-network sandbox." The model calls `set_sandbox`.

## Unknown tools

A tool that no toolset matches is blocked. Pi then asks you one question with three answers:

- Allow once: the call starts, and the state does not change.
- Always allow: the extension adds a toolset for the exact tool name, then the call starts.
- Block: the call does not start.

Without a dialog, the call is blocked.

## State file

The state lives in one file: `~/.pi/agent/permissions.json`.

The file is plain JSON with two-space indentation and a final newline. It holds the toolsets, their patterns, the scope, the paths, and the sandboxes. It also holds your changes to the shipped toolsets, so it is the only file that you need to keep.

The extension never writes the current time or another value that changes by itself. You can track the file in git and read a diff before you commit it.

- `PI_PERMISSIONS_FILE` sets another path for the file.
- `PI_CODING_AGENT_DIR` moves the agent directory.

The extension writes a temporary file and renames it. A crash cannot leave half a file.

A missing file gives the default state. A corrupt file gives the default state too.

A file from version 1 still loads. The extension drops the old flags, keeps the custom toolsets, and writes the default patterns for the shipped toolsets.

## Limits

The path scope covers the usual path arguments of the file tools. A tool that takes a path in another argument is not covered. Add a custom toolset only for tools that you trust.

Native Windows has no sandbox backend, so the shell tools block the call while a sandbox is on. Start pi inside WSL2, or turn the sandbox off.

Seatbelt is deprecated by Apple but still present on current macOS versions. If `sandbox-exec` is missing, the call fails with a message.

A sandbox limits the process tree that a shell tool starts. It does not limit pi, other tools, or commands that you type with `!`.

The operating system is the real boundary. User accounts, containers, and network policy hold a process back even when the extension is wrong.

No tool guarantees compliance with ASD-STE100. The official dictionary is free at asd-ste100.org.
