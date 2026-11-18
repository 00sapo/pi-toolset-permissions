/** Wiring: state, the tool_call gate, the /permissions command, and the footer status. */

import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, createPowerShellTool } from "@earendil-works/pi-coding-agent";
import { evaluateCall } from "./gate.ts";
import { Approvals } from "./approval.ts";
import { wrapBash } from "./sandboxes.ts";
import { MAX_TOOLSETS, StateStore } from "./state.ts";
import { registerPermissionsTool } from "./tool.ts";
import { statusLine } from "./status.ts";
import type { Toolset } from "./types.ts";
import { openPermissions } from "./ui.ts";
import { install } from "./isolated.ts";
import { layersEnabled, platformPolicy } from "./platform.ts";
import { callReason } from "./reason.ts";

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

function approvalReason(ctx: ExtensionContext, tool: string, input: Record<string, unknown>): string {
	try {
		return callReason(ctx.sessionManager.getBranch(), tool, input);
	} catch {
		return callReason([], tool, input);
	}
}

function toolsetName(store: StateStore, toolName: string): string {
	const taken = new Set(store.get().toolsets.map((toolset) => toolset.name.toLowerCase()));
	if (!taken.has(toolName.toLowerCase())) return toolName;
	let index = 2;
	while (taken.has(`${toolName.toLowerCase()} ${index}`)) index += 1;
	return `${toolName} ${index}`;
}

function newToolset(store: StateStore, toolName: string): Toolset {
	return {
		name: toolsetName(store, toolName),
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

	const toolset = newToolset(store, toolName);
	try {
		store.update((current) => ({ ...current, toolsets: [...current.toolsets, toolset] }));
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(`The toolset was not saved: ${messageOf(error)}`, "error");
		return "deny";
	}
	if (ctx.hasUI) {
		ctx.ui.notify(`Added the toolset ${toolset.name}.`, "info");
	}
	return "always";
}

export default function permissionsExtension(pi: ExtensionAPI): void {
	// An installed copy and an explicit `-e` copy can load in the same process. The second
	// copy would keep its own store and answer with stale state, so it does nothing.
	const marker = globalThis as unknown as Record<symbol, boolean | undefined>;
	if (marker[LOADED] === true) return;
	marker[LOADED] = true;

	// Linux has a boundary that covers every tool. On that platform this entry point hands the
	// tool set to the isolated executor, so no tool runs on the host while a layer is on.
	if (platformPolicy().plan === "isolated") {
		install(pi, { registerPermissionsCommand: true });
		return;
	}

	try {
		const store = new StateStore();
		const approvals = new Approvals();
		// A host can deliver the same preflight event more than once. Bind a consumed
		// grant to that call ID, never to a later call with identical arguments.
		const authorizedCalls = new Map<string, { tool: string; input: Record<string, unknown> }>();
		const clearApprovals = (): void => {
			approvals.clear();
			authorizedCalls.clear();
		};
		let activeCtx: ExtensionContext | undefined;

		const publish = (ctx: ExtensionContext): void => {
			try {
				ctx.ui.setStatus("permissions", statusLine(store.get(), "bash"));
			} catch {
				// The footer is cosmetic. Never fail a handler for it.
			}
		};

		// Every change, from the tool or from the screen, refreshes the footer.
		store.onChange(() => {
			clearApprovals();
			if (activeCtx !== undefined) publish(activeCtx);
		});

		registerPermissionsTool(pi, store, publish, approvals);

		// Bash is one tool. When a sandbox is on, run the command inside the OS boundary.
		const bashDefinition = createBashTool(process.cwd());
		pi.registerTool({
			...bashDefinition,
			promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
			promptGuidelines: [
				"You can inspect PI_* environment variables for current model and session details.",
			],
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const plan = wrapBash(params.command, store.get(), undefined, ctx.cwd);
				if (plan !== null && "error" in plan) {
					return {
						content: [{ type: "text", text: plan.error }],
						details: {},
						isError: true,
					};
				}
				const tool = createBashTool(
					ctx.cwd,
					plan === null ? {} : { spawnHook: (input) => ({ ...input, command: plan.command }) },
				);
				return tool.execute(toolCallId, params, signal, onUpdate);
			},
		});

		// Native Windows has no sandbox backend. Cover the PowerShell tool too, so a
		// sandbox never runs a shell command unsandboxed.
		if (process.platform === "win32") {
			const powershellDefinition = createPowerShellTool(process.cwd());
			pi.registerTool({
				...powershellDefinition,
				promptSnippet: "Execute PowerShell commands",
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					const plan = wrapBash(params.command, store.get(), undefined, ctx.cwd);
					if (plan !== null && "error" in plan) {
						return {
							content: [{ type: "text", text: plan.error }],
							details: {},
							isError: true,
						};
					}
					const tool = createPowerShellTool(ctx.cwd);
					return tool.execute(toolCallId, params, signal, onUpdate);
				},
			});
		}

		pi.registerCommand("permissions", {
			description: "Tool permissions, scope, and sandboxes",
			handler: async (_args, ctx) => {
				// The pattern screen shows the tool names that each pattern matches.
				let toolNames: string[] = [];
				try {
					toolNames = pi.getAllTools().map((tool) => tool.name);
				} catch {
					toolNames = [];
				}
				try {
					await openPermissions(store, ctx, toolNames, "bash");
				} catch (error) {
					if (ctx.hasUI) ctx.ui.notify(`The permissions screen failed: ${messageOf(error)}`, "error");
				}
			},
		});

		pi.on("tool_call", async (event, ctx) => {
			const input = event.input as unknown as Record<string, unknown>;
			try {
				store.reload();
				const first = evaluateCall(store.get(), event.toolName, input, ctx.cwd);
				if (!first.block) return undefined;
				if (first.kind === "ask") {
					const prior = authorizedCalls.get(event.toolCallId);
					if (prior !== undefined && prior.tool === event.toolName && isDeepStrictEqual(prior.input, input)) {
						return undefined;
					}
					const bindApproval = (): void => {
						if (typeof event.toolCallId === "string") {
							if (authorizedCalls.size >= 256) authorizedCalls.delete(authorizedCalls.keys().next().value!);
							authorizedCalls.set(event.toolCallId, { tool: event.toolName, input: structuredClone(input) });
						}
					};
					if (approvals.consume(event.toolName, input)) {
						bindApproval();
						return undefined;
					}
					const answer = await approvals.request(store, event.toolName, input, approvalReason(ctx, event.toolName, input), ctx);
					store.reload();
					const current = evaluateCall(store.get(), event.toolName, input, ctx.cwd);
					if (current.block && current.kind !== "ask") return { block: true, reason: current.reason };
					if (!answer.startsWith("Approved")) return { block: true, reason: answer };
					// Enabling the toolset removes the ask decision. A one-time grant must
					// instead be consumed and bound to this same preflight event.
					if (!current.block) return undefined;
					if (approvals.consume(event.toolName, input)) {
						bindApproval();
						return undefined;
					}
				}
				if (first.kind !== "unknown") return { block: true, reason: first.reason };

				const choice = await askUnknownTool(store, event.toolName, ctx);
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

		pi.on("tool_result", async (event) => {
			authorizedCalls.delete(event.toolCallId);
		});

		pi.on("session_start", async (_event, ctx) => {
			clearApprovals();
			activeCtx = ctx;
			try {
				store.reload();
			} catch {
				// An unreadable file keeps the state that was loaded in the constructor.
			}
			const policy = platformPolicy();
			// Windows has no backend, so a saved layer must not keep blocking every shell call.
			if (!layersEnabled(policy)) {
				const layers = store.get().sandboxes;
				if (layers.filesystem !== "off" || layers.no_network) {
					store.update((current) => ({ ...current, sandboxes: { filesystem: "off", no_network: false } }));
					if (ctx.hasUI) ctx.ui.notify(policy.reason ?? "The sandbox is disabled here.", "warning");
				}
				publish(ctx);
				return;
			}
			// Linux has an entry point that covers every tool, so this one must not imply otherwise.
			if (policy.plan === "isolated" && ctx.hasUI) {
				ctx.ui.notify(
					"This entry point sandboxes bash only. For every tool, start Pi with src/isolated.ts instead.",
					"warning",
				);
			}
			publish(ctx);
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			activeCtx = undefined;
			clearApprovals();
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
