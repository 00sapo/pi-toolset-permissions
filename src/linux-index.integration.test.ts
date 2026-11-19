import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The Linux entry point must install the approval gate, not return early for the
// isolated executor. This test keeps the real index.ts wiring and stubs the rest.
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		let source: string | undefined;
		if (specifier === "@earendil-works/pi-coding-agent") {
			source = "export const createBashTool = () => ({ name: 'bash' }); export const createPowerShellTool = createBashTool;";
		} else if (specifier === "./isolated.ts" && context.parentURL?.endsWith("/index.ts")) {
			source = "export const install = (_pi, options) => { globalThis.__isolatedOptions = options; };";
		} else if (specifier === "./platform.ts" && context.parentURL?.endsWith("/index.ts")) {
			source = "export const platformPolicy = () => ({ plan: 'isolated' }); export const layersEnabled = () => true;";
		} else if (specifier === "./ui.ts" && context.parentURL?.endsWith("/index.ts")) {
			source = "export const openPermissions = async () => {};";
		} else if (specifier === "./tool.ts" && context.parentURL?.endsWith("/index.ts")) {
			source = `export const statusLine = () => '';
export function registerPermissionsTool(pi, store, publish, approvals) {
 pi.registerTool({ name: 'permissions', execute: async (_id, params, _signal, _update, ctx) =>
 approvals.request(store, params.tool, params.input, params.reason, ctx) });
}`;
		}
		if (source !== undefined) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const { default: extension } = await import("./index.ts");
hooks.deregister();

test("the Linux entry point installs the approval gate for every tool", async (t) => {
	const { StateStore } = await import("./state.ts");
	const cwd = mkdtempSync(join(tmpdir(), "pi-linux-index-"));
	const previous = process.env.PI_PERMISSIONS_FILE;
	process.env.PI_PERMISSIONS_FILE = join(cwd, "permissions.json");
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	let answer = "Block";
	const ctx = { cwd, hasUI: true, mode: "rpc", sessionManager: { getSessionId: () => "ask-root", getBranch: () => [] }, ui: {
		setStatus() {}, select: async () => answer, input: async () => undefined,
	} };
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
		if (previous === undefined) delete process.env.PI_PERMISSIONS_FILE;
		else process.env.PI_PERMISSIONS_FILE = previous;
		rmSync(cwd, { recursive: true, force: true });
	});
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {},
		on: (name: string, fn: Function) => handlers.set(name, fn), getActiveTools: () => [], getAllTools: () => [] } as any);
	var installed = (globalThis as any).__isolatedOptions;
	assert.equal(typeof installed?.approve, "function", "index.ts must hand its gate to the isolated installer");
	await handlers.get("session_start")!({ reason: "startup" }, ctx);
	const store: StateStore = installed.store;
	store.update((state) => ({ ...state, toolsets: state.toolsets.map((entry) =>
		["read", "write", "execute"].includes(entry.name) ? { ...entry, enabled: "ask" } : entry) }));
	const gate = (toolName: string, input: Record<string, unknown>, toolCallId: string) =>
		handlers.get("tool_call")!({ toolName, input, toolCallId }, ctx);
	// Every effect needs approval before it runs, including a read.
	for (const [tool, input] of [["read", { path: join(cwd, "a.txt") }], ["write", { path: join(cwd, "b.txt"), content: "x" }], ["bash", { command: "pwd" }]] as const) {
		const decision = await gate(tool, { ...input }, `call-${tool}`);
		assert.equal(decision?.block, true, tool);
		assert.match(decision.reason, /denied/i);
	}
	// The isolated path asks through the same gate, and an off toolset stays closed.
	assert.equal((store.get().toolsets.find((entry) => entry.name === "read")!.enabled), "ask");
	const off = await installed.approve({ toolName: "read", toolCallId: "off", input: { path: join(cwd, "a.txt") } }, ctx);
	assert.equal(off.block, true);
	store.update((state) => ({ ...state, toolsets: state.toolsets.map((entry) =>
		entry.name === "read" ? { ...entry, enabled: false } : entry) }));
	assert.equal((await installed.approve({ toolName: "read", toolCallId: "disabled", input: { path: join(cwd, "a.txt") } }, ctx)).block, true);
	// An exact one-call grant resumes the same call and never a different one.
	store.update((state) => ({ ...state, toolsets: state.toolsets.map((entry) =>
		entry.name === "read" ? { ...entry, enabled: "ask" } : entry) }));
	answer = "Allow once";
	const request = { action: "request_tool", tool: "read", input: { path: join(cwd, "a.txt") }, reason: "Read the file." };
	assert.equal(await gate("permissions", request, "request-1"), undefined);
	assert.match(await tools.get("permissions").execute("request-1", request, undefined, undefined, ctx), /Approved once/);
	assert.equal((await installed.approve({ toolName: "read", toolCallId: "granted", input: { path: join(cwd, "a.txt") } }, ctx))?.block, undefined);
	// The grant is bound to the call ID and input, so a new call asks again.
	answer = "Block";
	assert.equal((await installed.approve({ toolName: "read", toolCallId: "other", input: { path: join(cwd, "b.txt") } }, ctx)).block, true);
	// A child session inherits the parent policy and still asks the parent gate.
	const childCtx = { ...ctx, sessionManager: { getSessionId: () => "ask-child", getBranch: () => [] }, hasUI: false };
	assert.equal((await installed.approve({ toolName: "read", toolCallId: "child", input: { path: join(cwd, "c.txt") } }, childCtx)).block, true);
});
