import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Sessions that one loaded copy already gates. The command line loads this file in the
 * root session, and inherited settings load it again in each child session. Both copies
 * share this process, so ownership is keyed by session and never by module.
 */
const OWNED = Symbol.for("pi-toolset-permissions.inner-model.sessions");
function owners(): Map<string, object> {
	const slot = globalThis as unknown as Record<symbol, Map<string, object> | undefined>;
	let current = slot[OWNED];
	if (current === undefined) { current = new Map(); slot[OWNED] = current; }
	return current;
}

export default function innerModel(pi: ExtensionAPI): void {
	const endpoint = process.env.PI_PARENT_MODEL_URL;
	const token = process.env.PI_BRIDGE_TOKEN;
	if (!endpoint || !token) throw new Error("The parent model relay is not configured.");
	pi.registerProvider("sandbox-parent", {
		api: "sandbox-parent", apiKey: token, baseUrl: endpoint,
		models: [{ id: "parent", name: "Parent model", api: "sandbox-parent", reasoning: false,
			input: ["text", "image"], contextWindow: 128000, maxTokens: 16384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple: (_model: any, context: any, options: any) => {
			const output = createAssistantMessageEventStream();
			void (async () => {
				try {
					const response = await fetch(endpoint + "/model", { method: "POST", headers: {
						Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
						body: JSON.stringify(context), signal: options?.signal });
					if (!response.ok || !response.body) throw new Error(await response.text());
					let buffer = ""; const decoder = new TextDecoder();
					for await (const chunk of response.body as any) {
						buffer += decoder.decode(chunk, { stream: true });
						let newline: number;
						while ((newline = buffer.indexOf("\n")) !== -1) {
							const event = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
							if (event.relayError) throw new Error(event.relayError);
							output.push(event);
							if (event.type === "done" || event.type === "error") { output.end(); return; }
						}
					}
					throw new Error("The parent model stream ended early.");
				} catch (error) {
					output.push({ type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error: {
						role: "assistant", content: [], api: "sandbox-parent", provider: "sandbox-parent", model: "parent",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input:0,output:0,cacheRead:0,cacheWrite:0,total:0} },
						stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
					} } as any); output.end();
				}
			})();
			return output;
		},
	} as any);
	const owner = {};
	let owns = false;
	let rootSession: string | undefined;
	pi.on("session_start", (_event, ctx) => {
		// Each loaded copy owns one session. The CLI root alone receives injected calls.
		if (process.env.PI_PARENT_RELAY_ROOT === undefined) {
			process.env.PI_PARENT_RELAY_ROOT = ctx.sessionManager.getSessionId();
		}
		rootSession = ctx.sessionManager.getSessionId();
		owns = owners().get(rootSession) === owner;
		if (!owns && !owners().has(rootSession)) { owners().set(rootSession, owner); owns = true; }
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.sessionManager.getSessionId() === rootSession && owners().get(rootSession) === owner) owners().delete(rootSession);
	});
	pi.on("tool_call", async (event: any, ctx) => {
		// One copy per session answers. A duplicate copy in the same session stays quiet.
		if (!owns || owners().get(ctx.sessionManager.getSessionId()) !== owner) return undefined;
		if (rootSession === process.env.PI_PARENT_RELAY_ROOT && /^bridge_[^/]+$/.test(event.toolCallId)) return;
		const response = await fetch(endpoint + "/permissions", { method: "POST", headers: {
			Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(event), signal: ctx.signal });
		if (!response.ok) return { block: true, reason: "The parent permission gate is unavailable." };
		return await response.json();
	});
}
