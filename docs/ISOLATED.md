# Isolated executor

On Linux, `src/index.ts` forwards tool execution to a second Pi process inside a bubblewrap sandbox when a layer is on. The inner Pi uses no real model. A local OpenAI-compatible server supplies tool calls, and RPC returns results and supported dialogs.

The executor follows the two sandbox layers of `/permissions`. The filesystem layer has three states: `off` leaves the host tree open, `read` exposes only the project root and the extra paths, and `read+write` also permits writes there. The network layer forbids outbound IP traffic. A process boundary is fixed when the process starts, so each layer combination, and each change to the allowed roots, uses its own process.

The extension picks the boundary by platform. Linux uses this executor. macOS wraps `bash` only. Windows disables the layers. See [the sandboxes](../README.md#the-sandboxes).

## Start Pi

Install Pi 1.5.2, bubblewrap, and Node.js 22.19 or newer on the Linux host. Make sure that `pi`, `bwrap`, and `node` are available through `PATH`.

From this repository, start Pi with the extension:

```sh
pi -e ./src/index.ts
```

`./src/isolated.ts` is the same executor as a standalone entry point, for a test that leaves the normal wiring out.

Pi discovers loaded third-party tool sources automatically. To add extensions only inside the sandbox, supply their paths as a JSON array:

```sh
pi --no-extensions --no-mcp -e ./src/index.ts \
  --inner-extensions '["/absolute/path/to/extension.ts"]'
```

Use `--inner-pi /absolute/path/to/pi` or `--inner-node /absolute/path/to/node` if the executables are absent from `PATH`.

Open `/permissions` in the outer Pi to turn the layers on and off. A change restarts the inner process with the new combination.

The screen names the coverage in one line under the Sandboxes heading. On Linux that line reads `Applies to all tools except exceptions.`

The footer is one dim line, and it names only what is not the default. Every part is a short word.

| Part | Appears when | Example |
|---|---|---|
| filesystem | Always | `fs:read`, `fs:rw`, `fs:off` |
| toolset count | A toolset is off or asks | `4/5 fs:read` |
| network | Connections are forbidden | `fs:off net:off` |
| scope | Not the project root | `fs:read custom`, `fs:read all` |
| `bash` | macOS covers bash only | `fs:read bash` |
| `sb:off` | The platform has no backend | `sb:off` |

While the executor starts, the same line carries a leading state word: `starting`, `ready 12 fs:read`, or `unavailable`.

On macOS the heading reads `Sandboxes (bash ONLY · macOS)` and the coverage line reads `Applies to only bash.` The layer rows carry `[unavailable here]` for a layer that cannot start here. Turning one on asks for confirmation first, because every call then fails until you turn it off.

Windows has no backend, so the whole Sandboxes section is absent there.

Extension initialization and hooks run in the outer Pi with host access. The boundary covers delegated tool execution only. Load only trusted extensions.

The executor loads discovered tool sources again inside the sandbox. Inner initialization and hooks can therefore run a second time. The two copies do not share memory. Host hooks, commands, and background work remain outside the boundary.

A load failure or a missing declaration makes the affected tool unavailable. The executor never grants an exemption automatically. If you trust the tool and need host execution, add an exact-name pattern under Unsandboxed tools in `/permissions`.

An ordinary tool error does not prove incompatibility. Tools that need host credentials, inherited environment variables, or custom terminal components can fail inside the sandbox.

## Follow the sandbox layers

The executor reads the sandbox flags from the same state file as `/permissions`.

| Layers | Result |
|---|---|
| filesystem off, no network off | Host tools answer. No inner process starts. |
| filesystem read | Only the project and the extra paths are readable. Writes there fail. |
| filesystem read+write | The project and the extra paths are readable and writable. |
| no network on | Outbound IP traffic fails in the inner process. |
| filesystem off with no network on | Every host file stays readable and writable, and the network is still blocked. |

When you change a combination, the prototype stops the inner process and starts one that matches the new layers. The tool call that triggers the change waits for the new process. A delegated call never falls back to the host. Explicit unsandboxed patterns retain host execution.

When every layer goes off, the prototype stops the inner process and the host tools answer again.

## Execution

Every host tool name becomes a delegate. With no layer, a delegate calls the host implementation. With a layer on, a delegate sends one tool call to the inner Pi and waits for the result and the `agent_settled` event.

The inner Pi starts in RPC mode with a private agent directory and an in-memory session. It loads no discovered extensions. Discovered source paths and `--inner-extensions` select the extensions that it loads. The relay links the mounted configuration entries into the private agent directory, so the inner Pi finds the rules and the packages that an extension imports. Pi writes its session list and its caches to that private directory, so no host file changes.

The server captures tool declarations from the first model request. RPC preserves the full result, including images, `details`, `structuredContent`, and the error flag. The outer extension forwards supported dialogs and notifications. It does not reproduce custom terminal components.

Calls execute one at a time. The protocol timeout does not run while a forwarded dialog waits for the user. A timeout in the other phases, cancellation, protocol failure, or child failure stops the executor. A later call starts a new process after a failed bridge operation. The prototype never falls back to a host tool while a layer is on.

`/reload` stops the inner process and starts a new one. The layer combination also applies after the reload.

Commands that you type with `!` run on the host. The layers cover the tools that the model calls, as in the normal extension. Do not type a `!` command when you need the layer restrictions to apply.

## Filesystem view

The sandbox starts with an empty root. Only these paths become visible:

| Path | Mode | Why |
|---|---|---|
| `/usr` and the directories that link into it | read-only | Programs and shared libraries. |
| API keys in the environment | absent | Only a fixed list of variables enters the sandbox. |
| Selected `/etc` entries | read-only | Name services, TLS certificates, the loader cache, and the shell profile. |
| A generated `/etc/passwd` and `/etc/group` | generated | One account named `pi`. Host accounts stay outside. |
| Node.js, Pi, and their bin directories | read-only | The inner process. |
| `/run/pi-bin` | symlinks | `node` and `pi` under a sandbox path, so `PATH` names no host directory. |
| `/run/pi-home/tmp` | writable | The temp directory that the inner tools use. It stays writable when a read-only scope binds `/tmp`. |
| The relay file | read-only | The program that connects the inner Pi to the control socket. |
| The working directory | follows the filesystem state | The project root. `read` mounts it read-only, `read+write` mounts it writable. |
| Package roots for discovered and manual extensions | read-only | Source files, sibling imports, and dependencies. |
| The git directory of a worktree | follows the read-only layer | Git needs it, and git writes its index there. |
| `rules`, `agents`, `extensions`, `skills`, `prompts`, `themes`, and `npm` from the Pi agent directory | read-only | Rules, agent definitions, and the packages that an extension imports. |
| `settings.json`, `keybindings.json`, `mcp.json`, `subagents.json`, `model-alias.json`, `APPEND_SYSTEM.md`, `SYSTEM.md`, `AGENTS.md`, `AGENTS.override.md` from the Pi agent directory | read-only | Configuration that a sandboxed tool or extension reads. |
| `~/.gitconfig` and `~/.profile` | read-only | The git identity for a commit, and the shell setup. |
| Every directory on the host `PATH` | read-only | A program that the outer shell finds by name resolves to the same file. An existing directory also joins `PATH`. |
| `/tmp`, `/run`, `/dev`, `/proc`, and the home directory | private and empty | Temporary files, the control socket, devices, processes, and `HOME`. |
| An `/etc` or `/run` path from a project link or a mount | read-only, or writable for a writable mount | One bind puts the needed part back. The rest of the tree stays private. |
| `/proc/sys/kernel/random` | empty | The host boot identifier stays outside. Random data still comes from `/dev/urandom`. |

The agent directory appears twice: at its host path and at `/run/pi-home/.pi/agent`, so an extension that reads `homedir()` finds it too. The git identity and the profile appear the same way, at their host path and below `/run/pi-home`. A PATH directory that a writable root already covers, or one that belongs to the sandbox, is left to that mount. The relay links both into the private agent directory that the inner Pi uses, so `getAgentDir()` returns the mounted entries.

Paths outside these mounts stay outside the view. That includes the rest of your home directory, `~/.ssh`, other projects, `/root`, mounted disks, host Unix sockets, and the host name. The agent directory is mounted entry by entry, so `auth.json`, `models-store.json`, `trust.json`, `sessions`, and `state` stay outside.

The sandbox has its own IPC and host-name namespaces. The host name inside is always `sandbox`. The `PATH` uses `/run/pi-bin`. The `HOME` is `/run/pi-home`.

The runtime files of this extension are mounted read-only at their host paths. When such a path sits inside a writable allowed root, the writable mount wins, so a file under the project stays editable in `read+write` mode. The same file stays read-only in `read` mode.

A program that the outer configuration writes into a command must exist inside the sandbox. The launcher mounts such a program read-only at its host path, and the relay links it into `/run/pi-bin` under the name `hypa`. A rewritten command and a bare `hypa` both resolve when the package `@hypabolic/pi-hypa` is installed. No home directory or credential store is mounted for it. When the package is absent, neither the mount nor the variable appears.

A version manager usually writes a program entry as a symbolic link. The `mise` shims directory holds such links, and several PATH directories on a typical host are links too. bwrap refuses a bind that targets a symbolic link, so the launcher checks each host path between a mount and a nested mount before it writes the arguments. When a link is in between, the nested mount becomes a bind of the file that the link names. The bind is skipped when another mount already shows that file. A link never pulls a system tree into the sandbox.

The restricted states do not make `/tmp`, `/run`, and `/dev` read-only. Those paths belong to the sandbox itself, so a write there changes nothing on the host. A write outside the allowed roots can therefore report success and still leave the host file unchanged.

A protected path reaches the sandbox in one of four ways. The launcher decides the way, and a fatal error never results.

- A path below `/usr`, `/bin`, `/sbin`, `/lib`, or `/lib64` is already visible. The sandbox binds those trees read-only, so no bind is needed and no access is lost.
- A path inside `/etc` or `/run` is reproduced. The sandbox mounts those trees empty. The launcher then binds the path back at its own path. A scope root binds read-only, and a mount that the user marked writable binds writable. The bind restores only that part of the tree. The rest of `/etc` stays private, and so do the control socket, the relay links, and the generated account files.
- A whole private tree, such as `/run` or `/etc`, is left out and reported. A bind there would replace a mount that the sandbox owns.
- A pseudo filesystem path, such as `/proc/self`, is left out and reported. The kernel owns those nodes.

Ordinary work produces these paths without any user action. A virtual environment links its interpreter to `/usr/bin/python3.13`. A package manager links a shim into `/usr`. A project link can name a configuration directory in `/etc`. Each case works. The `.venv` interpreter resolves through the system mount, and a config directory appears through its own bind. The scope keeps a reproducible target instead of dropping it. It does not walk a reproduced directory, because one bind already covers the children. A stored extra path follows the same four rules when the state loads. A dialog refuses a whole private tree before any save, and it names the reason.

With `filesystem off`, `/run` stays private because the bridge socket and the agent directory live there. The rest of the host tree is mounted writable.

## API integration

Pi 1.5.2 returns metadata from `getAllTools`, without executors. The `tool_call` hook can block calls but cannot return replacement results.

The executor adapts the exported `ExtensionRunner.prototype.getAllRegisteredTools` method before Pi creates executable wrappers. Each session uses a private anchor definition to select its own delegates. The wrappers preserve the original definition for layers off and explicit exemptions.

This adapter depends on Pi internals. Future Pi versions need runtime tests. A guard blocks unwrapped tools while a layer is on. SDK custom tools cannot use this adapter and remain blocked unless explicitly exempted.

The inner inventory reports source paths without tool probes. A foreign tool needs a matching source and a declared tool name. A missing foreign override never uses an inner built-in with the same name.

The CLI can exit after an extension load failure. If its diagnostic names an exact requested path, the executor retries without that source. Other tools stay available. Unknown startup errors stop the executor.

Inner-only direct declarations become outer delegates through `registerTool`. They have no host implementation and fail with layers off or an exemption. Hidden and deferred declarations are not promoted. Output schemas and custom rendering do not cross the declaration channel.

## Limits

The network layer with `FORBID CONNECTIONS` removes IP access.

Two relays connect the sandbox to one host Unix socket each. The tool bridge carries scripted model requests for the executor. The model relay serves one fixed model, `sandbox-parent/parent`, from the outer session, so a subagent keeps the outer credentials: no API key enters the sandbox. The same relay answers permission questions from a child session, and the outer gate decides them.

Both relays are local process communication endpoints. The host server accepts only the scripted tool request, a model request from the private provider, and a permission question. It does not forward arbitrary network traffic.

The outer approval gate covers the sandboxed sessions. On Linux `src/index.ts` builds one gate and hands it to the executor, so every tool call needs the same approval that a host call needs, and a child session asks through the same dialog.

The empty root does not remove every path from the host. Your working directory is mounted, so a tool can read every file under it. The selected `/etc` entries are mounted, so a file in one of them is readable.

A symbolic link inside the project can reach only a mounted path. A link to a host path outside the mounts does not resolve. For example, a link to `~/.ssh` fails, and a link to `/etc/passwd` works because that file is mounted.

The kernel version and the hardware names remain visible, because a program cannot run without the kernel interface.

Process IDs are isolated, and `/proc` shows only the sandbox. The inner environment excludes inherited API keys and Node loader variables. `TMPDIR` names the private temp directory, so temp files never reach the host `/tmp`.

The control socket carries HTTP model requests. RPC uses standard input and output. An extension that corrupts those streams can stop the executor. The protocol is not a boundary against forged results from a hostile extension. An extension inside the sandbox already holds the token, so the socket adds no reach to it.

## Portability

The prototype runs on Linux only. It needs bubblewrap 0.8 or newer, unprivileged user namespaces, and Node.js 22.19 or newer. Other platforms fail closed with a message, and no partial mode runs without the sandbox.

These host layouts are supported:

- A merged `/usr`, where `/bin`, `/sbin`, `/lib`, and `/lib64` are symlinks into `/usr`. Debian 12 and 13, and Arch Linux, use this layout.
- A split layout, where those directories are real. The launcher mounts them and creates no symlink.

A missing `/etc` entry is skipped, so a distribution without `/etc/alternatives` or `/etc/terminfo` still starts. Only Debian and its derivatives have `/etc/alternatives`.

The prototype was verified on Debian 13, which uses a merged `/usr`. The launcher tests cover the split layout and a missing `/etc` entry. A full run inside a container was not possible, because the container kernel refused to create the namespaces.

## Tests

Run the normal test suite from this repository:

```sh
npm test
```

To run the real Pi integration tests on a Linux host with bubblewrap, enable the live test flag:

```sh
PI_BRIDGE_LIVE_TEST=1 npm test
```

## Builtin extension tools

The executor explicitly loads `builtin:codemode` and `builtin:tool-search` when their registrations exist in the host.
These identifiers select bundled Pi code, not filesystem mounts. Other `builtin:` values remain invalid launcher inputs.
Inactive tools produce no unavailable warnings. Later activation uses the loaded inner definitions.
Third-party definitions named `codemode` or `tool_search` still require matching filesystem sources.

Codemode scripts and their nested tool calls execute inside the sandbox. Original definitions retain their schemas, preparation hooks, and constrained sampling metadata.
The inner session uses its own tool selection and script store. Search changes the inner selection, not the outer selection.
The executor does not synchronize deferred-tool activation or script stores between sessions. Non-LLM models still require credentials inside the sandbox.
