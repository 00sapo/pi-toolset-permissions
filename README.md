# pi-toolset-permissions

<p align="center">
  <img src="docs/preview.png" alt="The /permissions screen: the toolsets with their pattern counts, the sandboxes, the path scope, and the paths" width="760">
</p>

_Do you find managing sandboxes and permissions complicated?_

This extension adopts a different modular, on-the-fly approach: you can toggle sets of tools and
sandboxes using a simple menu during the session.

You can even tell the AI what it should disable e.g. _"forbid writing on that file"_, or _"run in read-only mode now"_. The extension provides a tool to modify the list of allowed toolsets.

The AI can request state changes when the `permissions` toolset is on. Turn that toolset off to block these requests.

## Install

```text
pi install npm:pi-toolset-permissions
```

Try it for one session without saving it:

```text
pi -e npm:pi-toolset-permissions
```

To load a local copy, use `pi install /path/to/pi-toolset-permissions`, or start the file itself with `pi -e /path/to/pi-toolset-permissions/src/index.ts`.

Then open the screen with `/permissions`.

An installed copy reloads with `/reload`. A session that starts with `pi -e` reads the file at startup, so start pi again after an edit.

On Linux, this extension delegates tool execution to a sandboxed Pi process, so every tool runs inside the boundary. It needs `bubblewrap` and unprivileged user namespaces. On macOS it wraps `bash` only, through the built-in `sandbox-exec`. On Windows no backend exists, and the screen says to start Pi inside WSL2. [Isolated executor](docs/ISOLATED.md) describes the boundary.

## Main features

- Four toolsets that ship with the extension: read, write, execute, and permissions.
- Editable patterns. Press enter on a toolset to see its regular expressions and the tools that they match.
- Custom toolsets that match tool names with regular expressions.
- The most powerful sandbox out there, capable of intercepting *any* tool, even third-party tools.
- Two sandbox layers: a filesystem layer with off, read, and read+write states, and a no-network layer.
- An exception list for tools that must run on the host while a layer is on.
- One path scope for the file tools.
- One `permissions` tool for the model. Each change asks you to agree.
- One question for each tool that no toolset matches.
- One state file for all sessions.
- Support for the Herdr view of agent state.

## Concept

A toolset is a group of tool names. Each toolset has one state: off, on, or ask.

A pattern is a regular expression. The extension tests each pattern against a tool name.

A sandbox is an operating-system boundary for shell commands.

A path scope is the set of directories that file tools can touch. PROJECT ONLY exposes only the project root. CUSTOM PATHS exposes the project root plus saved extra paths. EVERYWHERE removes the path limit.

PROJECT ONLY keeps saved extra paths but does not expose them. Scope also selects the roots for the filesystem sandbox.

The `permissions` toolset holds the `permissions` tool. Off blocks state changes through that tool, but still permits approval requests for ask tools.
The `/permissions` command always works. Use that command to turn the toolset back on.

The `permissions` toolset has only the on and off states. It does not accept ask, because every change through the tool already asks you to confirm. `set_toolset` refuses `mode: ask` for this toolset, and a stored ask value loads as on.

Bash is one tool. Its patterns sit in the execute toolset. The sandbox is a second layer. It starts the whole call inside the boundary, and it does not read the command text.

The model changes the state with the `permissions` tool. The tool asks you to agree before each change. Without a dialog, the tool cannot change the state.

## Use

Open the settings screen:

```text
/permissions
```

The main screen groups toolsets, sandboxes, and scope. Custom Paths opens a path submenu inside Scope.

```text
 Permissions

 Toolsets
   > read                    [ON] 4 patterns
     write                   [OFF] 4 patterns
     execute                 [ON] 4 patterns
     permissions             [ON] 1 pattern

 Sandboxes (ALL tools · Linux)
     Applies to all tools except unsandboxed tools.
     Filesystem              [OFF]
     No network              [OFF]
     Unsandboxed tools         0 patterns
     Unsandboxed tools run on the host even while a layer is on.

 Scope
     Scope defines the paths exposed to the read and write toolsets and to the sandboxed tools.
   > Modality                [PROJECT ONLY]
     Custom Paths             0 extra paths

 space changes mode · enter opens submenu · s scope · esc close
```

| Key | Action |
| --- | --- |
| up/k, down/j | move the selection |
| space | cycle a toolset through off → on → ask → off, toggle a sandbox, or switch the scope |
| enter/l | open toolset patterns, Unsandboxed tools, or Custom Paths. On a sandbox or Modality, enter acts like space |
| s | cycle PROJECT ONLY → EVERYWHERE → CUSTOM PATHS |
| a | add a directory to the paths |
| d | remove the selected extra path in Custom Paths |
| esc/h | close the screen, or leave a submenu |

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
| Filesystem sandbox | off |
| No-network sandbox | off |
| Unsandboxed tools | none |

The write toolset is off at the start. Turn it on before the model can change files with the write and edit tools.

## The toolsets

The extension ships four toolsets. Read tools, write tools, and execute tools hold the usual tool names of pi. The `permissions` toolset holds only the `permissions` tool.

Press space to cycle a toolset through off → on → ask → off.

| State | Behavior |
| --- | --- |
| off | Block its tools unless another toolset allows them. Do not open an approval dialog. |
| on | Allow its tools without a permission request. |
| ask | Require approval for each exact call. Show the tool, full input, and the AI reason. |

If both on and ask toolsets match, on takes precedence. Path limits and sandboxes still apply after approval.

The `permissions` toolset is the exception. It has only off and on, so it never waits in ask mode.

In ask mode, the AI explains the action and reason, then calls the target tool directly.
The gate pauses that call and shows the approval dialog. If you approve, that same call runs immediately.
The AI does not retry the call or request approval through a separate tool.
Only field labels appear in bold. Bash commands use colored syntax without bold text.
If the input exceeds four terminal rows, the dialog replaces it with `[...]`. The approval still applies to the full input.
Select `Inspect` to read the full input in a scrollable view. Use `j/k`, arrow keys, or Page Up/Page Down.
Press `h` or Escape to return without approval. Bash, read arguments, and edit content use syntax colors.

If an agent provides no specific reason, the dialog states that fact and shows its current task and concrete action.
The enable choice shows the names of the affected toolsets.

The dialog offers four choices:

- Allow once: run the waiting call with its exact input. Keep ask mode.
- Deny: block the call.
- Deny with explanation: block the call and return your explanation to the AI.
- Allow and enable toolset NAME: approve and change the named ask toolsets to on.

Closing the dialog denies the request. Without an interactive dialog, ask calls remain blocked.
The approval channel remains available for ask tools when the `permissions` toolset is off. It cannot enable off tools.

In RPC mode the extension uses a plain select list, because the full-screen dialog needs a terminal. RPC mode defines the full-screen method but returns `undefined`, so the extension checks the run mode first.

The `permissions` toolset is on at the start. If you turn it off, the model cannot request state changes. Open the screen with `/permissions` and turn the toolset back on. The screen is not a tool, so it always opens.

Ask the assistant to add a toolset. Give the name and the patterns. The dialog shows both before you agree.

Press `d` on a toolset row to delete a custom toolset. A shipped toolset cannot be deleted. You can change the patterns of a shipped toolset, and the state file keeps your change.

An off toolset blocks its tools unless another toolset allows them. It never opens the unknown-tool dialog.
If the `permissions` toolset is on, the AI can request activation with `set_toolset`. Each change needs your approval.
Otherwise, use `/permissions` to change an off toolset.

## The patterns

Press enter on a toolset row to open its pattern screen.

```text
 Permissions › read  [ON]
 builtin · 4 of 32 patterns · on, so these tools may run

   > ^(read|ls|find|grep|tool_search)$    read, ls, find, grep
     ^hypa_(read|ls|find|grep)$           hypa_read, hypa_ls, hypa_find, hypa_grep
     ^(read|list|search|get)_             no tool
     _(read|list|grep)$                   hypa_grep

 enter edit · a add · d delete · space off → on → ask · esc back
```

Each row holds one regular expression and the tool names that it matches. The extension tests each pattern against the name of every tool that pi knows, and it ignores case.

The screen uses these keys:

| Key | Action |
| --- | --- |
| space | cycle off → on → ask → off |
| enter/l | edit the selected pattern |
| a | add a pattern |
| d | delete the selected pattern |
| esc/h | go back to the toolset list |

The editor checks each pattern. A pattern must compile as a JavaScript regular expression, must not be empty, and must be 500 characters at most. A toolset holds at least one pattern and at most 32.

The four shipped toolsets start with default patterns. A change to one of them is saved like a custom toolset, and the state file holds the new list. To go back to the default list of one toolset, delete its entry from the state file and reload.

## The paths

Select Custom Paths under Scope to open the path list. The Project root label comes first, followed by its gray path.

The list then shows saved extra paths. Only CUSTOM PATHS exposes them. Adding a new directory selects CUSTOM PATHS and activates all saved extra paths.

Press `a` to add a directory. Type a path. The extension makes sure that the path is an existing directory. Press `d` to remove the selected extra path in Custom Paths.

The project root cannot be removed. The extension saves the resolved path, so a symlink cannot add a larger tree than the dialog shows.

A link inside the project counts as a project path. Reading or writing through that link is allowed even when the target is outside the project, because the project contains the link. A direct path to the target stays blocked unless an extra path covers it. For an extra path, the extension resolves the link and blocks a target outside that root.

## The sandboxes

The screen lists two sandboxes. The first line of the section states the tool coverage. On macOS it reads `Applies to only bash.` and on Linux it reads `Applies to all tools except unsandboxed tools.` Windows has no backend, so the section does not appear there.

Press space to turn the selected sandbox on or off.

The sandbox means a different thing on each system.

| System | Entry point | What the sandbox covers |
|---|---|---|
| Linux | This extension, which uses the isolated executor | Every tool. No tool runs on the host while a layer is on. |
| macOS | This extension | `bash` only. Turn every other toolset off, because the other tools run on the host. |
| Windows | None | Nothing. The layers are disabled, and the screen shows no Sandboxes section. |

On Linux the extension hands the tool set to the isolated executor in `docs/ISOLATED.md`. That executor runs every tool in a separate Pi process inside a bubblewrap sandbox. It needs `bwrap`.

On macOS the extension wraps `bash` with `sandbox-exec`. The other tools are not covered, so the screen asks for confirmation before a layer starts.

On Windows a layer that a saved file still holds is turned off at startup, so a shell call never fails because of a stale setting.

A sandbox does not read the command text.

### The filesystem layer

The Filesystem layer limits which directories a tool can reach. It has three states.

| State | Read | Write |
|---|---|---|
| `off` | everywhere | everywhere, the host included |
| `read` | the roots selected by Scope | nowhere outside the sandbox itself |
| `read+write` | the roots selected by Scope | the roots selected by Scope |

The project root is the working directory. CUSTOM PATHS also exposes the directories saved in the Custom Paths submenu. PROJECT ONLY excludes those extra directories. Nothing else outside those roots is readable.

The layer supports PROJECT ONLY and CUSTOM PATHS. EVERYWHERE turns the layer off and disables its row.

Pi keeps a small set of runtime paths in every state: its own agent directory, its private temporary directory, the programs that run it, and the system directories that programs read. Those paths stay writable where Pi needs them, so a session and its configuration keep working.

The rules, the agent definitions, the extensions, the skills, the prompts, the themes, and the npm packages of the Pi agent directory are readable inside the sandbox. So are the settings, the subagent settings, the model aliases, and the system prompt files. Each entry is mounted read-only, because an extension that runs inside the sandbox reads them. The saved credentials, the model store, the trust file, the sessions, and the state directory stay outside.

A write outside the roots can report success inside the sandbox and still never reach the host. Make sure that the host file is the one you check.

The no-network sandbox removes network access. Name resolution also fails.

You can turn on both sandboxes at once.

If a program that a sandbox needs is missing, the tool call fails with a message. The call never starts without the sandbox.

A sandbox does not change a toolset, and a toolset does not change a sandbox. Set the filesystem layer to `read` when a tool must not change files.

Commands that you type with `!` are not sandboxed. A sandbox covers only the tools that the model calls.

### The exception list

Some tools cannot run inside the sandbox. An extension that reads a host socket is one example. The Unsandboxed tools row inside Sandboxes holds regular expressions for these tools, and a matching tool keeps the host implementation while a layer is on.

Press enter on the row to open the list. It uses the same keys as a toolset pattern list: `a` adds, `enter` edits, `d` deletes, and `esc` goes back. A row shows the pattern and the tool names that it matches. A pattern that does not compile matches nothing, and the list may be empty.

The list is the one place where a tool leaves the boundary. The model can set it with `set_unsandboxed_tools`, and that change asks you first and names every pattern.

## The permissions tool

The model uses one tool with ten actions.

| Action | Parameters | Effect |
| --- | --- | --- |
| status | none | show the toolsets, the sandboxes, the scope, and the paths |
| request_tool | tool, input, reason | request approval for one exact call in ask mode |
| set_scope | scope | set the scope to project, everywhere, or custom |
| add_path | path | add a directory and select custom scope |
| remove_path | path | remove one extra directory |
| add_toolset | name, patterns | add a custom toolset |
| remove_toolset | name | delete a custom toolset |
| set_toolset | name, mode | set a toolset to off, on, or ask |
| set_sandbox | sandbox, mode or enabled | set the filesystem state, or turn the no-network layer on or off |
| set_unsandboxed_tools | patterns | replace the exception list |

The `status` action only reads. State changes and `request_tool` require your approval.

The model can request that you turn off the `permissions` toolset. After approval, only ask-mode approval requests remain available through the tool.
Run `/permissions` to turn the `permissions` toolset back on.

`set_toolset` accepts `mode`: `off`, `on`, or `ask`. Existing callers can still use boolean `enabled` for on and off. The model cannot change a pattern with the tool. You change a pattern on the screen, where the list of matches shows the effect at once.

You can tell the assistant what you want in your own words. Examples:

- "Allow the write toolset." The model calls `set_toolset`.
- "Enlarge the scope to ../shared." The model calls `add_path`.
- "Turn on the no-network sandbox." The model calls `set_sandbox`.

## Subagents

A child session that runs in the same process gets its own gate. The toolsets, the path scope, and the sandboxes apply to the child exactly as they apply to you.

The extension claims a session, not a process. A second copy of the extension that loads into the same session stands down, so one session never has two gates.

A child has no interface of its own. When a child call needs approval, the request goes to the window of the session that started the child. The dialog names the asking agent, so you always know which child waits. Your answer resumes that one call. A refusal blocks it. If the parent cannot answer, the child call fails closed.

A child keeps the tool list from its agent file. This extension does not force `permissions` into that list.

If a child needs a permission change, it calls `ask_parent` with the action, exact path or toolset, and purpose. The child then ends its turn. The parent calls `permissions`, waits for your consent, and resumes the child with the result. The child retries only after approval. A refusal stops that operation.

`ask_parent` and `notify_parent` remain available as communication tools. Neither grants file access nor changes permission state. Normal child calls in ask mode still wait for approval through the parent interface.

## Unknown tools

A tool that no toolset matches is blocked. Pi then asks you one question with three answers:

- Allow once: the call starts, and the state does not change.
- Always allow: the extension adds a toolset for the exact tool name, then the call starts.
- Block: the call does not start.

Without a dialog, the call is blocked.

## State file

The state lives in one file: `~/.pi/agent/permissions.json`.

The file is plain JSON with two-space indentation and a final newline. A toolset stores `enabled` as `false`, `true`, or `"ask"`. It holds the toolsets, their patterns, the scope, the paths, and the sandboxes. It also holds your changes to the shipped toolsets, so it is the only file that you need to keep.

The extension never writes the current time or another value that changes by itself. You can track the file in git and read a diff before you commit it.

- `PI_PERMISSIONS_FILE` sets another path for the file.
- `PI_CODING_AGENT_DIR` moves the agent directory.

The extension writes a temporary file and renames it. A crash cannot leave half a file.

A missing file gives the default state. A corrupt file gives the default state too.

The old toolset name `permission` loads as `permissions` without changes to its mode or patterns.
If both names exist, the `permissions` entry takes precedence.

State version 3 distinguishes project-only access from custom access. Older project scope with extra paths loads as custom without changes to access.

A file from version 1 still loads. The extension drops the old flags, keeps the custom toolsets, and writes the default patterns for the shipped toolsets.

## Waiting questions

While a dialog waits for your answer, the extension reports the block to Herdr. The pane shows the agent as blocked, and Herdr notifies you. The dialog is the approval question, the unknown-tool question, or a change that the model requested. Browsing `/permissions` reports nothing, because you started that screen.

Without Herdr the report changes nothing. A host that ignores the event never holds a dialog back.

## Limits

The path scope covers the usual path arguments of the file tools. A tool that takes a path in another argument is not covered. Add a custom toolset only for tools that you trust.

The `permissions` tool is not a file tool. Its `path` argument names a directory to allow, so the gate does not test it against the current scope. The tool checks that the directory exists and asks for your approval before it saves the change. If the `permissions` toolset is off, the change is blocked.

Native Windows has no sandbox backend, so the shell tools block the call while a sandbox is on. Start pi inside WSL2, or turn the sandbox off.

Seatbelt is deprecated by Apple but still present on current macOS versions. If `sandbox-exec` is missing, the call fails with a message.

A sandbox limits the process tree that a shell tool starts. It does not limit pi, other tools, or commands that you type with `!`.

The operating system is the real boundary. User accounts, containers, and network policy hold a process back even when the extension is wrong.

No tool guarantees compliance with ASD-STE100. The official dictionary is free at asd-ste100.org.

## License

GPL-3.0-only. Copyright (C) 2026 00sapo. The full text is in [LICENSE](LICENSE).
