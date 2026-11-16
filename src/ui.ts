/** The `/permissions` screen: flags, scope, extra paths, toolsets, and sandboxes. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SANDBOXES } from "./sandboxes.ts";
import { canonicalPath, resolveDirectory } from "./scope.ts";
import { MAX_EXTRA_PATHS } from "./state.ts";
import type { StateStore } from "./state.ts";
import { statusText } from "./tool.ts";
import type { PermissionsState, Risk } from "./types.ts";

type Page = "main" | "paths" | "toolsets" | "sandboxes";

const RISKS: readonly Risk[] = ["read", "write", "execute"];
const PAGE_OF_ROW: readonly Page[] = ["paths", "toolsets", "sandboxes"];
const MAIN_ROWS = 7;

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function clip(value: string, width: number): string {
	if (width <= 1 || value.length <= width) return value;
	return `${value.slice(0, width - 1)}…`;
}

export async function openPermissions(store: StateStore, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(statusText(store.get()), "info");
		return;
	}

	await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
		let page: Page = "main";
		let index = 0;
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

		const row = (label: string, value: string, selected: boolean, gap: number): string => {
			const name = label.padEnd(16);
			const painted = selected ? theme.fg("accent", theme.bold(name)) : name;
			return `   ${painted}${" ".repeat(gap)}${value}`;
		};

		const rows = (): number => {
			if (page === "main") return MAIN_ROWS;
			if (page === "paths") return 1 + store.get().extra_paths.length;
			if (page === "toolsets") return store.get().toolsets.length;
			return SANDBOXES.length;
		};

		const renderMain = (state: PermissionsState): string[] => {
			const paths = 1 + state.extra_paths.length;
			const sandboxes = SANDBOXES.filter((sandbox) => state.sandboxes[sandbox.key]).length;
			return [
				` ${theme.bold("Permissions")}`,
				"",
				row("Read", onOff(state.flags.read), index === 0, 0),
				row("Write", onOff(state.flags.write), index === 1, 0),
				row("Execute", onOff(state.flags.execute), index === 2, 0),
				row("Scope", `[${state.scope.toUpperCase()}]`, index === 3, 0),
				row(`Paths (${paths})`, ">", index === 4, 3),
				row(`Toolsets (${state.toolsets.length})`, ">", index === 5, 3),
				row(`Sandboxes (${sandboxes})`, ">", index === 6, 3),
				"",
				theme.fg("dim", " space/enter toggle · s scope · p paths · t toolsets · b sandboxes · esc close"),
			];
		};

		const renderPaths = (state: PermissionsState, width: number): string[] => {
			const lines = [` ${theme.bold("Paths")}`, ""];
			const roots = [ctx.cwd, ...state.extra_paths];
			roots.forEach((root, position) => {
				const marker = position === index ? theme.fg("accent", ">") : " ";
				const name = clip(root, Math.max(8, width - 8));
				const text = position === 0 ? theme.fg("muted", name) : name;
				const note = position === 0 ? theme.fg("dim", " project root") : "";
				lines.push(`   ${marker} ${text}${note}`);
			});
			if (state.scope === "everywhere") {
				lines.push("", theme.fg("warning", " Scope is everywhere. These paths are kept but not used."));
			}
			lines.push("", theme.fg("dim", " a add directory · d remove · esc back"));
			return lines;
		};

		const renderToolsets = (state: PermissionsState, width: number): string[] => {
			const lines = [` ${theme.bold("Toolsets")}`, ""];
			state.toolsets.forEach((toolset, position) => {
				const marker = position === index ? theme.fg("accent", ">") : " ";
				const name = clip(toolset.name, Math.max(8, width - 30)).padEnd(16);
				const value = toolset.builtin ? theme.fg("dim", "builtin") : onOff(toolset.enabled);
				lines.push(`   ${marker} ${name} ${toolset.risk.padEnd(8)} ${value}`);
			});
			lines.push("", theme.fg("dim", " space toggle · d delete · esc back"));
			lines.push(theme.fg("dim", " New toolsets are added by asking the assistant, with the pattern and risk."));
			return lines;
		};

		const renderSandboxes = (state: PermissionsState, width: number): string[] => {
			const lines = [` ${theme.bold("Sandboxes")}`, ""];
			SANDBOXES.forEach((sandbox, position) => {
				const marker = position === index ? theme.fg("accent", ">") : " ";
				lines.push(`   ${marker} ${sandbox.label.padEnd(18)} ${onOff(state.sandboxes[sandbox.key])}`);
				lines.push(theme.fg("dim", `     ${clip(sandbox.description, Math.max(8, width - 6))}`));
			});
			lines.push("", theme.fg("dim", " space toggle · esc back"));
			return lines;
		};

		const toggleFlag = (risk: Risk): void => {
			update((current) => ({ ...current, flags: { ...current.flags, [risk]: !current.flags[risk] } }));
		};

		const cycleScope = (): void => {
			update((current) => ({ ...current, scope: current.scope === "project" ? "everywhere" : "project" }));
		};

		const openPage = (next: Page): void => {
			page = next;
			index = 0;
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

		const removePath = (): void => {
			if (index === 0) {
				notify("The project root cannot be removed.", "warning");
				refresh();
				return;
			}
			const target = store.get().extra_paths[index - 1];
			if (target === undefined) return;
			update((current) => ({ ...current, extra_paths: current.extra_paths.filter((entry) => entry !== target) }));
			if (index > rows() - 1) index = rows() - 1;
			refresh();
		};

		const toggleToolset = (): void => {
			const toolset = store.get().toolsets[index];
			if (toolset === undefined) return;
			if (toolset.builtin) {
				notify("Builtin toolsets are read-only. Use the flags on the main page.", "warning");
				return;
			}
			update((current) => ({
				...current,
				toolsets: current.toolsets.map((entry) => (entry.name === toolset.name ? { ...entry, enabled: !entry.enabled } : entry)),
			}));
			refresh();
		};

		const deleteToolset = (): void => {
			const toolset = store.get().toolsets[index];
			if (toolset === undefined) return;
			if (toolset.builtin) {
				notify("Builtin toolsets cannot be deleted.", "warning");
				return;
			}
			update((current) => ({ ...current, toolsets: current.toolsets.filter((entry) => entry.name !== toolset.name) }));
			if (index > rows() - 1) index = Math.max(0, rows() - 1);
			refresh();
		};

		const toggleSandbox = (): void => {
			const sandbox = SANDBOXES[index];
			if (sandbox === undefined) return;
			update((current) => ({
				...current,
				sandboxes: { ...current.sandboxes, [sandbox.key]: !current.sandboxes[sandbox.key] },
			}));
			refresh();
		};

		const activate = (): void => {
			if (page === "main") {
				if (index < RISKS.length) {
					const risk = RISKS[index];
					if (risk !== undefined) toggleFlag(risk);
				} else if (index === 3) {
					cycleScope();
				} else {
					const next = PAGE_OF_ROW[index - 4];
					if (next !== undefined) openPage(next);
				}
			} else if (page === "toolsets") {
				toggleToolset();
			} else if (page === "sandboxes") {
				toggleSandbox();
			}
			refresh();
		};

		const handleInput = (data: string): void => {
			if (keybindings.matches(data, "tui.select.cancel")) {
				if (page === "main") {
					done(undefined);
					return;
				}
				openPage("main");
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
				const count = rows();
				if (count > 0) index = (index + (keybindings.matches(data, "tui.select.up") ? -1 : 1) + count) % count;
				refresh();
				return;
			}
			if (data === "p") {
				openPage("paths");
				refresh();
				return;
			}
			if (data === "t") {
				openPage("toolsets");
				refresh();
				return;
			}
			if (data === "b") {
				openPage("sandboxes");
				refresh();
				return;
			}
			if (data === "s") {
				cycleScope();
				refresh();
				return;
			}
			if (data === "a" && page === "paths") {
				void addPath();
				return;
			}
			if (data === "d" && page === "paths") {
				removePath();
				return;
			}
			if (data === "d" && page === "toolsets") {
				deleteToolset();
				return;
			}
			if (data === " " || keybindings.matches(data, "tui.select.confirm")) {
				activate();
			}
		};

		return {
			render(width: number): string[] {
				if (cachedLines !== undefined && cachedWidth === width) return cachedLines;
				const state = store.get();
				cachedLines =
					page === "main"
						? renderMain(state)
						: page === "paths"
							? renderPaths(state, width)
							: page === "toolsets"
								? renderToolsets(state, width)
								: renderSandboxes(state, width);
				cachedWidth = width;
				return cachedLines;
			},
			handleInput,
			invalidate,
		};
	});
}
