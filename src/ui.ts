/** The `/permissions` screen: toolsets, their patterns, the sandboxes, the scope, and the paths. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { SANDBOXES } from "./sandboxes.ts";
import type { SandboxInfo } from "./sandboxes.ts";
import { canonicalPath, resolveDirectory } from "./scope.ts";
import { appendPattern, matchingNames, removePattern, replacePattern } from "./patterns.ts";
import { MAX_EXTRA_PATHS, MAX_TOOLSET_PATTERNS, type StateStore, checkPatterns } from "./state.ts";
import { statusText } from "./status.ts";
import { sandboxMenuNote, sandboxRowMark, sandboxSectionTitle } from "./sandbox-scope.ts";
import { layersEnabled, platformPolicy, requiresBashOnly } from "./platform.ts";
import type { SandboxTarget } from "./sandbox-scope.ts";
import type { PermissionsState, FilesystemMode, Toolset } from "./types.ts";
import { allowsAsk, networkLabel, nextToolsetMode, toolsetMode, scopeLabel } from "./types.ts";

type Row =
	| { kind: "toolset"; toolset: Toolset }
	| { kind: "sandbox"; info: SandboxInfo }
	| { kind: "exceptions" }
	| { kind: "scope" }
	| { kind: "paths" }
	| { kind: "path"; path: string; root: boolean };

type View = { kind: "main" } | { kind: "patterns"; name: string } | { kind: "exceptions" } | { kind: "paths" };

const SECTION: Record<Row["kind"], string> = {
	toolset: "Toolsets",
	sandbox: "Sandboxes",
	exceptions: "Sandboxes",
	scope: "Scope",
	path: "Custom Paths",
	paths: "Scope",
};

const LABEL_WIDTH = 24;

const NO_MATCH = "no tool";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function clip(value: string, width: number): string {
	if (width <= 1 || value.length <= width) return value;
	return `${value.slice(0, width - 1)}…`;
}

/**
 * The `/permissions` screen. `toolNames` is the list of tools that pi knows, so the
 * pattern screen can show the tool names that each pattern matches.
 */
export async function openPermissions(
	store: StateStore,
	ctx: ExtensionContext,
	toolNames: string[] = [],
	target: SandboxTarget = "bash",
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(statusText(store.get(), target, platform), "info");
		return;
	}

	await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
		let view: View = { kind: "main" };
		let index = 0;
		let patternIndex = 0;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		// Windows and other systems without a backend show no Sandboxes section at all.
		const sandboxesEnabled = layersEnabled(platformPolicy(platform));

		const invalidate = (): void => {
			cachedWidth = undefined;
			cachedLines = undefined;
		};
		const refresh = (): void => {
			invalidate();
			tui.requestRender();
		};
		const notify = (text: string, type: "info" | "warning" | "error" = "info"): void => {
			ctx.ui.notify(text, type);
		};

		const update = (change: (current: PermissionsState) => PermissionsState): void => {
			try {
				store.update(change);
			} catch (error) {
				notify(`The change was not saved: ${messageOf(error)}`, "error");
			}
		};

		const onOff = (value: boolean): string => (value ? theme.fg("success", "[ON]") : theme.fg("muted", "[OFF]"));

		const filesystemMode = (mode: FilesystemMode): string => mode === "off"
			? theme.fg("muted", "[OFF]") : theme.fg("success", `[${mode.toUpperCase()}]`);

		const networkMode = (forbid: boolean): string => theme.fg(forbid ? "warning" : "success", `[${networkLabel(forbid)}]`);

		const modeLabel = (toolset: Toolset): string => toolset.enabled === "ask"
			? theme.fg("warning", "[ASK]") : onOff(toolset.enabled);

		const toolsetByName = (name: string): Toolset | undefined =>
			store.get().toolsets.find((entry) => entry.name === name);

		const buildRows = (state: PermissionsState): Row[] => {
			const rows: Row[] = state.toolsets.map((toolset) => ({ kind: "toolset", toolset }));
			// Windows and other systems without a backend hide the whole Sandboxes section.
			if (sandboxesEnabled) {
				for (const info of SANDBOXES) rows.push({ kind: "sandbox", info });
				rows.push({ kind: "exceptions" });
			}
			rows.push({ kind: "scope" });
			rows.push({ kind: "paths" });
			return rows;
		};

		const rowText = (state: PermissionsState, item: Row, selected: boolean, width: number): string => {
			const marker = selected ? theme.fg("accent", ">") : " ";
			const labelWidth = Math.max(8, Math.min(LABEL_WIDTH, width - 8));
			switch (item.kind) {
				case "toolset": {
					const name = clip(item.toolset.name, labelWidth).padEnd(labelWidth);
					const note = theme.fg("dim", ` ${item.toolset.patterns.length} pattern${item.toolset.patterns.length === 1 ? "" : "s"}`);
					return `   ${marker} ${name}${modeLabel(item.toolset)}${note}`;
				}
				case "sandbox": {
					const name = clip(item.info.label, labelWidth).padEnd(labelWidth);
					const shown = item.info.key === "filesystem" && state.scope === "everywhere"
						? theme.fg("warning", " [disabled: requires project or custom scope]")
						: sandboxRowMark(target, platform);
					const mode = item.info.key === "filesystem"
						? filesystemMode(state.sandboxes.filesystem) : networkMode(state.sandboxes.no_network);
					return `   ${marker} ${name}${mode}${shown}`;
				}
				case "exceptions": {
					const count = state.unsandboxed_tools.length;
					const note = theme.fg("dim", ` ${count} pattern${count === 1 ? "" : "s"}`);
					return `   ${marker} ${"Unsandboxed tools".padEnd(labelWidth)}${note}`;
				}
				case "scope":
					return `   ${marker} ${"Modality".padEnd(labelWidth)}[${scopeLabel(state.scope)}]`;
				case "paths":
					return `   ${marker} ${"Custom Paths".padEnd(labelWidth)}${theme.fg("dim", ` ${state.extra_paths.length} extra paths`)}`;
				case "path": {
					return item.root
						? `   ${marker} Project root  ${theme.fg("dim", item.path)}`
						: `   ${marker} ${item.path}`;
				}
			}
		};

		const renderMain = (state: PermissionsState, width: number): string[] => {
			const rows = buildRows(state);
			const lines = [` ${theme.bold("Permissions")}`, ""];
			let section: string | null = null;
			rows.forEach((item, position) => {
				const title = (item.kind === "sandbox" || item.kind === "exceptions") ? sandboxSectionTitle(platform) : SECTION[item.kind];
				if (title !== section) {
					section = title;
					if (position > 0) lines.push("");
					lines.push(` ${theme.bold(title)}`);
					// The tool coverage sits under the title, before the layer rows.
					if (item.kind === "sandbox") {
						for (const note of sandboxMenuNote(target, platform)) lines.push(theme.fg("dim", `     ${note}`));
					}
				}
				if (item.kind === "scope") {
					lines.push(theme.fg("dim", "     Scope defines the paths exposed to the read and write toolsets and to the sandboxed tools."));
				}
				lines.push(rowText(state, item, position === index, width));
				const next = rows[position + 1];
				if (item.kind === "sandbox" && (next === undefined || next.kind !== "sandbox")) {
					if (state.scope === "everywhere") lines.push(theme.fg("dim", "     Filesystem is disabled. Select project or custom scope to use it."));
				}
				if (item.kind === "exceptions") {
					lines.push(theme.fg("dim", "     Unsandboxed tools run on the host even while a layer is on."));
				}
			});
			lines.push(
				"",
				theme.fg("dim", " Toolsets: OFF blocked · ON no request · ASK approve each call"),
				theme.fg("dim", " The permissions toolset has only OFF and ON."),
				theme.fg("dim", " If several toolsets match, ON takes priority over ASK and OFF."),
				theme.fg("dim", " j/k move · l enter · h back · space off → on → ask"),
				theme.fg("dim", " s scope · enter Custom Paths to manage paths"),
			);
			return lines;
		};

		const renderPatterns = (state: PermissionsState, width: number): string[] => {
			if (view.kind !== "patterns") return renderMain(state, width);
			const name = view.name;
			const toolset = state.toolsets.find((entry) => entry.name === name);
			if (toolset === undefined) {
				view = { kind: "main" };
				return renderMain(state, width);
			}

			const inner = Math.max(20, width - 7);
			const patternWidth = Math.max(12, Math.min(60, Math.floor(inner * 0.55)));
			const matchWidth = Math.max(8, inner - patternWidth - 2);
			const kind = toolset.builtin ? "builtin" : "custom";

			const lines = [
				` ${theme.bold("Permissions")} ${theme.fg("dim", "›")} ${theme.bold(clip(toolset.name, Math.max(8, width - 24)))}  ${modeLabel(toolset)}`,
				theme.fg(
					"dim",
					` ${kind} · ${toolset.patterns.length} of ${MAX_TOOLSET_PATTERNS} patterns · ${toolsetMode(toolset.enabled)}: ${toolset.enabled === "ask" ? "approve each call after its action and reason" : toolset.enabled ? "no permission request" : "blocked unless another toolset allows them"}`,
				),
				"",
			];

			toolset.patterns.forEach((pattern, position) => {
				const marker = position === patternIndex ? theme.fg("accent", ">") : " ";
				const shown = clip(pattern, patternWidth).padEnd(patternWidth);
				const names = matchingNames(pattern, toolNames);
				const matches = theme.fg("dim", clip(names.length === 0 ? NO_MATCH : names.join(", "), matchWidth));
				lines.push(`   ${marker} ${shown}  ${matches}`);
			});

			lines.push("", theme.fg("dim", " j/k move · l/enter edit · h/esc back · a add · d delete · space off → on → ask"));
			if (!allowsAsk(toolset.name)) {
				lines.push(theme.fg("dim", " This toolset has only off and on. Space switches between them."));
			}
			return lines;
		};

		const renderScreen = (state: PermissionsState, width: number): string[] =>
			view.kind === "patterns" ? renderPatterns(state, width)
				: view.kind === "exceptions" ? renderExceptions(state, width)
					: view.kind === "paths" ? renderPaths(state, width) : renderMain(state, width);

		/** The exception list. Same keys and layout as a toolset pattern list. */
		const renderExceptions = (state: PermissionsState, width: number): string[] => {
			const patterns = state.unsandboxed_tools;
			const inner = Math.max(20, width - 7);
			const patternWidth = Math.max(12, Math.min(60, Math.floor(inner * 0.55)));
			const matchWidth = Math.max(8, inner - patternWidth - 2);
			const lines = [
				` ${theme.bold("Permissions")} ${theme.fg("dim", "›")} ${theme.bold("Unsandboxed tools")}`,
				theme.fg("dim", ` ${patterns.length} of ${MAX_TOOLSET_PATTERNS} patterns · a matching tool runs on the host`),
				"",
			];
			if (patterns.length === 0) lines.push(theme.fg("dim", "   No exception. Every tool stays inside the sandbox."));
			patterns.forEach((pattern, position) => {
				const marker = position === patternIndex ? theme.fg("accent", ">") : " ";
				const shown = clip(pattern, patternWidth).padEnd(patternWidth);
				const names = matchingNames(pattern, toolNames);
				const matches = theme.fg("dim", clip(names.length === 0 ? NO_MATCH : names.join(", "), matchWidth));
				lines.push(`   ${marker} ${shown}  ${matches}`);
			});
			lines.push("", theme.fg("dim", " j/k move · l/enter edit · h/esc back · a add · d delete"));
			return lines;
		};

		const pathRows = (state: PermissionsState): Extract<Row, { kind: "path" }>[] =>
			[ctx.cwd, ...state.extra_paths].map((path, position) => ({ kind: "path", path, root: position === 0 }));

		const renderPaths = (state: PermissionsState, width: number): string[] => [
			` ${theme.bold("Permissions")} ${theme.fg("dim", "›")} ${theme.bold("Custom Paths")}`,
			theme.fg("dim", "     Custom scope exposes the project root plus these extra paths."),
			"",
			...pathRows(state).map((item, position) => rowText(state, item, position === patternIndex, width)),
			"",
			theme.fg("dim", " j/k move · a add · d remove · h/esc back"),
		];

		const cycleScope = (): void => {
			update((current) => ({ ...current, scope: current.scope === "project" ? "everywhere" : current.scope === "everywhere" ? "custom" : "project" }));
		};

		const toggleToolset = (toolset: Toolset): void => {
			update((current) => ({
				...current,
				toolsets: current.toolsets.map((entry) =>
					entry.name === toolset.name ? { ...entry, enabled: nextToolsetMode(entry.enabled, entry.name) } : entry,
				),
			}));
		};

		const toggleSandbox = async (info: SandboxInfo): Promise<void> => {
			const policy = platformPolicy(platform);
			// Windows has no backend. The switch stays off and the note names the fix.
			if (!layersEnabled(policy)) {
				notify(policy.reason ?? policy.coverage, "warning");
				refresh();
				return;
			}
			if (info.key === "filesystem" && store.get().scope === "everywhere") {
				notify("Filesystem requires project or custom scope. Select project or custom scope first.", "warning");
				refresh();
				return;
			}
			// macOS covers bash only. A layer that wraps one tool must not look like full coverage.
			if (requiresBashOnly(policy)) {
				const proceed = await ctx.ui.confirm(
					"Sandbox covers bash only",
					`${policy.coverage}\n\n${policy.reason ?? ""}\n\nTurn the layer on?`.trim(),
				);
				if (proceed !== true) {
					refresh();
					return;
				}
			}
			update((current) => ({
				...current,
				sandboxes: info.key === "filesystem"
					? { ...current.sandboxes, filesystem: current.sandboxes.filesystem === "off" ? "read"
						: current.sandboxes.filesystem === "read" ? "read+write" : "off" }
					: { ...current.sandboxes, no_network: !current.sandboxes.no_network },
			}));
		};

		const addPath = async (): Promise<void> => {
			if (store.get().extra_paths.length >= MAX_EXTRA_PATHS) {
				notify(`The list already holds ${MAX_EXTRA_PATHS} extra paths. Remove one first.`, "warning");
				refresh();
				return;
			}
			const value = await ctx.ui.input("Add allowed directory", "/absolute/or/relative/path");
			if (value === undefined) return;
			const checked = resolveDirectory(ctx.cwd, value);
			if ("error" in checked) {
				notify(checked.error, "error");
				refresh();
				return;
			}
			const target = checked.path;
			const state = store.get();
			if (canonicalPath(ctx.cwd) === target || state.extra_paths.some((entry) => canonicalPath(entry) === target)) {
				notify(`${target} is already saved or is the project root.`, "warning");
				refresh();
				return;
			}
			if (state.scope !== "custom" && state.extra_paths.length > 0) {
				const proceed = await ctx.ui.confirm(
					"Select CUSTOM PATHS?",
					"Adding this directory selects CUSTOM PATHS. The project root and all saved extra paths become allowed.",
				);
				if (proceed !== true) { refresh(); return; }
			}
			let added = false;
			update((current) => {
				if (canonicalPath(ctx.cwd) === target || current.extra_paths.some((entry) => canonicalPath(entry) === target)) return current;
				added = true;
				return { ...current, scope: "custom", extra_paths: [...current.extra_paths, target] };
			});
			notify(added ? `Added ${target}.` : `${target} is already allowed.`, added ? "info" : "warning");
			refresh();
		};

		const removePath = (path: string): void => {
			update((current) => ({ ...current, extra_paths: current.extra_paths.filter((entry) => entry !== path) }));
			refresh();
		};

		/** Saves a new pattern list. The state file holds the list, so it must load again. */
		const savePatterns = (name: string, next: string[]): boolean => {
			const checked = checkPatterns(next);
			if ("error" in checked) {
				notify(checked.error, "error");
				return false;
			}
			const patterns = checked.patterns;
			try {
				store.update((current) => ({
					...current,
					toolsets: current.toolsets.map((entry) =>
						entry.name === name ? { ...entry, patterns } : entry,
					),
				}));
			} catch (error) {
				notify(`The change was not saved: ${messageOf(error)}`, "error");
				return false;
			}
			return true;
		};

		const addPattern = async (name: string): Promise<void> => {
			const before = toolsetByName(name);
			if (before === undefined) return;
			if (before.patterns.length >= MAX_TOOLSET_PATTERNS) {
				notify(`The toolset already holds ${MAX_TOOLSET_PATTERNS} patterns. Delete one first.`, "warning");
				refresh();
				return;
			}
			const value = await ctx.ui.input(`Add a pattern for ${name}`, "^my_tool$");
			if (value === undefined) return;
			const toolset = toolsetByName(name);
			if (toolset === undefined) return;
			const result = appendPattern(toolset.patterns, value);
			if ("error" in result) {
				notify(result.error, "error");
				refresh();
				return;
			}
			if (savePatterns(name, result.patterns)) patternIndex = result.patterns.length - 1;
			refresh();
		};

		const editPattern = async (name: string, position: number): Promise<void> => {
			const before = toolsetByName(name);
			const old = before?.patterns[position];
			if (old === undefined) return;
			const value = await ctx.ui.editor(`Edit a pattern for ${name}`, old);
			if (value === undefined) return;
			const toolset = toolsetByName(name);
			if (toolset === undefined) return;
			const result = replacePattern(toolset.patterns, position, value);
			if ("error" in result) {
				notify(result.error, "error");
				refresh();
				return;
			}
			savePatterns(name, result.patterns);
			refresh();
		};

		const deletePattern = (name: string, position: number): void => {
			const toolset = toolsetByName(name);
			if (toolset === undefined) return;
			const result = removePattern(toolset.patterns, position);
			if ("error" in result) {
				notify(result.error, "warning");
				refresh();
				return;
			}
			if (savePatterns(name, result.patterns)) {
				patternIndex = Math.max(0, Math.min(position, result.patterns.length - 1));
			}
			refresh();
		};

		/** Saves the exception list. Unlike a toolset, this list may be empty. */
		const saveExceptions = (next: string[]): boolean => {
			const checked = checkPatterns(next, true);
			if ("error" in checked) {
				notify(checked.error, "error");
				return false;
			}
			const patterns = checked.patterns;
			try {
				store.update((current) => ({ ...current, unsandboxed_tools: patterns }));
			} catch (error) {
				notify(`The change was not saved: ${messageOf(error)}`, "error");
				return false;
			}
			return true;
		};

		const addException = async (): Promise<void> => {
			const before = store.get().unsandboxed_tools;
			if (before.length >= MAX_TOOLSET_PATTERNS) {
				notify(`The list already holds ${MAX_TOOLSET_PATTERNS} patterns. Delete one first.`, "warning");
				refresh();
				return;
			}
			const value = await ctx.ui.input("Add an exception pattern", "^my_tool$");
			if (value === undefined) return;
			const result = appendPattern(store.get().unsandboxed_tools, value, true);
			if ("error" in result) {
				notify(result.error, "error");
				refresh();
				return;
			}
			if (saveExceptions(result.patterns)) patternIndex = result.patterns.length - 1;
			refresh();
		};

		const editException = async (position: number): Promise<void> => {
			const old = store.get().unsandboxed_tools[position];
			if (old === undefined) return;
			const value = await ctx.ui.editor("Edit an exception pattern", old);
			if (value === undefined) return;
			const result = replacePattern(store.get().unsandboxed_tools, position, value);
			if ("error" in result) {
				notify(result.error, "error");
				refresh();
				return;
			}
			saveExceptions(result.patterns);
			refresh();
		};

		const deleteException = (position: number): void => {
			const patterns = store.get().unsandboxed_tools;
			if (position < 0 || position >= patterns.length) return;
			// The exception list may be empty, so the last pattern can go too.
			if (saveExceptions(patterns.filter((_entry, index) => index !== position))) {
				patternIndex = Math.max(0, Math.min(position, patterns.length - 2));
			}
			refresh();
		};

		const toggleSelected = (): void => {
			const item = buildRows(store.get())[index];
			if (item === undefined) return;
			if (item.kind === "toolset") toggleToolset(item.toolset);
			else if (item.kind === "sandbox") void toggleSandbox(item.info);
			else if (item.kind === "scope") cycleScope();
			else if (item.kind === "paths") openSelected();
			refresh();
		};

		const openSelected = (): void => {
			const item = buildRows(store.get())[index];
			if (item === undefined) return;
			if (item.kind === "exceptions" || item.kind === "paths") {
				view = { kind: item.kind };
				patternIndex = 0;
				refresh();
				return;
			}
			if (item.kind !== "toolset") {
				toggleSelected();
				return;
			}
			view = { kind: "patterns", name: item.toolset.name };
			patternIndex = 0;
			refresh();
		};

		const movePattern = (step: number): void => {
			const count = view.kind === "exceptions" ? store.get().unsandboxed_tools.length
				: view.kind === "patterns" ? (toolsetByName(view.name)?.patterns.length ?? 0) : 0;
			if (count === 0) return;
			patternIndex = (patternIndex + step + count) % count;
			refresh();
		};

		const handlePatternsInput = (data: string): void => {
			if (view.kind !== "patterns") return;
			const toolset = toolsetByName(view.name);
			if (toolset === undefined) {
				view = { kind: "main" };
				refresh();
				return;
			}
			if (data === "h" || keybindings.matches(data, "tui.select.cancel")) {
				view = { kind: "main" };
				refresh();
				return;
			}
			if (data === "k" || keybindings.matches(data, "tui.select.up")) {
				movePattern(-1);
				return;
			}
			if (data === "j" || keybindings.matches(data, "tui.select.down")) {
				movePattern(1);
				return;
			}
			patternIndex = Math.min(patternIndex, Math.max(0, toolset.patterns.length - 1));
			if (data === "a") {
				void addPattern(toolset.name);
				return;
			}
			if (data === "d") {
				deletePattern(toolset.name, patternIndex);
				return;
			}
			if (data === " ") {
				toggleToolset(toolset);
				refresh();
				return;
			}
			if (data === "l" || keybindings.matches(data, "tui.select.confirm")) {
				void editPattern(toolset.name, patternIndex);
			}
		};

		const handleExceptionsInput = (data: string): void => {
			if (view.kind !== "exceptions") return;
			const patterns = store.get().unsandboxed_tools;
			if (data === "h" || keybindings.matches(data, "tui.select.cancel")) {
				view = { kind: "main" };
				refresh();
				return;
			}
			if (data === "k" || keybindings.matches(data, "tui.select.up")) {
				movePattern(-1);
				return;
			}
			if (data === "j" || keybindings.matches(data, "tui.select.down")) {
				movePattern(1);
				return;
			}
			patternIndex = Math.min(patternIndex, Math.max(0, patterns.length - 1));
			if (data === "a") {
				void addException();
				return;
			}
			if (data === "d") {
				deleteException(patternIndex);
				return;
			}
			if (data === "l" || keybindings.matches(data, "tui.select.confirm")) {
				void editException(patternIndex);
			}
		};

		const handleMainInput = (data: string): void => {
			if (data === "h" || keybindings.matches(data, "tui.select.cancel")) {
				done(undefined);
				return;
			}
			const rows = buildRows(store.get());
			if (data === "k" || data === "j" || keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
				const count = rows.length;
				if (count > 0) index = (index + (data === "k" || keybindings.matches(data, "tui.select.up") ? -1 : 1) + count) % count;
				refresh();
				return;
			}
			index = Math.min(index, Math.max(0, rows.length - 1));

			if (data === "s") {
				cycleScope();
				refresh();
				return;
			}
			if (data === "a") {
				void addPath();
				return;
			}
			if (data === "d") {
				notify("Open Custom Paths to remove an extra path.", "warning");
				refresh();
				return;
			}
			if (data === " ") {
				toggleSelected();
				return;
			}
			if (data === "l" || keybindings.matches(data, "tui.select.confirm")) {
				openSelected();
			}
		};

		const handlePathsInput = (data: string): void => {
			const rows = pathRows(store.get());
			patternIndex = Math.min(patternIndex, rows.length - 1);
			if (data === "h" || keybindings.matches(data, "tui.select.cancel")) view = { kind: "main" };
			else if (data === "j" || keybindings.matches(data, "tui.select.down")) patternIndex = (patternIndex + 1) % rows.length;
			else if (data === "k" || keybindings.matches(data, "tui.select.up")) patternIndex = (patternIndex - 1 + rows.length) % rows.length;
			else if (data === "a") { void addPath(); return; }
			else if (data === "d") {
				const item = rows[patternIndex];
				if (item.root) notify("The project root cannot be removed.", "warning");
				else {
					removePath(item.path);
					patternIndex = Math.min(patternIndex, pathRows(store.get()).length - 1);
				}
			}
			refresh();
		};

		const handleInput = (data: string): void => {
			if (view.kind === "patterns") handlePatternsInput(data);
			else if (view.kind === "exceptions") handleExceptionsInput(data);
			else if (view.kind === "paths") handlePathsInput(data);
			else handleMainInput(data);
		};

		return {
			render(width: number): string[] {
				if (cachedLines !== undefined && cachedWidth === width) return cachedLines;
				cachedLines = renderScreen(store.get(), width).map((line) => truncateToWidth(line, Math.max(0, width)));
				cachedWidth = width;
				return cachedLines;
			},
			handleInput,
			invalidate,
		};
	});
}
