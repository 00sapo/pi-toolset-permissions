# pi-toolset-permissions: implementation spec

Extension for pi that gates tool calls by risk class (read, write, execute), by path
scope, and by optional bash sandboxes. The user controls it with `/permissions` (TUI) or
by asking the model, which uses a `permissions` tool that requires user confirmation.

## Revision: bash as one tool

After the first version, two rules changed. Bash is one execute tool: the execute flag
allows or blocks every bash call, and the path scope applies only to file tools. The
sandboxes are the second layer that looks inside the command line, and they work on their
own, independent of the write flag. A tool that matches no toolset is still blocked by the
gate, but pi now asks the user to allow it once, allow it always, or block it. "Always"
adds a toolset for the exact tool name.

The rest of this document describes the first version and stays as the design record.
Where it mentions a bash path scan, a write check tied to the write flag, or a plain
denial for unknown tools, the revision above replaces it.

Contracts are in `src/types.ts` (already written). Entry point is `src/index.ts`.
No runtime dependencies. Imports allowed: `typebox` (only), `node:*`, and `import type`
from `@earendil-works/pi-coding-agent`. Node 26 strips types, so tests run with
`node --test src/`.

## Module list

- `src/state.ts` — defaults, validation/merge, load, atomic save, `StateStore`.
- `src/classify.ts` — tool name to risk class via toolsets.
- `src/scope.ts` — path normalization and containment.
- `src/sandboxes.ts` — sandbox descriptors and command checks.
- `src/gate.ts` — pure `evaluateCall` decision used by the `tool_call` handler.
- `src/tool.ts` — registers the `permissions` tool.
- `src/ui.ts` — `/permissions` TUI screen.
- `src/index.ts` — wiring: state load, `tool_call` gate, command, status footer.
- Tests next to modules: `*.test.ts`.

## state.ts

```ts
export function defaultState(): PermissionsState;
export function mergeState(raw: unknown): PermissionsState;
export function statePath(): string;
export function loadState(file?: string): PermissionsState;
export function saveState(state: PermissionsState, file?: string): void;
export class StateStore {
  constructor(file?: string);
  get(): PermissionsState;
  update(mutator: (current: PermissionsState) => PermissionsState): PermissionsState;
  onChange(listener: (state: PermissionsState) => void): void;
}
```

Defaults, exactly:

```ts
{
  version: 1,
  flags: { read: true, write: false, execute: true },
  scope: "project",
  extra_paths: [],
  sandboxes: { readonly_bash: false, no_network: false },
  toolsets: [
    { name: "read", risk: "read", builtin: true, enabled: true,
      patterns: ["^(read|ls|find|grep|tool_search)$", "^hypa_(read|ls|find|grep)$",
                 "^(read|list|search|get)_", "_(read|list|grep)$"] },
    { name: "write", risk: "write", builtin: true, enabled: true,
      patterns: ["^(write|edit)$", "^hypa_(write|edit)$",
                 "^(write|edit|patch|apply)_", "_(write|edit|patch)$"] },
    { name: "execute", risk: "execute", builtin: true, enabled: true,
      patterns: ["^(bash|powershell|codemode)$",
                 "^hypa_(shell|bash|exec|run|powershell)$",
                 "^(bash|shell|exec|run|spawn)_", "_(bash|shell|exec)$"] },
  ],
}
```

`mergeState` accepts unknown JSON and returns a valid state: keep recognized fields with
correct types, fill missing fields from defaults, drop invalid custom toolsets (unknown
risk, empty name, empty patterns, patterns that do not compile), clamp `extra_paths` to
absolute strings, drop duplicate toolset names, and always restore the three builtin
toolsets from defaults (never trust stored builtin flags other than `enabled: true`).

File location: `process.env.PI_PERMISSIONS_FILE` if set, else
`join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "permissions.json")`.
`loadState` returns defaults when the file is missing or unparseable. `saveState` creates
the directory and writes atomically: temp file in the same directory, then `rename`.
`StateStore` loads once in the constructor, keeps state in memory, saves on `update`,
and calls listeners after each update.

## classify.ts

```ts
export function classify(toolName: string, toolsets: Toolset[]): Classification | null;
```

- Builtin toolsets always apply. Custom toolsets apply only when `enabled` is true.
- A toolset matches when any pattern matches the whole tool name (unanchored `RegExp`
  test, `i` flag). Users may anchor themselves.
- `risk` is the most severe class among matching toolsets: read < write < execute.
- Return every matching toolset name in state order. Return `null` when nothing matches.
- Invalid patterns are skipped (already dropped by `mergeState`, but stay defensive).

## scope.ts

```ts
export function stripAt(value: string): string;                 // remove one leading "@"
export function resolvePath(cwd: string, value: string): string; // ~ expansion + path.resolve
export function canonicalPath(value: string): string;           // realpath of deepest existing ancestor
export function isInside(root: string, target: string): boolean;
export function isAllowedPath(state: PermissionsState, cwd: string, value: string): boolean;
export function scanBashPaths(command: string, cwd: string): string[];
export function outsidePaths(state: PermissionsState, cwd: string, values: string[]): string[];
```

- `resolvePath` expands a leading `~` or `~/`, then `path.resolve(cwd, value)`.
- `canonicalPath` resolves symlinks: walk up until `realpathSync` succeeds, then join the
  missing tail. Return the absolute input on unexpected errors.
- `isInside(root, target)` compares canonical paths: equal, or target starts with
  `root + path.sep`. Reject when `path.relative` is `..` or absolute.
- `isAllowedPath` returns true for `scope === "everywhere"`, true when the canonical path
  is inside the canonical `cwd` or any `extra_paths` entry, false otherwise.
- `scanBashPaths` returns candidate filesystem paths from a shell command line:
  - split on whitespace and shell separators `; | & ( ) < > \`` and on `=` inside
    `--flag=value`;
  - strip surrounding quotes;
  - skip tokens containing `://`, tokens that look like `VAR=value` with no `/`, and
    flags that do not contain `/` (but keep `--file=/x`);
  - keep tokens containing `/` or starting with `.` or `~`;
  - keep the argument of `cd` and `pushd` even without `/`;
  - resolve each candidate with `resolvePath(cwd, token)` and return unique absolute paths.
- `outsidePaths` filters candidate values to those not allowed by `isAllowedPath`.

## sandboxes.ts

```ts
export interface SandboxInfo {
  key: keyof SandboxFlags;
  label: string;
  description: string;
}
export const SANDBOXES: SandboxInfo[];
export function writeCommandReason(command: string): string | null;
export function networkCommandReason(command: string): string | null;
```

`SANDBOXES` order: `readonly_bash` ("Bash read-only", "Reject bash commands that change
files."), `no_network` ("Bash no-network", "Reject bash commands that can reach the
network.").

`writeCommandReason` returns a short clause such as `"rm can delete files"` when the
command can change the filesystem, else null. Detect at least: `>` / `>>` redirection
outside `/dev/null` and `2>&1`, `tee`, `rm`, `rmdir`, `mv`, `cp`, `dd`, `truncate`,
`touch`, `mkdir`, `chmod`, `chown`, `ln`, `sed -i`, `perl -i`, `vi`/`vim`/`nano`,
`git commit|push|checkout|switch|reset|clean|merge|rebase|stash|apply|tag|add`,
package installers (`npm|pnpm|yarn|bun` with `install|i|add|remove|uninstall|update`,
`pip|pip3|poetry` with `install|add`, `cargo|go` with `install|get`, `apt|apt-get|dnf|
yum|pacman|brew|snap` with `install|remove|update|upgrade`), and `sudo`.

`networkCommandReason` detects at least: `curl`, `wget`, `nc`, `ncat`, `nmap`, `telnet`,
`scp`, `rsync`, `ssh`, `ftp`, `sftp`, `git clone|fetch|pull|push|ls-remote`, package
installers (same list), `docker pull|push|run`, `gh` with `api|clone|repo`.

## gate.ts

```ts
export const PERMISSIONS_TOOL_NAME = "permissions";
export function evaluateCall(
  state: PermissionsState,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): GateDecision;
```

Order:

1. `toolName === PERMISSIONS_TOOL_NAME` → allow. The tool asks the user itself.
2. `classify(toolName, state.toolsets)`:
   - `null` → block with a reason that names the tool, says no toolset matches it, and
     tells the model to ask the user to add a toolset (`permissions` tool,
     `action: "add_toolset"`).
   - risk flag off → block naming the flag and telling the model to ask the user, then
     call the `permissions` tool (`action: "set_flag"`).
3. Path scope. Only when `typeof input.path === "string"` and the risk is read or write.
   Resolve and test with `isAllowedPath`. When outside, block and name the path and the
   allowed roots. Skip when `scope === "everywhere"`.
4. Execute checks, only when the matched risk is execute and `input.command` is a string:
   - Effective read-only bash: `state.sandboxes.readonly_bash || !state.flags.write`.
     If on and `writeCommandReason(command)` is non-null, block with that reason and say
     which switch caused it (write flag off or the sandbox).
   - `state.sandboxes.no_network` and `networkCommandReason(command)` non-null → block.
   - Project scope: `outsidePaths(state, cwd, scanBashPaths(command, cwd))` non-empty →
     block and name the paths. Say in the reason that this check is a heuristic.
5. Allow.

Reasons start with `Blocked: ` and stay under ~240 characters. Tests must assert on
substrings, not full sentences.

No `patch` is returned in this version; keep the field for future sandboxes.

## tool.ts

```ts
export function registerPermissionsTool(
  pi: ExtensionAPI,
  store: StateStore,
  onChanged: (ctx: ExtensionToolContext) => void,
): void;
```

One tool, name `permissions`, `exposure` default, `defaultActive: true`.

```
name: "permissions"
label: "Permissions"
description: "Read or change the tool permissions, path scope, toolsets, and bash sandboxes. Every change asks the user to confirm."
promptSnippet: "Read or change tool permissions, scope, and sandboxes (asks the user to confirm)"
promptGuidelines: [
  "Use permissions with action \"status\" when a tool call is blocked and the reason does not explain why.",
  "Use permissions to request a permission change; the user is asked to confirm, and the change applies only after approval.",
]
```

Schema (typebox): `action` string enum; optional `flag` read|write|execute; `enabled`
boolean; `scope` project|everywhere; `path` string; `name` string; `risk` read|write|execute;
`patterns` array of strings; `sandbox` readonly_bash|no_network.

Actions and behavior (validate first, then confirm, then apply):

- `status`: no confirmation. Returns a compact text report: three flags, scope, extra
  paths, toolsets (name, risk, enabled, pattern count, builtin marker), sandboxes.
- `set_flag`: needs `flag` and `enabled`. Ask as `Title "Allow write tools?"` style
  ("Allow read/write/execute tools?", message with the new state).
- `set_scope`: needs `scope`. Explain that `everywhere` removes the path limit.
- `add_path`: needs `path`; must resolve to an existing directory (use `statSync`), must
  be absolute after `resolvePath(cwd, path)`. Refuse when scope is `everywhere` (explain
  it is not needed). Confirmation names the directory.
- `remove_path`: needs `path`; must match an entry after normalization.
- `add_toolset`: needs `name`, `risk`, `patterns` (at least one, each must compile with
  `new RegExp`). `name` must not collide. Confirmation shows name, risk, patterns.
- `remove_toolset`: needs `name`; builtin toolsets cannot be removed.
- `set_toolset`: needs `name`, `enabled`; builtin toolsets cannot be toggled.
- `set_sandbox`: needs `sandbox`, `enabled`.

If `!ctx.hasUI` and the action mutates, return `isError: true` with
`"Permission changes need an interactive session."` and change nothing. After a change,
call `onChanged(ctx)` and return a text result with the new status.

Confirmation copy: title is the change, message names the exact before → after effect.
Never apply on a declined confirmation; return a normal (not error) result saying the
user declined.

## ui.ts

```ts
export async function openPermissions(store: StateStore, ctx: ExtensionContext): Promise<void>;
```

If `ctx.mode !== "tui"`, print the `status` text with `ctx.ui.notify(text, "info")` and
return. Otherwise open `ctx.ui.custom` with a component written in this file, no
`SettingsList`.

Main page, exactly this shape:

```
 Permissions

   Read            [ON]
   Write           [OFF]
   Execute         [ON]
   Scope           [PROJECT]
   Paths (2)          >
   Toolsets (4)       >
   Sandboxes (1)      >

 space/enter toggle · s scope · p paths · t toolsets · b sandboxes · esc close
```

Keys: `tui.select.up`, `tui.select.down` via `keybindings.matches`; literal `" "` and
`tui.select.confirm` toggle or open; `"s"` cycles scope; `"p"`, `"t"`, `"b"` open pages;
`tui.select.cancel` closes the page or the screen. Apply every change immediately
(`store.update`) so esc never loses work. Use `theme.fg`/`theme.bold` for styling.

Paths page: list `cwd` (marked project root, not removable) and `extra_paths`. `"a"` opens
`ctx.ui.input("Add allowed directory", "/absolute/or/relative/path")` and adds it after
`resolvePath` + directory check; notify on error. `"d"` removes the selected extra path.
Esc returns to the main page. When scope is `everywhere`, show a note that paths are not
used.

Toolsets page: three builtin rows (`read`/`write`/`execute`, marked `builtin`) that are
read-only, then custom rows with `[ON]`/`[OFF]`. Space toggles a custom toolset. `"d"`
deletes a custom toolset. Esc returns. A trailing note says that new toolsets are added by
asking the assistant, with the pattern and risk.

Sandboxes page: each `SANDBOXES` entry with `[ON]`/`[OFF]` and its description. Space
toggles. Esc returns.

The component must expose `invalidate()` and `handleInput(data)`, call
`tui.requestRender()` after input, and return the exact lines for `render(width)`. No
`capturesViewportInput` (not needed for a short list).

## index.ts

```ts
export default function (pi: ExtensionAPI) { ... }
```

- Create one `StateStore`.
- `pi.registerCommand("permissions", { description: "Tool permissions, scope, and sandboxes", handler: (_args, ctx) => openPermissions(store, ctx) })`.
- `registerPermissionsTool(pi, store, publish)`.
- `pi.on("tool_call", ...)`: build `input` as `Record<string, unknown>` from
  `event.input`; call `evaluateCall(store.get(), event.toolName, input, ctx.cwd)`; on
  block return `{ block: true, reason }`; on patch assign `event.input.path = patch.path`.
- `publish(ctx)`: set footer status `permissions: read:on write:off exec:on project` with
  `ctx.ui.setStatus("permissions", text)`. Call on `session_start` (after reloading state
  with `store.reload()` if you add it, or a fresh `loadState`) and after every change.
- `pi.on("session_shutdown", ...)`: clear the status with `ctx.ui.setStatus("permissions", undefined)`.
- Do not throw from handlers. Wrap store saves in try/catch and notify on failure.

Status text format, exactly: `read:on write:off exec:on project`.

## Tests (node:test)

Cover at least:

- classify: every shipped name (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`,
  `powershell`, `codemode`, `tool_search`, `hypa_read`, `hypa_shell`) gets the right
  risk; unknown name returns null; severity max wins; disabled custom toolset is skipped;
  custom toolset reclassifies an extension name.
- state: defaults match the sketch (read on, write off, execute on, project); merge
  repairs garbage; invalid regex dropped; duplicate names dropped; builtins restored;
  save/load round trip in a temp dir; missing file gives defaults.
- scope: relative paths; `~`; `@` prefix; `..` escape blocked; symlink escape blocked
  (create a symlink in a temp dir); extra path allowed; everywhere allows any path;
  scanBashPaths finds `/etc/passwd`, `../x`, `--file=/x`, `cd ..`, and skips URLs.
- gate: read blocked when read off; write blocked when write off; execute blocked when
  execute off; unknown tool blocked; permissions tool always allowed; path outside scope
  blocked; extra path allowed; bash `cat /etc/passwd` blocked in project scope and allowed
  in everywhere; `echo hi > f` blocked while write is off; allowed when write is on and
  the sandbox is off; blocked when the sandbox is on; `curl` blocked only with no_network.
- sandboxes: representative positives and negatives for both lists, including
  `2>&1`, `> /dev/null`, and a plain `ls -la`.

Write the tests to pass with the implementation. Keep them deterministic; use
`mkdtempSync(join(tmpdir(), "pi-perm-"))` and clean up with `rmSync(..., { recursive: true, force: true })`.

## Style

Tabs for indentation, `strict` TypeScript, no `any` unless parsing unknown JSON, short
functions, no classes beyond `StateStore`. Comments only where the behavior is not
obvious. README.md in the repo root: what it does, install (`pi -e ./src/index.ts` or the
project-local loader), the default state, the tool actions, the sandboxes, and the
limitations (bash checks are heuristics; the real boundary is the OS).
