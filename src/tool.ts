/** The `permissions` tool: the model asks, the user confirms, the state changes. */

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { SANDBOXES } from "./sandboxes.ts";
import { canonicalPath, resolveDirectory, resolvePath } from "./scope.ts";
import { MAX_EXTRA_PATHS, MAX_TOOLSETS, type StateStore } from "./state.ts";
import type { PermissionsState } from "./types.ts";

const parameters = Type.Object({
	action: Type.Union(
		[
			Type.Literal("status"),
			Type.Literal("set_scope"),
			Type.Literal("add_path"),
			Type.Literal("remove_path"),
			Type.Literal("add_toolset"),
			Type.Literal("remove_toolset"),
			Type.Literal("set_toolset"),
			Type.Literal("set_sandbox"),
		],
		{ description: "Action to run. Read status first when the reason for a block is unclear." },
	),
	enabled: Type.Optional(Type.Boolean({ description: "New value for set_toolset and set_sandbox." })),
	scope: Type.Optional(
		Type.Union([Type.Literal("project"), Type.Literal("everywhere")], {
			description: "Path scope for set_scope. everywhere removes the path check.",
		}),
	),
	path: Type.Optional(Type.String({ description: "Directory for add_path and remove_path." })),
	name: Type.Optional(Type.String({ description: "Toolset name for add_toolset, remove_toolset, and set_toolset." })),
	patterns: Type.Optional(
		Type.Array(Type.String(), { description: "Regular expression sources for add_toolset, tested against tool names." }),
	),
	sandbox: Type.Optional(
		Type.Union([Type.Literal("readonly_bash"), Type.Literal("no_network")], {
			description: "Sandbox key for set_sandbox.",
		}),
	),
});

type Params = Static<typeof parameters>;

interface ToolOutcome {
	text: string;
	isError?: boolean;
}

interface ToolEnv {
	store: StateStore;
	onChanged: (ctx: ExtensionToolContext) => void;
	ctx: ExtensionToolContext;
	params: Params;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function onOff(value: boolean): string {
	return value ? "on" : "off";
}

/** One-line summary for the footer status. */
export function statusLine(state: PermissionsState): string {
	const on = state.toolsets.filter((toolset) => toolset.enabled).length;
	const sandboxes = SANDBOXES.filter((sandbox) => state.sandboxes[sandbox.key]).length;
	return `toolsets:${on}/${state.toolsets.length} sandboxes:${sandboxes}/${SANDBOXES.length} ${state.scope}`;
}

/** Compact text report of the current state. */
export function statusText(state: PermissionsState): string {
	const lines = [`toolsets (${state.toolsets.length}):`];
	for (const toolset of state.toolsets) {
		const marker = toolset.locked ? "locked" : toolset.builtin ? "builtin" : "custom";
		lines.push(`  ${toolset.name} ${onOff(toolset.enabled)} ${marker} patterns=${toolset.patterns.length}`);
	}
	lines.push(
		`sandboxes: readonly_bash=${onOff(state.sandboxes.readonly_bash)} no_network=${onOff(state.sandboxes.no_network)}`,
	);
	lines.push(`scope: ${state.scope}`);
	lines.push(
		`paths: ${state.extra_paths.length === 0 ? "the project root only" : state.extra_paths.join(", ")}`,
	);
	return lines.join("\n");
}

function declined(): ToolOutcome {
	return { text: "The user declined the change. Nothing was modified." };
}

function applyChange(
	env: ToolEnv,
	change: (current: PermissionsState) => PermissionsState,
	summary: string,
): ToolOutcome {
	let next: PermissionsState;
	try {
		next = env.store.update(change);
	} catch (error) {
		return { text: `The change was not saved: ${messageOf(error)}`, isError: true };
	}
	try {
		env.onChanged(env.ctx);
	} catch {
		// The footer status is cosmetic. The change is already saved.
	}
	return { text: `${summary}\n\n${statusText(next)}` };
}

async function setScope(env: ToolEnv): Promise<ToolOutcome> {
	const scope = env.params.scope;
	if (scope === undefined) return { text: "set_scope needs scope: project or everywhere.", isError: true };
	const before = env.store.get().scope;
	if (before === scope) return { text: `The scope is already ${scope}. Nothing to change.` };
	const title = scope === "everywhere" ? "Allow every path?" : "Limit tools to the project?";
	const message =
		scope === "everywhere"
			? `scope: ${before} → everywhere\n\nThe path check is removed. Tools can reach any path on this machine.`
			: `scope: ${before} → project\n\nTools may touch only the project directory and the extra paths.`;
	if (!(await env.ctx.ui.confirm(title, message))) return declined();
	return applyChange(env, (current) => ({ ...current, scope }), `The scope is now ${scope}.`);
}

async function addPath(env: ToolEnv): Promise<ToolOutcome> {
	const value = env.params.path;
	if (value === undefined || value.trim() === "") return { text: "add_path needs path.", isError: true };
	const state = env.store.get();
	if (state.scope === "everywhere") {
		return {
			text: "The scope is everywhere, so extra paths are not used. Ask the user to set the scope to project first.",
			isError: true,
		};
	}
	if (state.extra_paths.length >= MAX_EXTRA_PATHS) {
		return { text: `The list already holds ${MAX_EXTRA_PATHS} extra paths. Remove one first.`, isError: true };
	}
	const checked = resolveDirectory(env.ctx.cwd, value);
	if ("error" in checked) return { text: checked.error, isError: true };
	const target = checked.path;
	if (state.extra_paths.some((entry) => canonicalPath(entry) === target)) {
		return { text: `${target} is already an allowed path.` };
	}
	const title = "Allow this directory?";
	const message = `${target}\n\nPaths inside it become allowed in project scope.`;
	if (!(await env.ctx.ui.confirm(title, message))) return declined();
	return applyChange(
		env,
		(current) => ({ ...current, extra_paths: [...current.extra_paths, target] }),
		`Added ${target} to the allowed paths.`,
	);
}

async function removePath(env: ToolEnv): Promise<ToolOutcome> {
	const value = env.params.path;
	if (value === undefined || value.trim() === "") return { text: "remove_path needs path.", isError: true };
	const wanted = canonicalPath(resolvePath(env.ctx.cwd, value));
	const entries = env.store.get().extra_paths;
	const entry = entries.find((candidate) => canonicalPath(candidate) === wanted);
	if (entry === undefined) return { text: `${wanted} is not one of the extra paths.`, isError: true };
	const title = "Remove this allowed directory?";
	const message = `${entry}\n\nTools can no longer use it in project scope.`;
	if (!(await env.ctx.ui.confirm(title, message))) return declined();
	return applyChange(
		env,
		(current) => ({ ...current, extra_paths: current.extra_paths.filter((candidate) => candidate !== entry) }),
		`Removed ${entry} from the allowed paths.`,
	);
}

function readPatterns(raw: string[] | undefined): { patterns: string[] } | { error: string } {
	if (raw === undefined || raw.length === 0) return { error: "add_toolset needs at least one pattern." };
	const patterns: string[] = [];
	for (const pattern of raw) {
		const source = pattern.trim();
		if (source === "") return { error: "A pattern is empty." };
		if (source.length > 500) return { error: "A pattern is longer than 500 characters." };
		try {
			new RegExp(source, "i");
		} catch (error) {
			return { error: `The pattern ${source} does not compile: ${messageOf(error)}` };
		}
		patterns.push(source);
		if (patterns.length >= 32) break;
	}
	return { patterns };
}

async function addToolset(env: ToolEnv): Promise<ToolOutcome> {
	const name = env.params.name?.trim();
	if (name === undefined || name === "") return { text: "add_toolset needs name.", isError: true };
	const parsed = readPatterns(env.params.patterns);
	if ("error" in parsed) return { text: parsed.error, isError: true };
	const patterns = parsed.patterns;
	if (env.store.get().toolsets.some((toolset) => toolset.name.toLowerCase() === name.toLowerCase())) {
		return { text: `A toolset named ${name} already exists.`, isError: true };
	}
	if (env.store.get().toolsets.length >= MAX_TOOLSETS) {
		return { text: `The list already holds ${MAX_TOOLSETS} toolsets. Remove one first.`, isError: true };
	}
	const title = `Add toolset ${name}?`;
	const message = `name: ${name}\npatterns:\n${patterns.map((pattern) => `  ${pattern}`).join("\n")}`;
	if (!(await env.ctx.ui.confirm(title, message))) return declined();
	return applyChange(
		env,
		(current) => ({
			...current,
			toolsets: [...current.toolsets, { name, patterns, enabled: true, builtin: false, locked: false }],
		}),
		`Added the toolset ${name}.`,
	);
}

async function removeToolset(env: ToolEnv): Promise<ToolOutcome> {
	const name = env.params.name?.trim();
	if (name === undefined || name === "") return { text: "remove_toolset needs name.", isError: true };
	const toolset = env.store.get().toolsets.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
	if (toolset === undefined) return { text: `No toolset is named ${name}.`, isError: true };
	if (toolset.builtin) return { text: `The builtin toolset ${name} cannot be removed.`, isError: true };
	const title = `Remove toolset ${name}?`;
	const message = `Tools that match ${name} are blocked again unless another toolset matches them.`;
	if (!(await env.ctx.ui.confirm(title, message))) return declined();
	return applyChange(
		env,
		(current) => ({ ...current, toolsets: current.toolsets.filter((candidate) => candidate.name !== toolset.name) }),
		`Removed the toolset ${name}.`,
	);
}

async function setToolset(env: ToolEnv): Promise<ToolOutcome> {
	const name = env.params.name?.trim();
	const enabled = env.params.enabled;
	if (name === undefined || name === "") return { text: "set_toolset needs name.", isError: true };
	if (enabled === undefined) return { text: "set_toolset needs enabled: true or false.", isError: true };
	const toolset = env.store.get().toolsets.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
	if (toolset === undefined) return { text: `No toolset is named ${name}.`, isError: true };
	if (toolset.locked) {
		return {
			text: `The toolset ${name} is locked. It protects the permissions tool, so it is always on.`,
			isError: true,
		};
	}
	if (toolset.enabled === enabled) return { text: `The toolset ${name} is already ${enabled ? "on" : "off"}.` };
	const title = `Turn ${enabled ? "on" : "off"} toolset ${name}?`;
	const message = `enabled: ${onOff(toolset.enabled)} → ${onOff(enabled)}\n\n${
		enabled ? "Its patterns match tool names again." : "Its patterns no longer match any tool."
	}`;
	if (!(await env.ctx.ui.confirm(title, message))) return declined();
	return applyChange(
		env,
		(current) => ({
			...current,
			toolsets: current.toolsets.map((candidate) => (candidate.name === toolset.name ? { ...candidate, enabled } : candidate)),
		}),
		`The toolset ${name} is now ${onOff(enabled)}.`,
	);
}

async function setSandbox(env: ToolEnv): Promise<ToolOutcome> {
	const key = env.params.sandbox;
	const enabled = env.params.enabled;
	if (key === undefined) return { text: "set_sandbox needs sandbox: readonly_bash or no_network.", isError: true };
	if (enabled === undefined) return { text: "set_sandbox needs enabled: true or false.", isError: true };
	const info = SANDBOXES.find((sandbox) => sandbox.key === key);
	if (info === undefined) return { text: `No sandbox is named ${key}.`, isError: true };
	const before = env.store.get().sandboxes[key];
	if (before === enabled) return { text: `The sandbox ${info.label} is already ${onOff(enabled)}.` };
	const title = `Turn ${enabled ? "on" : "off"} ${info.label}?`;
	const message = `${key}: ${onOff(before)} → ${onOff(enabled)}\n\n${info.description}`;
	if (!(await env.ctx.ui.confirm(title, message))) return declined();
	return applyChange(
		env,
		(current) => ({ ...current, sandboxes: { ...current.sandboxes, [key]: enabled } }),
		`The sandbox ${info.label} is now ${onOff(enabled)}.`,
	);
}

async function runAction(env: ToolEnv): Promise<ToolOutcome> {
	const { action } = env.params;
	if (action === "status") return { text: statusText(env.store.get()) };
	switch (action) {
		case "set_scope":
			return setScope(env);
		case "add_path":
			return addPath(env);
		case "remove_path":
			return removePath(env);
		case "add_toolset":
			return addToolset(env);
		case "remove_toolset":
			return removeToolset(env);
		case "set_toolset":
			return setToolset(env);
		case "set_sandbox":
			return setSandbox(env);
		default:
			return {
				text: "Unknown action. Use status, set_scope, add_path, remove_path, add_toolset, remove_toolset, set_toolset, or set_sandbox.",
				isError: true,
			};
	}
}

export function registerPermissionsTool(
	pi: ExtensionAPI,
	store: StateStore,
	onChanged: (ctx: ExtensionToolContext) => void,
): void {
	pi.registerTool({
		name: "permissions",
		label: "Permissions",
		description:
			"Read or change the toolsets, path scope, and bash sandboxes. Every change asks the user to confirm.",
		promptSnippet: "Read or change toolsets, path scope, and sandboxes (asks the user to confirm)",
		promptGuidelines: [
			'Use permissions with action "status" when a tool call is blocked and the reason does not explain why.',
			"Use permissions to request a permission change; the user is asked to confirm, and the change applies only after approval.",
		],
		defaultActive: true,
		parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const env: ToolEnv = { store, onChanged, ctx, params };
			try {
				if (params.action !== "status" && !ctx.hasUI) {
					return {
						content: [{ type: "text", text: "Permission changes need an interactive session." }],
						details: {},
						isError: true,
					};
				}
				const outcome = await runAction(env);
				if (outcome.isError) {
					return { content: [{ type: "text", text: outcome.text }], details: {}, isError: true };
				}
				return { content: [{ type: "text", text: outcome.text }], details: {} };
			} catch (error) {
				return {
					content: [{ type: "text", text: `The permissions tool failed: ${messageOf(error)}` }],
					details: {},
					isError: true,
				};
			}
		},
	});
}
