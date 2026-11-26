import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { forwardBridgeUI, type BridgeUI } from "./bridge-ui.ts";

function fakeUI(result: string | boolean | undefined = "answer") {
	const calls: { method: string; args: unknown[] }[] = [];
	const dialog = (method: string) => async (...args: unknown[]) => {
		calls.push({ method, args });
		return result;
	};
	const effect = (method: string) => (...args: unknown[]) => { calls.push({ method, args }); };
	const ui: BridgeUI = {
		select: dialog("select") as BridgeUI["select"],
		confirm: dialog("confirm") as BridgeUI["confirm"],
		input: dialog("input") as BridgeUI["input"],
		editor: dialog("editor") as BridgeUI["editor"],
		notify: effect("notify"), setStatus: effect("setStatus"), setWidget: effect("setWidget"),
		setTitle: effect("setTitle"), setEditorText: effect("setEditorText"),
	};
	return { ui, calls };
}

const request = (method: string, fields: Record<string, unknown> = {}) => ({
	type: "extension_ui_request", id: "dialog-id", method, ...fields,
});
const response = (fields: Record<string, unknown>) => ({ type: "extension_ui_response", id: "dialog-id", ...fields });
const dialogs = [
	{ method: "select", fields: { title: "Pick", options: ["answer", "other"] }, args: ["Pick", ["answer", "other"], undefined] },
	{ method: "confirm", fields: { title: "Allow", message: "Continue?" }, args: ["Allow", "Continue?", undefined] },
	{ method: "input", fields: { title: "Name", placeholder: "Example" }, args: ["Name", "Example", undefined] },
	{ method: "editor", fields: { title: "Edit", prefill: "Line 1\nLine 2" }, args: ["Edit", "Line 1\nLine 2", undefined] },
] as const;

for (const { method, fields, args } of dialogs) {
	test(`${method} forwards arguments and matches the response id`, async () => {
		const { ui, calls } = fakeUI(method === "confirm" ? true : "answer");
		assert.deepEqual(await forwardBridgeUI(request(method, fields), ui), response(method === "confirm" ? { confirmed: true } : { value: "answer" }));
		assert.deepEqual(calls, [{ method, args }]);
	});
	test(`${method} cancels on undefined`, async () => {
		const { ui } = fakeUI();
		ui[method] = async () => undefined;
		assert.deepEqual(await forwardBridgeUI(request(method, fields), ui), response({ cancelled: true }));
	});
	test(`${method} skips UI when already aborted`, async () => {
		const { ui, calls } = fakeUI();
		assert.deepEqual(await forwardBridgeUI(request(method, fields), ui, AbortSignal.abort()), response({ cancelled: true }));
		assert.equal(calls.length, 0);
	});
	test(`${method} cancels a pending dialog even if UI ignores the signal`, async () => {
		const { ui } = fakeUI();
		ui[method] = () => new Promise(() => {});
		const controller = new AbortController();
		const pending = forwardBridgeUI(request(method, fields), ui, controller.signal);
		controller.abort();
		assert.deepEqual(await pending, response({ cancelled: true }));
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});
}

test("false confirmation and empty text are answers, not cancellations", async () => {
	assert.deepEqual(await forwardBridgeUI(request("confirm", { title: "Allow", message: "?" }), fakeUI(false).ui), response({ confirmed: false }));
	for (const method of ["input", "editor"]) {
		assert.deepEqual(await forwardBridgeUI(request(method, { title: "Text" }), fakeUI("").ui), response({ value: "" }));
	}
});

test("passes signal and timeout to supported dialogs and removes listeners", async () => {
	for (const { method, fields } of dialogs) {
		const { ui, calls } = fakeUI(method === "confirm" ? true : "answer");
		const controller = new AbortController();
		await forwardBridgeUI(request(method, { ...fields, timeout: 1000 }), ui, controller.signal);
		assert.deepEqual(calls[0].args[2], { signal: controller.signal, timeout: 1000 });
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	}
});

test("fire-and-forget methods return no response and isolate status and widget keys", async () => {
	const { ui, calls } = fakeUI();
	const cases: [string, Record<string, unknown>, string, unknown[]][] = [
		["notify", { message: "Hello" }, "notify", ["Hello", "info"]],
		...["info", "warning", "error"].map(type => ["notify", { message: "Notice", notifyType: type }, "notify", ["Notice", type]] as [string, Record<string, unknown>, string, unknown[]]),
		["setStatus", { statusKey: "key", statusText: "Ready" }, "setStatus", ["isolated:key", "Ready"]],
		["setStatus", { statusKey: "key" }, "setStatus", ["isolated:key", undefined]],
		["setWidget", { widgetKey: "key", widgetLines: ["One"], widgetPlacement: "belowEditor" }, "setWidget", ["isolated:key", ["One"], { placement: "belowEditor" }]],
		["setWidget", { widgetKey: "key" }, "setWidget", ["isolated:key", undefined, { placement: "aboveEditor" }]],
		["setTitle", { title: "Title" }, "setTitle", ["Title"]],
		["set_editor_text", { text: "" }, "setEditorText", [""]],
	];
	for (const [method, fields, target, args] of cases) {
		assert.equal(await forwardBridgeUI(request(method, fields), ui), undefined);
		assert.deepEqual(calls.at(-1), { method: target, args });
	}
});

test("rejects unsupported and malformed requests before calling UI", async () => {
	const { ui, calls } = fakeUI();
	const invalid: unknown[] = [null, [], "request", {}, request("custom"), request("__proto__"),
		request("input", { id: 1, title: "Text" }), request("input", { type: "response", title: "Text" }),
		request("input", { title: 1 }), request("input", { title: "Text", placeholder: null }),
		request("editor", { title: "Edit", prefill: [] }), request("confirm", { title: "Allow", message: false }),
		request("select", { title: "Pick", options: "one" }), request("select", { title: "Pick", options: ["one", 2] }),
		request("select", { title: "Pick", options: new Array(1) }),
		request("notify", { message: {} }), request("notify", { message: "Hello", notifyType: "success" }),
		request("notify", { message: "Hello", notifyType: null }), request("setStatus", { statusKey: 1 }),
		request("setStatus", { statusKey: "key", statusText: false }), request("setWidget", { widgetKey: "key", widgetLines: [1] }),
		request("setWidget", { widgetKey: "key", widgetPlacement: "side" }), request("setTitle", { title: null }),
		request("set_editor_text", { text: {} }), request("input", { title: "Text", timeout: "1" }),
		request("input", { title: "Text", timeout: -1 }), request("input", { title: "Text", timeout: Infinity }),
	];
	for (const value of invalid) await assert.rejects(forwardBridgeUI(value, ui), Error);
	assert.equal(calls.length, 0);
});

test("UI errors propagate unchanged rather than becoming cancellation", async () => {
	for (const asynchronous of [false, true]) {
		const { ui } = fakeUI();
		const error = new Error("UI failure");
		ui.input = () => { if (asynchronous) return Promise.reject(error); throw error; };
		const controller = new AbortController();
		await assert.rejects(forwardBridgeUI(request("input", { title: "Text" }), ui, controller.signal), e => e === error);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		ui.notify = () => { throw error; };
		await assert.rejects(forwardBridgeUI(request("notify", { message: "Hello" }), ui), e => e === error);
	}
});

test("aborted fire-and-forget requests have no side effects", async () => {
	const { ui, calls } = fakeUI();
	assert.equal(await forwardBridgeUI(request("notify", { message: "Hello" }), ui, AbortSignal.abort()), undefined);
	assert.equal(calls.length, 0);
});

test("invalid dialog results reject instead of producing malformed responses", async () => {
	await assert.rejects(forwardBridgeUI(request("input", { title: "Text" }), fakeUI(false).ui), /Invalid UI dialog result/);
	await assert.rejects(forwardBridgeUI(request("confirm", { title: "Allow", message: "?" }), fakeUI("yes").ui), /Invalid UI dialog result/);
});

test("late dialog rejection after cancellation is handled", async () => {
	const { ui } = fakeUI();
	let reject!: (error: Error) => void;
	ui.editor = () => new Promise((_resolve, fail) => { reject = fail; });
	const controller = new AbortController();
	const pending = forwardBridgeUI(request("editor", { title: "Edit" }), ui, controller.signal);
	controller.abort();
	assert.deepEqual(await pending, response({ cancelled: true }));
	reject(new Error("Late failure"));
	await new Promise(resolve => setImmediate(resolve));
});


test("subagent RPC snapshots clear the duplicate widget without touching native status", async () => {
	const { ui, calls } = fakeUI();
	for (const widgetLines of [["PI_SUBAGENT_ASYNC_JSON:{\"runs\":[]}"], undefined]) {
		assert.equal(await forwardBridgeUI(request("setWidget", {
			widgetKey: "subagent-async", widgetLines,
		}), ui), undefined);
		assert.deepEqual(calls.at(-1), {
			method: "setWidget", args: ["isolated:subagent-async", undefined, { placement: "aboveEditor" }],
		});
	}
	assert.equal(calls.length, 2);
});
