/** The `/permissions` screen: toolsets, their patterns, the sandboxes, the scope, and the paths. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { SANDBOXES } from "./sandboxes.ts";
import type { SandboxInfo } from "./sandboxes.ts";
import { canonicalPath, resolveDirectory } from "./scope.ts";
import { appendPattern, matchingNames, removePattern, replacePattern } from "./patterns.ts";
import { MAX_EXTRA_PATHS, MAX_TOOLSET_PATTERNS, type StateStore, checkPatterns } from "./state.ts";
import { statusText } from "./tool.ts";
import type { PermissionsState, Toolset } from "./types.ts";
import { nextToolsetMode, toolsetMode } from "./types.ts";

type Row =
	| { kind: "toolset"; toolset: Toolset }
	| { kind: "sandbox"; info: SandboxInfo }
	| { kind: "scope" }
	| { kind: "path"; path: string; root: boolean };

type View = { kind: "main" } | { kind: "patterns"; name: string };

const SECTION: Record<Row["kind"], string> = {
	toolset: "Toolsets",
	sandbox: "Sandboxes",
	scope: "Scope",
	path: "Paths",
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
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(statusText(store.get()), "info");
		return;
	}

	await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
		let view: View = { kind: "main" };
		let index = 0;
		let patternIndex = 0;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;

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

		const modeLabel = (toolset: Toolset): string => toolset.enabled === "ask"
			? theme.fg("warning", "[ASK]") : onOff(toolset.enabled);

		const toolsetByName = (name: string): Toolset | undefined =>
			store.get().toolsets.find((entry) => entry.name === name);

		const buildRows = (state: PermissionsState): Row[] => {
			const rows: Row[] = state.toolsets.map((toolset) => ({ kind: "toolset", toolset }));
			for (const info of SANDBOXES) rows.push({ kind: "sandbox", info });
			rows.push({ kind: "scope" });
			[ctx.cwd, ...state.extra_paths].forEach((path, position) => {
				rows.push({ kind: "path", path, root: position === 0 });
			});
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
					return `   ${marker} ${name}${onOff(state.sandboxes[item.info.key])}`;
				}
				case "scope":
					return `   ${marker} ${"All paths".padEnd(labelWidth)}[${state.scope.toUpperCase()}]`;
				case "path": {
					const name = clip(item.path, Math.max(8, width - 10));
					const note = item.root ? theme.fg("dim", "  project root") : "";
					return `   ${marker} ${name}${note}`;
				}
			}
		};

		const renderMain = (state: PermissionsState, width: number): string[] => {
			const rows = buildRows(state);
			const lines = [` ${theme.bold("Permissions")}`, ""];
			let section: string | null = null;
			rows.forEach((item, position) => {
				const title = SECTION[item.kind];
				if (title !== section) {
					section = title;
					if (position > 0) lines.push("");
					lines.push(` ${theme.bold(title)}`);
				}
				lines.push(rowText(state, item, position === index, width));
			});
			lines.push(
				"",
				theme.fg("dim", " Toolsets: OFF blocked · ON no request · ASK approve each call"),
				theme.fg("dim", " If several toolsets match, ON takes priority over ASK and OFF."),
				theme.fg("dim", " j/k move · l enter · h back · space off → on → ask"),
				theme.fg("dim", " s scope · a add path · d remove path"),
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
			return lines;
		};

		const renderScreen = (state: PermissionsState, width: number): string[] =>
			view.kind === "patterns" ? renderPatterns(state, width) : renderMain(state, width);

		const cycleScope = (): void => {
			update((current) => ({ ...current, scope: current.scope === "project" ? "everywhere" : "project" }));
		};

		const toggleToolset = (toolset: Toolset): void => {
			update((current) => ({
				...current,
				toolsets: current.toolsets.map((entry) =>
					entry.name === toolset.name ? { ...entry, enabled: nextToolsetMode(entry.enabled) } : entry,
				),
			}));
		};

		const toggleSandbox = (info: SandboxInfo): void => {
			update((current) => ({
				...current,
				sandboxes: { ...current.sandboxes, [info.key]: !current.sandboxes[info.key] },
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
			let added = false;
			update((current) => {
				if (current.extra_paths.some((entry) => canonicalPath(entry) === target)) return current;
				added = true;
				return { ...current, extra_paths: [...current.extra_paths, target] };
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

		const toggleSelected = (): void => {
			const item = buildRows(store.get())[index];
			if (item === undefined) return;
			if (item.kind === "toolset") toggleToolset(item.toolset);
			else if (item.kind === "sandbox") toggleSandbox(item.info);
			else if (item.kind === "scope") cycleScope();
			refresh();
		};

		const openSelected = (): void => {
			const item = buildRows(store.get())[index];
			if (item === undefined) return;
			if (item.kind !== "toolset") {
				toggleSelected();
				return;
			}
			view = { kind: "patterns", name: item.toolset.name };
			patternIndex = 0;
			refresh();
		};

		const movePattern = (step: number): void => {
			const toolset = view.kind === "patterns" ? toolsetByName(view.name) : undefined;
			if (toolset === undefined || toolset.patterns.length === 0) return;
			const count = toolset.patterns.length;
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
				const item = rows[index];
				if (item === undefined) return;
				if (item.kind !== "path") {
					notify("Select a path first. Press a to add one.", "warning");
					refresh();
					return;
				}
				if (item.root) {
					notify("The project root cannot be removed.", "warning");
					refresh();
					return;
				}
				removePath(item.path);
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

		const handleInput = (data: string): void => {
			if (view.kind === "patterns") handlePatternsInput(data);
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
