import assert from "node:assert/strict";
import { test } from "node:test";
import { promptLabel, reportPrompts, suppressPrompts } from "./notify.ts";

/** A fake Pi API that records the handlers and the bus traffic. */
function harness() {
	const handlers = new Map<string, Function>();
	const sent: unknown[] = [];
	const pi = {
		events: { emit(name: string, data: unknown) { sent.push([name, data]); } },
		on(name: string, handler: Function) {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
	};
	const fire = (name: string, event?: unknown) => handlers.get(name)?.(event, {});
	return { pi, sent, fire, handlers };
}

test("a waiting question opens one block and its end closes it", () => {
	const { pi, fire, sent } = harness();
	reportPrompts(pi);
	fire("ui_prompt_start", { kind: "custom", title: "Allow this call?" });
	fire("ui_prompt_end", { kind: "custom", title: "Allow this call?" });
	assert.deepEqual(sent, [
		["herdr:blocked", { active: true, label: "Allow this call?" }],
		["herdr:blocked", { active: false }],
	]);
});

test("the next question after an answered one reports again", () => {
	const { pi, fire, sent } = harness();
	reportPrompts(pi);
	fire("ui_prompt_start", { kind: "custom", title: "Allow this call?" });
	fire("ui_prompt_end", { kind: "custom", title: "Allow this call?" });
	fire("ui_prompt_start", { kind: "select", title: "Unknown tool: acme" });
	fire("ui_prompt_end", { kind: "select", title: "Unknown tool: acme" });
	assert.deepEqual(sent, [
		["herdr:blocked", { active: true, label: "Allow this call?" }],
		["herdr:blocked", { active: false }],
		["herdr:blocked", { active: true, label: "Unknown tool: acme" }],
		["herdr:blocked", { active: false }],
	]);
});

test("a screen that the user opens reports nothing", async () => {
	const { pi, fire, sent } = harness();
	reportPrompts(pi);
	await suppressPrompts(async () => {
		fire("ui_prompt_start", { kind: "custom", title: "Permissions" });
		fire("ui_prompt_end", { kind: "custom", title: "Permissions" });
	});
	assert.deepEqual(sent, []);
	// The next question, which the agent raises, reports again.
	fire("ui_prompt_start", { kind: "confirm", title: "Allow this call?" });
	assert.deepEqual(sent, [["herdr:blocked", { active: true, label: "Allow this call?" }]]);
});

test("a suppressed span never consumes the end of a reported one", async () => {
	const { pi, fire, sent } = harness();
	reportPrompts(pi);
	fire("ui_prompt_start", { kind: "custom", title: "Allow this call?" });
	await suppressPrompts(async () => {
		fire("ui_prompt_start", { kind: "custom", title: "Permissions" });
		fire("ui_prompt_end", { kind: "custom", title: "Permissions" });
	});
	fire("ui_prompt_end", { kind: "custom", title: "Allow this call?" });
	assert.deepEqual(sent, [
		["herdr:blocked", { active: true, label: "Allow this call?" }],
		["herdr:blocked", { active: false }],
	]);
});

test("an end without a start sends nothing", () => {
	const { pi, fire, sent } = harness();
	reportPrompts(pi);
	fire("ui_prompt_end", {});
	assert.deepEqual(sent, []);
});

test("a shutdown clears a block that is still open", () => {
	const { pi, fire, sent } = harness();
	reportPrompts(pi);
	fire("ui_prompt_start", { kind: "custom", title: "Allow this call?" });
	fire("session_shutdown", {});
	assert.deepEqual(sent.at(-1), ["herdr:blocked", { active: false }]);
	// A later shutdown has nothing to clear.
	fire("session_shutdown", {});
	assert.equal(sent.length, 2);
});

test("a prompt without a title names its kind", () => {
	for (const [kind, expected] of [
		["select", "Choose an answer"],
		["confirm", "Confirm an action"],
		["input", "Type an answer"],
		["editor", "Write an answer"],
		["custom", "Waiting for your answer"],
		[undefined, "Waiting for your answer"],
	] as const) {
		assert.equal(promptLabel({ kind }), expected);
	}
	assert.equal(promptLabel({ kind: "select", title: "  Allow?  " }), "Allow?");
	assert.equal(promptLabel({ kind: "select", title: "   " }), "Choose an answer");
});

test("a bus that throws does not break the dialog", () => {
	const handlers = new Map<string, Function>();
	reportPrompts({
		events: { emit() { throw new Error("closed"); } },
		on(name: string, handler: Function) {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
	});
	assert.doesNotThrow(() => handlers.get("ui_prompt_start")?.({ kind: "select" }, {}));
	assert.doesNotThrow(() => handlers.get("ui_prompt_end")?.({}, {}));
});

test("suppression is released when the screen fails", async () => {
	const { pi, fire, sent } = harness();
	reportPrompts(pi);
	await assert.rejects(suppressPrompts(async () => { throw new Error("closed"); }), /closed/);
	fire("ui_prompt_start", { kind: "confirm", title: "Allow this call?" });
	assert.deepEqual(sent, [["herdr:blocked", { active: true, label: "Allow this call?" }]]);
});

test("a second registration on the same API adds no handler", () => {
	const { pi } = harness();
	reportPrompts(pi);
	const handler = pi.on;
	let calls = 0;
	(pi as { on: typeof handler }).on = (name: string, fn: Function) => {
		calls += 1;
		return handler(name, fn);
	};
	reportPrompts(pi);
	assert.equal(calls, 0);
});

test("the reporter works with a host that has no event bus", () => {
	const handlers = new Map<string, Function>();
	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => void) {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
	};
	reportPrompts(pi);
	assert.doesNotThrow(() => handlers.get("ui_prompt_start")?.({ kind: "select" }, {}));
	assert.doesNotThrow(() => handlers.get("ui_prompt_end")?.({}, {}));
});
