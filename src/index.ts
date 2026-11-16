/** Wiring: state, the tool_call gate, the /permissions command, and the footer status. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evaluateCall } from "./gate.ts";
import { StateStore } from "./state.ts";
import { registerPermissionsTool, statusLine } from "./tool.ts";
import { openPermissions } from "./ui.ts";

const LOADED = Symbol.for("pi-toolset-permissions.loaded");

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
				const decision = evaluateCall(store.get(), event.toolName, input, ctx.cwd);
				if (!decision.block) {
					if (decision.patch !== undefined) input.path = decision.patch.path;
					return undefined;
				}
				return { block: true, reason: decision.reason };
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
