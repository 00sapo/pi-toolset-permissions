import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { PiToolBridge } from "./bridge.ts";

const tools = [{ type: "function", function: { name: "example", description: "Example", parameters: { type: "object" } } }];
function harness(timeoutMs = 1000) {
	const sent: any[] = [];
	const ui: any[] = [];
	const bridge = new PiToolBridge({ token: "secret", send: (r) => { sent.push(r); }, onUI: (r) => { ui.push(r); return { confirmed: true }; }, timeoutMs });
	return { bridge, sent, ui };
}
async function request(bridge: PiToolBridge, body: unknown = { tools }, auth = "Bearer secret", path = "/v1/chat/completions", method = "POST") {
	const req = new EventEmitter() as any;
	Object.assign(req, { headers: { authorization: auth }, url: path, method });
	let text = "";
	const res = { statusCode: 200, setHeader() {}, end(value = "") { text += value; } } as any;
	const done = bridge.handleRequest(req, res);
	req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
	req.emit("end");
	await done;
	return { status: res.statusCode, text, chunks: text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))) };
}
async function discover(h = harness()) {
	const pending = h.bridge.discover();
	const reply = await request(h.bridge);
	assert.equal(reply.chunks[0].choices[0].finish_reason, "stop");
	h.bridge.onRecord({ type: "agent_settled", aborted: false });
	assert.deepEqual(await pending, tools);
	return h;
}
async function launch(h: ReturnType<typeof harness>, signal?: AbortSignal, onUpdate?: (r: unknown) => void) {
	const promise = h.bridge.execute("example", { text: "hello" }, signal, onUpdate);
	const response = await request(h.bridge);
	const call = response.chunks[0].choices[0].delta.tool_calls[0];
	assert.equal(call.function.name, "example");
	assert.equal(call.function.arguments, '{"text":"hello"}');
	assert.ok(response.text.endsWith("data: [DONE]\n\n"));
	return { promise, id: call.id };
}
function root(bridge: PiToolBridge, id: string, type: string, extra = {}) {
	bridge.onRecord({ type, toolCallId: id, toolName: "example", args: { text: "hello" }, ...extra });
}

test("a user dialog does not consume the protocol timeout", async () => {
	let answer: (reply: any) => void = () => {};
	const h = harness(20);
	const bridge = new PiToolBridge({
		token: "secret", send: () => {}, timeoutMs: 20,
		onUI: () => new Promise((resolve) => { answer = resolve; }),
	});
	const discovered = bridge.discover();
	const first = await request(bridge);
	assert.equal(first.status, 200);
	bridge.onRecord({ type: "agent_settled" });
	assert.deepEqual(await discovered, tools);
	const pending = bridge.execute("example", { text: "hello" });
	const call = (await request(bridge)).chunks[0].choices[0].delta.tool_calls[0];
	bridge.onRecord({ type: "tool_execution_start", toolCallId: call.id, toolName: "example", args: { text: "hello" } });
	bridge.onRecord({ type: "extension_ui_request", id: "ask", method: "confirm", title: "Allow", message: "?" });
	await new Promise((resolve) => setTimeout(resolve, 60));
	answer({ confirmed: true });
	await new Promise((resolve) => setTimeout(resolve, 5));
	bridge.onRecord({ type: "tool_execution_end", toolCallId: call.id, toolName: "example", result: { content: [] }, isError: false });
	bridge.onRecord({ type: "agent_settled" });
	assert.deepEqual(await pending, { result: { content: [] }, isError: false });
	h.bridge.close();
	bridge.close();
});

test("discovery captures metadata without a tool call and waits for settled", async () => {
	const h = harness();
	let settled = false;
	const pending = h.bridge.discover().then((value) => { settled = true; return value; });
	assert.equal(h.sent[0].type, "prompt");
	const reply = await request(h.bridge);
	assert.equal(reply.chunks[0].object, "chat.completion.chunk");
	assert.equal(reply.chunks[0].choices[0].delta.tool_calls, undefined);
	h.bridge.onRecord({ type: "agent_end" });
	await Promise.resolve();
	assert.equal(settled, false);
	h.bridge.onRecord({ type: "agent_settled" });
	assert.deepEqual(await pending, tools);
	h.bridge.close();
});

test("execution preserves structured result, root updates, unique IDs, and settlement", async () => {
	const h = await discover();
	const updates: unknown[] = [];
	const { promise, id } = await launch(h, undefined, (r) => updates.push(r));
	root(h.bridge, id, "tool_execution_start");
	h.bridge.onRecord({ type: "tool_execution_start", toolCallId: "nested", toolName: "other", parentToolCallId: id });
	h.bridge.onRecord({ type: "tool_execution_update", toolCallId: "nested", parentToolCallId: id, partialResult: "ignore" });
	root(h.bridge, id, "tool_execution_update", { partialResult: { details: 1 } });
	h.bridge.onRecord({ type: "tool_execution_end", toolCallId: "nested", parentToolCallId: id });
	const result = { content: [{ type: "image", data: "abc", mimeType: "image/png" }], details: { values: [1, 2] } };
	root(h.bridge, id, "tool_execution_end", { result, isError: true });
	let finished = false;
	void promise.then(() => { finished = true; });
	const followup = await request(h.bridge);
	assert.equal(followup.chunks[0].choices[0].finish_reason, "stop");
	assert.equal(followup.chunks[0].choices[0].delta.tool_calls, undefined);
	h.bridge.onRecord({ type: "agent_end" });
	await Promise.resolve();
	assert.equal(finished, false);
	h.bridge.onRecord({ type: "agent_settled" });
	assert.deepEqual(await promise, { result, isError: true });
	assert.deepEqual(updates, [{ details: 1 }]);
	const next = await launch(h);
	assert.notEqual(next.id, id);
	h.bridge.close();
	await assert.rejects(next.promise, /closed/i);
});

test("discovery supports an empty tool inventory", async () => {
	const h = harness();
	const p = h.bridge.discover();
	assert.equal((await request(h.bridge, {})).status, 200);
	h.bridge.onRecord({ type: "agent_settled" });
	assert.deepEqual(await p, []);
	h.bridge.close();
});

test("unknown tools and busy operations reject without queueing", async () => {
	const h = await discover();
	await assert.rejects(h.bridge.execute("missing", {}), /unknown tool/i);
	const p = h.bridge.discover();
	const count = h.sent.length;
	await assert.rejects(h.bridge.execute("example", {}), /busy/i);
	await assert.rejects(h.bridge.discover(), /busy/i);
	assert.equal(h.sent.length, count);
	h.bridge.close();
	await assert.rejects(p, /closed/i);
});

test("abort and timeout send abort and permanently poison the bridge", async () => {
	for (const mode of ["abort", "timeout", "preaborted"]) {
		const h = harness(mode === "timeout" ? 10 : 1000);
		const controller = new AbortController();
		if (mode === "preaborted") controller.abort();
		const p = h.bridge.discover(controller.signal);
		const rejected = assert.rejects(p, mode === "timeout" ? /timeout/i : /abort/i);
		if (mode === "abort") controller.abort();
		await rejected;
		assert.equal(h.sent.at(-1).type, "abort");
		h.bridge.onRecord({ type: "agent_settled" });
		await assert.rejects(h.bridge.discover(), /abort|timeout/i);
	}
});

test("RPC failures, provider errors, handled prompts, child exit, and missing result reject", async () => {
	for (const mode of ["response", "provider", "handled", "exit", "missing", "stream"]) {
		const h = harness();
		const p = h.bridge.discover();
		const rejected = assert.rejects(p);
		if (mode === "response") h.bridge.onRecord({ type: "response", id: h.sent[0].id, success: false, error: "rejected" });
		if (mode === "provider") h.bridge.onRecord({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" } });
		if (mode === "handled") h.bridge.onRecord({ type: "response", id: h.sent[0].id, success: true, data: { disposition: "handled" } });
		if (mode === "exit") h.bridge.fail(new Error("Child exited: 1"));
		if (mode === "missing") h.bridge.onRecord({ type: "agent_settled" });
		if (mode === "stream") h.bridge.onRecord({ type: "message_update", assistantMessageEvent: { type: "error", error: { errorMessage: "provider failed" } } });
		await rejected;
	}
});

test("unsolicited, wrong, duplicate, and mutated root starts poison", async () => {
	for (const mode of ["discovery", "wrong", "idle", "duplicate", "args"]) {
		const h = mode === "discovery" ? harness() : await discover();
		let id = "wrong";
		let p: Promise<unknown> | undefined;
		if (mode === "discovery") p = h.bridge.discover();
		else if (mode !== "idle") { const call = await launch(h); p = call.promise; if (mode !== "wrong") id = call.id; }
		const rejected = p ? assert.rejects(p, /unsolicited|unexpected/i) : Promise.resolve();
		if (mode === "duplicate") root(h.bridge, id, "tool_execution_start");
		root(h.bridge, id, "tool_execution_start", mode === "args" ? { args: { text: "mutated" } } : {});
		await rejected;
		await assert.rejects(h.bridge.discover(), /unsolicited|unexpected/i);
		assert.equal(h.sent.at(-1).type, "abort");
	}
});

test("HTTP requires authentication, exact route and POST, and bounded valid JSON", async () => {
	const h = harness();
	assert.equal((await request(h.bridge, {}, "Bearer wrong")).status, 401);
	assert.equal((await request(h.bridge, {}, "Bearer secret", "/else")).status, 404);
	assert.equal((await request(h.bridge, {}, "Bearer secret", "/v1/chat/completions", "GET")).status, 405);
	assert.equal(h.sent.length, 0);
	for (const body of ["x".repeat(1024 * 1024 + 1), "{invalid", { tools: [{ type: "function" }] }]) {
		const b = harness().bridge;
		const p = b.discover();
		const rejected = assert.rejects(p, /body|JSON/i);
		assert.equal((await request(b, body)).status, typeof body === "string" && body.length > 1024 * 1024 ? 413 : 400);
		await rejected;
	}
	h.bridge.close();
});

test("duplicate model requests cannot emit another call", async () => {
	const h = await discover();
	const { promise } = await launch(h);
	const rejected = assert.rejects(promise, /duplicate/i);
	assert.equal((await request(h.bridge)).status, 409);
	await rejected;
});

test("strict LF framing preserves Unicode separators and split UTF-8", async () => {
	const h = harness();
	const p = h.bridge.discover();
	await request(h.bridge);
	const data = Buffer.from(JSON.stringify({ type: "extension_ui_request", id: "ui", method: "confirm", message: "a\u2028b\u2029c🎵" }) + "\r\n" + JSON.stringify({ type: "agent_settled" }) + "\n");
	assert.equal(h.bridge.token, "secret");
	for (const byte of data) h.bridge.feed(Buffer.from([byte]));
	await p;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.ui[0].message, "a\u2028b\u2029c🎵");
	assert.deepEqual(h.sent.at(-1), { type: "extension_ui_response", id: "ui", confirmed: true });
	h.bridge.close();
});

test("execution cancellation poisons and ignores a late matching result", async () => {
	const h = await discover();
	const controller = new AbortController();
	const { promise, id } = await launch(h, controller.signal);
	const rejected = assert.rejects(promise, /abort/i);
	controller.abort();
	root(h.bridge, id, "tool_execution_start");
	root(h.bridge, id, "tool_execution_end", { result: { details: "late" }, isError: false });
	h.bridge.onRecord({ type: "agent_settled" });
	await rejected;
	await assert.rejects(h.bridge.execute("example", {}), /abort/i);
});

test("unparented or orphan nested events poison the bridge", async () => {
	for (const parent of [undefined, "unknown"]) {
		const h = await discover();
		const { promise, id } = await launch(h);
		const rejected = assert.rejects(promise, /unexpected/i);
		root(h.bridge, id, "tool_execution_start");
		h.bridge.onRecord({ type: "tool_execution_start", toolCallId: "child", toolName: "other", ...(parent ? { parentToolCallId: parent } : {}) });
		await rejected;
	}
});

test("send failures and malformed RPC reject explicitly", async () => {
	for (const mode of ["throw", "reject", "json"]) {
		const bridge = new PiToolBridge({ token: "x", send: () => { if (mode === "throw") throw new Error("write failed"); if (mode === "reject") return Promise.reject(new Error("write failed")); } });
		const p = bridge.discover();
		if (mode === "json") bridge.onData("not json\n");
		await assert.rejects(p);
	}
});
