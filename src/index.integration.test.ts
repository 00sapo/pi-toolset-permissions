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
	// A second copy in the same session must not install a second stale gate. It
	// registers its handlers, then stands down when it loses the session claim.
	const duplicate = new Map<string, Function>();
	extension({
		registerTool() {}, registerCommand() {},
		on: (name: string, fn: Function) => duplicate.set(name, fn),
	} as any);
	await duplicate.get("session_start")!({}, ctx);
	// The duplicate stays passive: it neither blocks nor approves the call.
	assert.equal(await duplicate.get("tool_call")!({ toolName: "bash", input, toolCallId: "duplicate" }, ctx), undefined);
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

test("a child session in the same process gets its own gate and asks its parent", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-child-session-"));
	const previous = process.env.PI_PERMISSIONS_FILE;
	const previousTimeout = process.env.PI_PERMISSIONS_ASK_TIMEOUT_MS;
	process.env.PI_PERMISSIONS_FILE = join(cwd, "permissions.json");
	process.env.PI_PERMISSIONS_ASK_TIMEOUT_MS = "2000";
	const store = new StateStore();
	// write is ask, so a child write has to reach a dialog that only the parent has.
	store.update((state) => ({ ...state, toolsets: state.toolsets.map((entry) =>
		entry.name === "write" ? { ...entry, enabled: "ask" } : entry) }));
	const parentHandlers = new Map<string, Function>();
	const childHandlers = new Map<string, Function>();
	const events = new Map<string, Function>();
	const parentSession = "parent-session";
	const childSession = "child-session";
	const dialogs: string[] = [];
	let answer = "Allow once";
	const makeCtx = (sessionId: string, hasUI: boolean) => ({
		cwd, hasUI, mode: hasUI ? "tui" : "rpc",
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
		ui: {
			setStatus() {},
			notify() {},
			select: async (title: string) => { dialogs.push(title); return answer; },
			input: async () => undefined,
		},
	});
	// A copy of the extension loads for the parent, then the child loads its own
	// copy in the same process, as a subagent does.
	const load = (handlers: Map<string, Function>) => extension({
		registerTool() {}, registerCommand() {},
		on: (name: string, fn: Function) => handlers.set(name, fn),
		events: { on: (name: string, fn: Function) => events.set(name, fn) },
	} as any);
	t.after(async () => {
		await parentHandlers.get("session_shutdown")?.({}, makeCtx(parentSession, true));
		await childHandlers.get("session_shutdown")?.({}, makeCtx(childSession, false));
		if (previous === undefined) delete process.env.PI_PERMISSIONS_FILE;
		else process.env.PI_PERMISSIONS_FILE = previous;
		if (previousTimeout === undefined) delete process.env.PI_PERMISSIONS_ASK_TIMEOUT_MS;
		else process.env.PI_PERMISSIONS_ASK_TIMEOUT_MS = previousTimeout;
		rmSync(cwd, { recursive: true, force: true });
	});
	const parentCtx = makeCtx(parentSession, true);
	const childCtx = makeCtx(childSession, false);
	load(parentHandlers);
	await parentHandlers.get("session_start")!({}, parentCtx);
	// pi-subagents announces the child before it binds.
	events.get("subagents:child:session-created")!({ sessionId: childSession, parentSessionId: parentSession });
	load(childHandlers);
	await childHandlers.get("session_start")!({}, childCtx);

	// The child gate is live: a path outside the roots is blocked there too.
	const outside = { path: "/etc/passwd" };
	const childBlocked = await childHandlers.get("tool_call")!({ toolName: "read", input: outside, toolCallId: "c1" }, childCtx);
	assert.equal(childBlocked.block, true);
	assert.match(childBlocked.reason, /outside the allowed roots/);

	// An ask call in the child waits for the parent dialog, not a local one.
	assert.equal(dialogs.length, 0);
	const childAsk = childHandlers.get("tool_call")!({ toolName: "write", input: { path: join(cwd, "note.txt") }, toolCallId: "c2" }, childCtx);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(dialogs.length, 1, "the parent session must run the dialog");
	assert.match(dialogs[0], /Allow this call/);
	assert.equal(await childAsk, undefined);

	// A refused child ask fails closed with the parent's answer.
	answer = "Deny";
	const refused = await childHandlers.get("tool_call")!({ toolName: "write", input: { path: join(cwd, "other.txt") }, toolCallId: "c3" }, childCtx);
	assert.equal(refused.block, true);
	assert.match(refused.reason, /denied this call/);
	await events.get("subagents:child:disposed")!({ sessionId: childSession });
});

test("a child without permissions uses ask_parent without changing its allowlist", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-child-tools-"));
	const previous = process.env.PI_PERMISSIONS_FILE;
	process.env.PI_PERMISSIONS_FILE = join(cwd, "permissions.json");
	const events = new Map<string, Function>();
	const parentHandlers = new Map<string, Function>();
	const childHandlers = new Map<string, Function>();
	// The host removes permissions from the executable registry, not just the
	// active tools. ask_parent is the child's supported escalation channel.
	const active = ["read", "bash", "ask_parent", "notify_parent"];
	const make = (handlers: Map<string, Function>) => extension({
		registerTool() {}, registerCommand() {},
		on: (name: string, fn: Function) => handlers.set(name, fn),
		events: { on: (name: string, fn: Function) => events.set(name, fn) },
		getAllTools: () => active.map((name) => ({ name })),
		getActiveTools: () => [...active],
		setActiveTools: () => assert.fail("the extension must preserve the child allowlist"),
	} as any);
	const ctxOf = (sessionId: string, hasUI: boolean) => ({
		cwd, hasUI, mode: "tui",
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
		ui: { setStatus() {}, notify() {}, select: async () => "Deny", input: async () => undefined },
	});
	t.after(async () => {
		await childHandlers.get("session_shutdown")?.({}, ctxOf("child-tools", false));
		await parentHandlers.get("session_shutdown")?.({}, ctxOf("parent-tools", true));
		if (previous === undefined) delete process.env.PI_PERMISSIONS_FILE;
		else process.env.PI_PERMISSIONS_FILE = previous;
		rmSync(cwd, { recursive: true, force: true });
	});
	make(parentHandlers);
	await parentHandlers.get("session_start")!({}, ctxOf("parent-tools", true));
	events.get("subagents:child:session-created")!({ sessionId: "child-tools", parentSessionId: "parent-tools" });
	make(childHandlers);
	await childHandlers.get("session_start")!({}, ctxOf("child-tools", false));
	assert.equal(active.includes("permissions"), false);
	const before = new StateStore().get();
	const result = await childHandlers.get("before_agent_start")!({ systemPrompt: "Child instructions." }, ctxOf("child-tools", false));
	assert.match(result.systemPrompt, /call ask_parent.*requested action, exact path or toolset, and purpose/);
	assert.match(result.systemPrompt, /end your turn and wait for the parent/);
	assert.match(result.systemPrompt, /parent must call permissions and obtain user consent/);
	assert.match(result.systemPrompt, /Retry only after the parent reports approval/);
	assert.match(result.systemPrompt, /If the user refuses, stop/);
	assert.match(result.systemPrompt, /Never use bash.*bypass a block/);
	assert.deepEqual(new StateStore().get(), before, "guidance does not grant access");
	assert.deepEqual(active, ["read", "bash", "ask_parent", "notify_parent"]);
	assert.equal(await childHandlers.get("before_agent_start")!({ systemPrompt: result.systemPrompt }, ctxOf("child-tools", false)), undefined);
	const gate = (toolName: string, input: Record<string, unknown>) => childHandlers.get("tool_call")!(
		{ toolName, input, toolCallId: "escalation" }, ctxOf("child-tools", false));
	assert.equal(await gate("ask_parent", { question: "Please request add_path for /root to read a file." }), undefined);
	assert.equal(await gate("notify_parent", { message: "Permission change needed." }), undefined);
	assert.deepEqual(new StateStore().get(), before);
	assert.equal((await gate("read", { path: "/root/private.txt" })).block, true);
	assert.equal((await gate("write", { path: join(cwd, "file.txt") })).block, true);
	// A session without the protocol tools gets neither guidance nor an exemption.
	active.splice(active.indexOf("ask_parent"), 1);
	assert.equal(await childHandlers.get("before_agent_start")!({ systemPrompt: "No parent tools." }, ctxOf("child-tools", false)), undefined);
	assert.equal((await gate("ask_parent", { question: "Not exposed here." })).block, true);
	await events.get("subagents:child:disposed")!({ sessionId: "child-tools" });
});
