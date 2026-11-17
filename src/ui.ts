/** The `/permissions` screen: one list with the toolsets, the sandboxes, the scope, and the paths. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SANDBOXES } from "./sandboxes.ts";
import type { SandboxInfo } from "./sandboxes.ts";
import { canonicalPath, resolveDirectory } from "./scope.ts";
import { MAX_EXTRA_PATHS, type StateStore } from "./state.ts";
import { statusText } from "./tool.ts";
import type { PermissionsState, Toolset } from "./types.ts";

type Row =
	| { kind: "toolset"; toolset: Toolset }
	| { kind: "sandbox"; info: SandboxInfo }
	| { kind: "scope" }
	| { kind: "path"; path: string; root: boolean };

const SECTION: Record<Row["kind"], string> = {
	toolset: "Toolsets",
	sandbox: "Sandboxes",
	scope: "Scope",
	path: "Paths",
};

const LABEL_WIDTH = 24;

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
					const note = item.toolset.locked ? theme.fg("dim", " locked") : "";
					return `   ${marker} ${name}${onOff(item.toolset.enabled)}${note}`;
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

		const renderScreen = (state: PermissionsState, width: number): string[] => {
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
			lines.push("", theme.fg("dim", " space/enter toggle · s scope · a add path · d remove path · esc close"));
			return lines;
		};

		const cycleScope = (): void => {
			update((current) => ({ ...current, scope: current.scope === "project" ? "everywhere" : "project" }));
		};

		const toggleToolset = (toolset: Toolset): void => {
			if (toolset.locked) {
				notify("The permission toolset is locked. It protects the permissions tool.", "warning");
				return;
			}
			update((current) => ({
				...current,
				toolsets: current.toolsets.map((entry) =>
					entry.name === toolset.name ? { ...entry, enabled: !entry.enabled } : entry,
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

		const activate = (): void => {
			const state = store.get();
			const item = buildRows(state)[index];
			if (item === undefined) return;
			if (item.kind === "toolset") toggleToolset(item.toolset);
			else if (item.kind === "sandbox") toggleSandbox(item.info);
			else if (item.kind === "scope") cycleScope();
			refresh();
		};

		const handleInput = (data: string): void => {
			if (keybindings.matches(data, "tui.select.cancel")) {
				done(undefined);
				return;
			}
			const rows = buildRows(store.get());
			if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
				const count = rows.length;
				if (count > 0) index = (index + (keybindings.matches(data, "tui.select.up") ? -1 : 1) + count) % count;
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
			if (data === " " || keybindings.matches(data, "tui.select.confirm")) {
				activate();
			}
		};

		return {
			render(width: number): string[] {
				if (cachedLines !== undefined && cachedWidth === width) return cachedLines;
				cachedLines = renderScreen(store.get(), width);
				cachedWidth = width;
				return cachedLines;
			},
			handleInput,
			invalidate,
		};
	});
}
