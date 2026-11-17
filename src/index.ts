/** Wiring: state, the tool_call gate, the /permissions command, and the footer status. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evaluateCall } from "./gate.ts";
import { MAX_TOOLSETS, StateStore } from "./state.ts";
import { registerPermissionsTool, statusLine } from "./tool.ts";
import type { Risk, Toolset } from "./types.ts";
import { openPermissions } from "./ui.ts";

const LOADED = Symbol.for("pi-toolset-permissions.loaded");
const MAX_REASON = 240;

type UnknownChoice = "once" | "always" | "deny";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clipReason(reason: string): string {
	if (reason.length <= MAX_REASON) return reason;
	return `${reason.slice(0, MAX_REASON - 3)}...`;
}

function toolsetName(store: StateStore, toolName: string): string {
	const taken = new Set(store.get().toolsets.map((toolset) => toolset.name.toLowerCase()));
	if (!taken.has(toolName.toLowerCase())) return toolName;
	let index = 2;
	while (taken.has(`${toolName.toLowerCase()} ${index}`)) index += 1;
	return `${toolName} ${index}`;
}

function newToolset(pi: ExtensionAPI, store: StateStore, toolName: string): Toolset {
	const annotations = pi.getAllTools().find((tool) => tool.name === toolName)?.annotations;
	const risk: Risk = annotations?.readOnlyHint === true ? "read" : "execute";
	return {
		name: toolsetName(store, toolName),
		risk,
		patterns: [`^${escapeRegex(toolName)}$`],
		enabled: true,
		builtin: false,
	};
}

/**
 * Asks the user about a tool that no toolset matches. "always" adds a toolset that
 * matches the tool name, and the caller re-evaluates the call.
 */
async function askUnknownTool(
	pi: ExtensionAPI,
	store: StateStore,
	toolName: string,
	ctx: ExtensionContext,
): Promise<UnknownChoice> {
	if (!ctx.hasUI) return "deny";
	if (store.get().toolsets.length >= MAX_TOOLSETS) {
		ctx.ui.notify(`The list already holds ${MAX_TOOLSETS} toolsets. Remove one first.`, "warning");
		return "deny";
	}
	const answer = await ctx.ui.select(`Unknown tool: ${toolName}`, [
		"Allow once",
		"Always allow (add toolset)",
		"Block",
	]);
	if (answer === "Allow once") return "once";
	if (answer !== "Always allow (add toolset)") return "deny";

	const toolset = newToolset(pi, store, toolName);
	try {
		store.update((current) => ({ ...current, toolsets: [...current.toolsets, toolset] }));
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(`The toolset was not saved: ${messageOf(error)}`, "error");
		return "deny";
	}
	if (ctx.hasUI) {
		ctx.ui.notify(`Added the toolset ${toolset.name} with risk ${toolset.risk}.`, "info");
	}
	return "always";
}

export default function permissionsExtension(pi: ExtensionAPI): void {
	// An installed copy and an explicit `-e` copy can load in the same process. The second
	// copy would keep its own store and answer with stale flags, so it does nothing.
	const marker = globalThis as unknown as Record<symbol, boolean | undefined>;
	if (marker[LOADED] === true) return;
	marker[LOADED] = true;

	try {
		const store = new StateStore();
		let activeCtx: ExtensionContext | undefined;

		const publish = (ctx: ExtensionContext): void => {
			try {
				ctx.ui.setStatus("permissions", statusLine(store.get()));
			} catch {
				// The footer is cosmetic. Never fail a handler for it.
			}
		};

		// Every change, from the tool or from the screen, refreshes the footer.
		store.onChange(() => {
			if (activeCtx !== undefined) publish(activeCtx);
		});

		registerPermissionsTool(pi, store, publish);

		pi.registerCommand("permissions", {
			description: "Tool permissions, scope, and sandboxes",
			handler: async (_args, ctx) => {
				try {
					await openPermissions(store, ctx);
				} catch (error) {
					if (ctx.hasUI) ctx.ui.notify(`The permissions screen failed: ${messageOf(error)}`, "error");
				}
			},
		});

		pi.on("tool_call", async (event, ctx) => {
			const input = event.input as unknown as Record<string, unknown>;
			try {
				const first = evaluateCall(store.get(), event.toolName, input, ctx.cwd);
				if (!first.block) return undefined;
				if (first.kind !== "unknown") return { block: true, reason: first.reason };

				const choice = await askUnknownTool(pi, store, event.toolName, ctx);
				if (choice === "once") return undefined;
				if (choice === "deny") return { block: true, reason: first.reason };

				const second = evaluateCall(store.get(), event.toolName, input, ctx.cwd);
				if (!second.block) return undefined;
				if (ctx.hasUI) ctx.ui.notify(clipReason(second.reason), "warning");
				return { block: true, reason: second.reason };
			} catch (error) {
				// Fail closed: a broken gate must not open the tools.
				return { block: true, reason: `Blocked: the permissions gate failed (${messageOf(error)}).` };
			}
		});

		pi.on("session_start", async (_event, ctx) => {
			activeCtx = ctx;
			try {
				store.reload();
			} catch {
				// An unreadable file keeps the state that was loaded in the constructor.
			}
			publish(ctx);
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			activeCtx = undefined;
			marker[LOADED] = false;
			try {
				ctx.ui.setStatus("permissions", undefined);
			} catch {
				// Nothing left to clear.
			}
		});
	} catch (error) {
		// Do not leave the marker set if registration failed before the gate existed.
		marker[LOADED] = false;
		throw error;
	}
}
