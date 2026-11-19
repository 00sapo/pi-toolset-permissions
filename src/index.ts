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
import { reportPrompts, suppressPrompts } from "./notify.ts";
import { layersEnabled, platformPolicy } from "./platform.ts";
import { callReason } from "./reason.ts";
import {
	claimSession,
	dropChild,
	dropForwarder,
	releaseSession,
	setChild,
	setForwarder,
} from "./sessions.ts";

const MAX_REASON = 240;
const CHILD_PERMISSION_GUIDANCE =
	'If you need a permission change, call ask_parent with the requested action, exact path or toolset, and purpose. '
	+ 'Then end your turn and wait for the parent. The parent must call permissions and obtain user consent. '
	+ 'Retry only after the parent reports approval. If the user refuses, stop that operation. '
	+ 'Never use bash or another tool to bypass a block.';

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
	// An installed copy and an explicit `-e` copy can load in the same process. A
	// second copy in the same session would answer with stale state, so it stands
	// down. Child sessions run in this process too, and they must each get their
	// own gate, so the claim is per session and not per process.
	const token = {};
	const claimed = new Set<string>();
	const sessionIdOf = (ctx: ExtensionContext): string => {
		try {
			return ctx.sessionManager?.getSessionId() ?? "";
		} catch {
			return "";
		}
	};
	const claim = (ctx: ExtensionContext): boolean => {
		const sessionId = sessionIdOf(ctx);
		if (claimed.has(sessionId)) return true;
		if (!claimSession(sessionId, token)) return false;
		claimed.add(sessionId);
		return true;
	};


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
		// Set when another copy of this extension already owns this session.
		let passive = false;

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

		// Herdr reads `herdr:blocked` to mark the pane blocked and to notify the user.
		// Pi publishes a prompt start and end around every dialog, so this covers the
		// approval dialog, the unknown-tool question, and the change confirmations.
		reportPrompts(pi);

		registerPermissionsTool(pi, store, publish, approvals);

		// The store must know its session before any executor starts, because the isolated
		// installer registers its own start handler and may launch a child immediately.
		pi.on("session_start", (_event, ctx) => {
			store.bindSession(sessionIdOf(ctx));
		});

		const isolated = platformPolicy().plan === "isolated";
		if (isolated) install(pi, { registerPermissionsCommand: true, store, approvals, approve: (event, ctx) => gateCall(event, ctx) });
		if (!isolated) {
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
					// The user opened this screen, so it is not a question for the user.
					await suppressPrompts(() => openPermissions(store, ctx, toolNames, "bash"));
				} catch (error) {
					if (ctx.hasUI) ctx.ui.notify(`The permissions screen failed: ${messageOf(error)}`, "error");
				}
			},
		});

		}

		async function gateCall(event: any, ctx: ExtensionContext) {
			// Another copy of this extension already gates this session.
			if (passive) return undefined;
			const input = event.input as unknown as Record<string, unknown>;
			try {
				// These pi-subagents tools carry questions and progress only. They
				// must stay usable even when a file or permission call is blocked.
				if ((event.toolName === "ask_parent" || event.toolName === "notify_parent")
					&& pi.getActiveTools().includes("ask_parent")) return undefined;
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
		}
		pi.on("tool_call", gateCall);

		pi.on("tool_result", async (event) => {
			authorizedCalls.delete(event.toolCallId);
		});

		pi.on("session_start", async (_event, ctx) => {
			clearApprovals();
			activeCtx = ctx;
			const sessionId = sessionIdOf(ctx);
			store.bindSession(sessionId);
			try {
				store.reload();
			} catch {
				// An unreadable file keeps the state that was loaded in the constructor.
			}
			if (!claim(ctx)) {
				// Another copy of this extension owns this session and gates it.
				passive = true;
				return;
			}
			passive = false;
			// A session with a UI answers its own asks and its children's asks.
			if (ctx.hasUI) {
				setForwarder(sessionId, async (ask) => approvals.dialog(ask.tool, ask.input, ask.reason, ask.names, {
					hasUI: true,
					cwd: ctx.cwd,
					mode: ctx.mode,
					sessionManager: ctx.sessionManager,
					ui: ctx.ui,
				}));
			} else {
				dropForwarder(sessionId);
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

			publish(ctx);
		});

		// ask_parent is provided by pi-subagents. Keep its capability allowlist
		// unchanged and teach the child how to request a policy change instead.
		pi.on("before_agent_start", async (event, _ctx) => {
			if (passive || !pi.getActiveTools().includes("ask_parent")) return undefined;
			if (event.systemPrompt.includes(CHILD_PERMISSION_GUIDANCE)) return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n${CHILD_PERMISSION_GUIDANCE}` };
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			const sessionId = sessionIdOf(ctx);
			activeCtx = undefined;
			clearApprovals();
			dropForwarder(sessionId);
			releaseSession(sessionId, token);
			claimed.delete(sessionId);
			try {
				ctx.ui.setStatus("permissions", undefined);
			} catch {
				// Nothing left to clear.
			}
		});

		// pi-subagents runs children in this process and announces them here.
		// The announcement lands before the child binds, so its gate exists for
		// the child's first call, and its asks reach this session's dialog.
		// An older host without the event bus simply publishes no announcements.
		pi.events?.on("subagents:child:session-created", (payload: unknown) => {
			const data = payload as { sessionId?: unknown; parentSessionId?: unknown } | undefined;
			const childId = typeof data?.sessionId === "string" ? data.sessionId : undefined;
			if (childId === undefined) return;
			const parentId = typeof data?.parentSessionId === "string" ? data.parentSessionId : undefined;
			const ownId = activeCtx === undefined ? undefined : sessionIdOf(activeCtx);
			setChild(childId, { parentSessionId: parentId ?? ownId ?? "" });
		});
		pi.events?.on("subagents:child:disposed", (payload: unknown) => {
			const data = payload as { sessionId?: unknown } | undefined;
			if (typeof data?.sessionId === "string") dropChild(data.sessionId);
		});
	} catch (error) {
		throw error;
	}
}
