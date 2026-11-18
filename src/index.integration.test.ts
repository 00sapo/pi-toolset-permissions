import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "./state.ts";

// Isolate host imports. Keep the real extension wiring, store, gate, and approvals.
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		let source: string | undefined;
		if (specifier === "@earendil-works/pi-coding-agent") {
			source = "export const createBashTool = () => ({ name: 'bash' }); export const createPowerShellTool = createBashTool;";
		} else if (specifier === "./isolated.ts" && context.parentURL?.endsWith("/index.ts")) {
			source = "export const install = () => {};";
		} else if (specifier === "./platform.ts" && context.parentURL?.endsWith("/index.ts")) {
			// This test covers the shell-only gate. Linux executor tests cover delegation separately.
			source = "export const platformPolicy = () => ({ plan: 'bash-only' }); export const layersEnabled = () => true;";
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

test("extension wiring preserves an exact bash approval across request and reload", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-gate-integration-"));
	const previous = process.env.PI_PERMISSIONS_FILE;
	process.env.PI_PERMISSIONS_FILE = join(cwd, "permissions.json");
	const store = new StateStore();
	store.update((state) => ({ ...state, toolsets: state.toolsets.map((entry) =>
		entry.name === "execute" ? { ...entry, enabled: "ask" } : entry) }));
	const handlers = new Map<string, Function>();
	const tools = new Map<string, any>();
	let answer = "Block";
	const ctx = { cwd, hasUI: true, ui: {
		setStatus() {}, select: async () => answer, input: async () => undefined,
	} };
	const approve = async (id: string, request: unknown) => {
		answer = "Allow once";
		try { return await tools.get("permissions").execute(id, request, undefined, undefined, ctx); }
		finally { answer = "Block"; }
	};
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
		if (previous === undefined) delete process.env.PI_PERMISSIONS_FILE;
		else process.env.PI_PERMISSIONS_FILE = previous;
		rmSync(cwd, { recursive: true, force: true });
	});
	extension({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand() {}, on: (name: string, fn: Function) => handlers.set(name, fn),
	} as any);
	await handlers.get("session_start")!({}, ctx);
	let sequence = 0;
	const gate = (toolName: string, input: Record<string, unknown>, toolCallId = `call-${++sequence}`) =>
		handlers.get("tool_call")!({ toolName, input, toolCallId }, ctx);
	const input = { command: "pwd", timeout: 120 };
	assert.equal((await gate("bash", input)).block, true);
	const request = { action: "request_tool", tool: "bash", input, reason: "Read the current directory." };
	assert.equal(await gate("permissions", request), undefined);
	assert.match(await approve("request", request), /Approved once/);
	// Registering the same extension twice must not install a second stale gate.
	extension({ on() { assert.fail("duplicate registration"); } } as any);
	assert.equal(await gate("bash", { timeout: 120, command: "pwd" }, "approved-call"), undefined);
	// Repeated preflight of one call must not consume another one-time grant.
	assert.equal(await gate("bash", { ...input }, "approved-call"), undefined);
	assert.equal((await gate("bash", { ...input, timeout: 121 }, "approved-call")).block, true);
	assert.equal((await gate("powershell", input, "approved-call")).block, true);
	assert.equal((await gate("bash", input)).block, true);
	await handlers.get("tool_result")!({ toolCallId: "approved-call" }, ctx);
	assert.equal((await gate("bash", input, "approved-call")).block, true);
	// Current policy still wins over authorization attached to a call ID.
	store.update((state) => ({ ...state, toolsets: state.toolsets.map((entry) =>
		entry.name === "execute" ? { ...entry, enabled: false } : entry) }));
	assert.equal((await gate("bash", input, "approved-call")).block, true);
	store.update((state) => ({ ...state, toolsets: state.toolsets.map((entry) =>
		entry.name === "execute" ? { ...entry, enabled: "ask" } : entry) }));

	assert.equal(await gate("permissions", request), undefined);
	assert.match(await approve("request2", request), /Approved once/);
	// Characterize the suspected mismatch without treating it as an observed Pi behavior.
	assert.equal((await gate("bash", { ...input, extra: undefined })).block, true);
	assert.equal((await gate("bash", { ...input, timeout: "120" })).block, true);
	assert.equal(await gate("bash", input), undefined);

	// Pi 1.5.2 reload awaits old shutdown before loading replacement copies.
	assert.match(await approve("before-reload", request), /Approved once/);
	await handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
	handlers.clear();
	tools.clear();
	extension({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand() {}, on: (name: string, fn: Function) => handlers.set(name, fn),
	} as any);
	extension({ on() { assert.fail("duplicate replacement registration"); } } as any);
	await handlers.get("session_start")!({ reason: "reload" }, ctx);
	assert.equal((await gate("bash", input, "approved-call")).block, true);
	assert.match(await approve("after-reload", request), /Approved once/);
	assert.equal(await gate("bash", input), undefined);
	assert.equal((await gate("bash", input)).block, true);
});

test("direct ask approval resumes the same event and uses current assistant text", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-inline-approval-"));
	const previous = process.env.PI_PERMISSIONS_FILE;
	process.env.PI_PERMISSIONS_FILE = join(cwd, "permissions.json");
	const store = new StateStore();
	store.update((state) => ({ ...state, toolsets: state.toolsets.map((entry) =>
		entry.name === "execute" ? { ...entry, enabled: "ask" } : entry) }));
	const handlers = new Map<string, Function>();
	let answer = "Allow once";
	let dialogs = 0;
	let title = "";
	let branch: any[] = [{ type: "message", message: { role: "assistant", content: [
		{ type: "thinking", thinking: "Private reasoning" },
		{ type: "text", text: "Read the current directory to locate the project." },
		{ type: "toolCall", id: "direct", name: "bash", arguments: { command: "pwd" } },
	] } }];
	const ctx = { cwd, hasUI: true, sessionManager: { getBranch: () => branch }, ui: {
		setStatus() {},
		select: async (text: string, choices: string[]) => {
			dialogs += 1;
			title = text;
			return answer === "enable" ? choices[3] : answer;
		},
		input: async () => "Use the project files instead.",
	} };
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
		if (previous === undefined) delete process.env.PI_PERMISSIONS_FILE;
		else process.env.PI_PERMISSIONS_FILE = previous;
		rmSync(cwd, { recursive: true, force: true });
	});
	extension({ registerTool() {}, registerCommand() {},
		on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
	await handlers.get("session_start")!({}, ctx);
	const gate = (id: string, input = { command: "pwd" }) =>
		handlers.get("tool_call")!({ toolName: "bash", toolCallId: id, input }, ctx);
	// The only target event returns permission to execute without a request_tool call.
	assert.equal(await gate("direct"), undefined);
	assert.equal(dialogs, 1);
	assert.match(title, /Read the current directory to locate the project/);
	assert.doesNotMatch(title, /Private reasoning/);
	assert.equal(await gate("direct"), undefined);
	assert.equal(dialogs, 1);
	answer = "Deny with explanation";
	const refused = await gate("denied");
	assert.equal(refused.block, true);
	assert.match(refused.reason, /Use the project files instead/);
	assert.equal(dialogs, 2);
	// The latest assistant message has no text. Do not reuse an older reason.
	branch.push({ type: "message", message: { role: "assistant", content: [
		{ type: "toolCall", id: "next", name: "bash", arguments: { command: "pwd" } },
	] } });
	answer = "Deny";
	assert.equal((await gate("next")).block, true);
	assert.match(title, /This agent did not provide a specific reason for this call/);
	assert.doesNotMatch(title, /Read the current directory/);
	// A newer user request also prevents an old explanation from leaking forward.
	branch = [branch[0], { type: "message", message: { role: "user", content: "Different task" } }];
	assert.equal((await gate("new-task")).block, true);
	assert.match(title, /Current task: Different task/);
	answer = "enable";
	assert.equal(await gate("enable"), undefined);
	assert.equal(new StateStore().get().toolsets.find((entry) => entry.name === "execute")?.enabled, true);
	const count = dialogs;
	assert.equal(await gate("enabled"), undefined);
	assert.equal(dialogs, count);
});
