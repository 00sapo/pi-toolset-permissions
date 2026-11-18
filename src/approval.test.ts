import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Approvals } from "./approval.ts";
import { evaluateCall } from "./gate.ts";
import { StateStore } from "./state.ts";

function fixture(t: { after(fn: () => void): void }) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-approval-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const file = join(cwd, "permissions.json");
	const store = new StateStore(file);
	store.update((state) => ({
		...state,
		toolsets: state.toolsets.map((entry) => entry.name === "read" ? { ...entry, enabled: "ask" } : entry),
	}));
	return { cwd, file, store, approvals: new Approvals() };
}

function mockContext(cwd: string, answer: string | undefined = "Allow once", feedback?: string) {
	const selections: Array<{ title: string; choices: string[] }> = [];
	const inputs: Array<{ title: string; placeholder?: string }> = [];
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		ui: {
			async select(title: string, choices: string[]) {
				selections.push({ title, choices });
				return answer;
			},
			async input(title: string, placeholder?: string) {
				inputs.push({ title, placeholder });
				return feedback;
			},
		},
	};
	return { ctx, selections, inputs };
}

type CustomUI = NonNullable<Parameters<Approvals["request"]>[4]["ui"]["custom"]>;

function customContext(cwd: string, keys: string[], feedback?: string, rows?: number) {
	const fallback = mockContext(cwd, "Deny", feedback);
	const frames: string[][] = [];
	let renders = 0;
	let invalidated = false;
	let completions = 0;
	const custom = (async (factory: Parameters<CustomUI>[0]) => {
		let answer: unknown;
		const component = await factory(
			{ terminal: rows === undefined ? undefined : { rows }, requestRender() { renders++; } } as Parameters<typeof factory>[0],
			{ bold: (text: string) => `<bold>${text}</bold>`, fg: (_color: string, text: string) => text } as Parameters<typeof factory>[1],
			{ matches: (data: string, key: string) => data === key } as Parameters<typeof factory>[2],
			(value: unknown) => { answer = value; completions++; },
		);
		frames.push(component.render(80));
		component.invalidate();
		invalidated = true;
		for (const key of keys) {
			component.handleInput?.(key);
			frames.push(component.render(80));
		}
		return answer;
	}) as CustomUI;
	return {
		...fallback,
		ctx: { ...fallback.ctx, ui: { ...fallback.ctx.ui, custom } },
		frames,
		lifecycle: () => ({ renders, invalidated, completions }),
	};
}

	test("a non-terminal session uses the select dialog, not custom", async (t) => {
	const { cwd, store, approvals } = fixture(t);
	const { ctx, selections } = mockContext(cwd);
	// RPC mode defines custom() and returns undefined. A truthiness check would
	// read that as a denial and skip the dialog.
	let customCalls = 0;
	(ctx as { mode?: string }).mode = "rpc";
	Object.assign(ctx.ui, {
		custom: async () => {
			customCalls += 1;
			return undefined;
		},
	});
	assert.match(await approvals.request(store, "read", { path: "file.txt" }, reason, ctx), /Approved once/);
	assert.equal(customCalls, 0);
	assert.equal(selections.length, 1);
	assert.deepEqual(selections[0].choices, ["Allow once", "Deny", "Deny with explanation", "Allow and enable toolset read"]);
});

const reason = "Read the requested project file.";

test("allow once accepts reordered nested keys exactly once and keeps ask persisted", async (t) => {
	const { cwd, file, store, approvals } = fixture(t);
	const { ctx, selections, inputs } = mockContext(cwd);
	const input = { path: "file.txt", metadata: { offset: 1, labels: [{ a: 1, b: 2 }] } };
	assert.match(await approvals.request(store, "read", input, reason, ctx), /Approved once/);
	assert.equal(selections.length, 1);
	assert.match(selections[0].title, /Toolset:\nread \(ask\)/);
	assert.ok(selections[0].title.includes("Input:\n[...]"));
	assert.ok(!selections[0].title.includes("metadata"));
	assert.ok(selections[0].title.includes(reason));
	assert.deepEqual(selections[0].choices, ["Allow once", "Deny", "Deny with explanation", "Allow and enable toolset read"]);
	assert.equal(inputs.length, 0);
	const reordered = { metadata: { labels: [{ b: 2, a: 1 }], offset: 1 }, path: "file.txt" };
	assert.equal(approvals.consume("read", reordered), true);
	assert.equal(approvals.consume("read", input), false);
	assert.equal(new StateStore(file).get().toolsets.find((entry) => entry.name === "read")?.enabled, "ask");
});

test("changed arguments and a different tool cannot consume approval", async (t) => {
	const { cwd, store, approvals } = fixture(t);
	const { ctx } = mockContext(cwd);
	const input = { path: "file.txt", metadata: { offset: 1 }, lines: [1, 2] };
	await approvals.request(store, "read", input, reason, ctx);
	for (const changed of [
		{ ...input, path: "other.txt" },
		{ ...input, metadata: { offset: 2 } },
		{ ...input, lines: [2, 1] },
		{ ...input, extra: true },
	]) assert.equal(approvals.consume("read", changed), false);
	assert.equal(approvals.consume("write", input), false);
	assert.equal(approvals.consume("read", input), true);
	assert.equal(approvals.consume("read", input), false);
});

for (const answer of ["Deny", undefined]) {
	test(answer === undefined ? "cancellation grants no approval" : "denial grants no approval", async (t) => {
		const { cwd, store, approvals } = fixture(t);
		const { ctx, inputs } = mockContext(cwd, answer);
		// Passing undefined to the helper selects its default answer.
		if (answer === undefined) ctx.ui.select = async () => undefined;
		const result = await approvals.request(store, "read", { path: "file.txt" }, reason, ctx);
		assert.match(result, /Blocked: the user denied this call\./);
		assert.equal(approvals.consume("read", { path: "file.txt" }), false);
		assert.equal(inputs.length, 0);
	});
}

for (const feedback of ["Read README.md instead.", "   ", undefined]) {
	test(`denial feedback ${JSON.stringify(feedback)} grants no approval`, async (t) => {
		const { cwd, store, approvals } = fixture(t);
		const { ctx, inputs } = mockContext(cwd, "Deny with explanation", feedback);
		const result = await approvals.request(store, "read", { path: "file.txt" }, reason, ctx);
		assert.match(result, /Blocked: the user denied this call\./);
		if (feedback?.trim()) assert.ok(result.includes(`User explanation: ${feedback}`));
		else assert.doesNotMatch(result, /User explanation/);
		assert.equal(inputs.length, 1);
		assert.equal(approvals.consume("read", { path: "file.txt" }), false);
	});
}

test("allow and enable persists all matching ask toolsets but leaves unrelated modes unchanged", async (t) => {
	const { cwd, file, store, approvals } = fixture(t);
	store.update((state) => ({ ...state, toolsets: [
		...state.toolsets,
		{ name: "overlap", patterns: ["^read$"], enabled: "ask", builtin: false },
		{ name: "unrelated", patterns: ["^other$"], enabled: "ask", builtin: false },
	] }));
	const before = store.get();
	const { ctx, selections } = mockContext(cwd, "Allow and enable toolsets read, overlap");
	const result = await approvals.request(store, "read", { path: "file.txt" }, reason, ctx);
	assert.match(result, /Approved/);
	assert.ok(selections[0].title.includes("read"));
	assert.ok(selections[0].title.includes("overlap"));
	assert.equal(selections[0].choices[3], "Allow and enable toolsets read, overlap");
	const persisted = new StateStore(file).get();
	for (const entry of persisted.toolsets) {
		if (["read", "overlap"].includes(entry.name)) assert.equal(entry.enabled, true);
		else assert.deepEqual(entry, before.toolsets.find((old) => old.name === entry.name));
	}
	assert.deepEqual(evaluateCall(persisted, "read", { path: "file.txt" }, cwd), { block: false });
	assert.equal(approvals.consume("read", { path: "file.txt" }), false);
});

test("headless requests are denied without a dialog", async (t) => {
	const { cwd, store, approvals } = fixture(t);
	const { ctx, selections } = mockContext(cwd);
	ctx.hasUI = false;
	assert.match(await approvals.request(store, "read", {}, reason, ctx), /Blocked:.*interactive/);
	assert.equal(selections.length, 0);
	assert.equal(approvals.consume("read", {}), false);
});

test("off and outside-scope targets cannot be approved or enabled", async (t) => {
	const { cwd, file, store, approvals } = fixture(t);
	const { ctx, selections } = mockContext(cwd, "Allow and enable toolset read");
	for (const [tool, input] of [
		["write", { path: "file.txt" }],
		["read", { path: join(cwd, "..", "outside.txt") }],
	] as const) {
		assert.match(await approvals.request(store, tool, input, reason, ctx), /^Blocked:/);
		assert.equal(approvals.consume(tool, input), false);
	}
	assert.equal(selections.length, 0);
	const persisted = new StateStore(file).get();
	assert.equal(persisted.toolsets.find((entry) => entry.name === "write")?.enabled, false);
	assert.equal(persisted.toolsets.find((entry) => entry.name === "read")?.enabled, "ask");
});

test("approval requests cannot request themselves", async (t) => {
	const { cwd, store, approvals } = fixture(t);
	const { ctx, selections } = mockContext(cwd);
	const input = { action: "request_tool", tool: "read", input: {}, reason };
	assert.match(await approvals.request(store, "permissions", input, reason, ctx), /Blocked:.*cannot request themselves/);
	assert.equal(selections.length, 0);
	assert.equal(approvals.consume("permissions", input), false);
});

for (const emptyReason of ["", " \n\t "]) {
	test(`a reason is required for ${JSON.stringify(emptyReason)}`, async (t) => {
		const { cwd, store, approvals } = fixture(t);
		const { ctx, selections } = mockContext(cwd);
		assert.match(await approvals.request(store, "read", {}, emptyReason, ctx), /Blocked: provide a reason/);
		assert.equal(selections.length, 0);
		assert.equal(approvals.consume("read", {}), false);
	});
}

test("already enabled targets need no approval", async (t) => {
	const { cwd, store, approvals } = fixture(t);
	const { ctx, selections } = mockContext(cwd);
	assert.match(await approvals.request(store, "bash", { command: "pwd" }, reason, ctx), /does not need approval/);
	assert.equal(selections.length, 0);
	assert.equal(approvals.consume("bash", { command: "pwd" }), false);
});

test("clear revokes pending approvals", async (t) => {
	const { cwd, store, approvals } = fixture(t);
	const { ctx } = mockContext(cwd);
	await approvals.request(store, "read", {}, reason, ctx);
	approvals.clear();
	assert.equal(approvals.consume("read", {}), false);
});

for (const answer of ["Allow once", "Allow and enable toolset read"]) {
	test(`${answer} refuses a target switched off while the dialog is open`, async (t) => {
		const { cwd, file, store, approvals } = fixture(t);
		const { ctx } = mockContext(cwd);
		ctx.ui.select = async () => {
			new StateStore(file).update((state) => ({ ...state, toolsets: state.toolsets.map((entry) =>
				entry.name === "read" ? { ...entry, enabled: false } : entry) }));
			return answer;
		};
		assert.match(await approvals.request(store, "read", {}, reason, ctx), /^Blocked:/);
		assert.equal(approvals.consume("read", {}), false);
		assert.equal(new StateStore(file).get().toolsets.find((entry) => entry.name === "read")?.enabled, false);
	});
}

for (const keys of [
	["l"],
	["tui.select.confirm"],
	["j", "k", "tui.select.confirm"],
	["tui.select.down", "tui.select.up", "tui.select.confirm"],
	["ignored", "tui.select.confirm"],
]) {
	test(`custom UI allows once through ${keys.join(", ")}`, async (t) => {
		const { cwd, store, approvals } = fixture(t);
		const { ctx, selections, frames, lifecycle } = customContext(cwd, keys);
		assert.match(await approvals.request(store, "read", { path: "file.txt" }, reason, ctx), /Approved once/);
		assert.equal(approvals.consume("read", { path: "file.txt" }), true);
		assert.equal(selections.length, 0);
		assert.ok(frames[0].includes("> Allow once"));
		assert.ok(frames[0].includes("<bold>Toolset:</bold>"));
		assert.deepEqual(lifecycle(), { renders: keys.length - 1, invalidated: true, completions: 1 });
	});
}

for (const keys of [["k"], ["tui.select.up"], ["j", "j", "j"]]) {
	test(`custom UI enables the named toolset through ${keys.join(", ")}`, async (t) => {
		const { cwd, file, store, approvals } = fixture(t);
		const { ctx, frames, lifecycle } = customContext(cwd, [...keys, "tui.select.confirm"]);
		assert.match(await approvals.request(store, "read", {}, reason, ctx), /Approved/);
		assert.ok(frames.at(-1)?.includes("> Allow and enable toolset read"));
		assert.equal(new StateStore(file).get().toolsets.find((entry) => entry.name === "read")?.enabled, true);
		assert.equal(approvals.consume("read", {}), false);
		assert.equal(lifecycle().completions, 1);
	});
}

for (const keys of [["h"], ["tui.select.cancel"], ["j", "tui.select.confirm"], ["j", "j", "tui.select.confirm"]]) {
	test(`custom UI denies through ${keys.join(", ")}`, async (t) => {
		const { cwd, store, approvals } = fixture(t);
		const { ctx, inputs, selections, lifecycle } = customContext(cwd, keys, "Use README.md instead.");
		const result = await approvals.request(store, "read", {}, reason, ctx);
		assert.match(result, /Blocked: the user denied this call\./);
		assert.equal(inputs.length, keys.length === 3 ? 1 : 0);
		if (keys.length === 3) assert.match(result, /User explanation: Use README.md instead\./);
		assert.equal(approvals.consume("read", {}), false);
		assert.equal(selections.length, 0);
		assert.equal(lifecycle().completions, 1);
	});
}

for (const back of ["h", "\x1b"]) {
	test(`Inspect returns through ${JSON.stringify(back)} before allowing once`, async (t) => {
		const { cwd, store, approvals } = fixture(t);
		const input = { path: "file.txt", metadata: Array.from({ length: 60 }, (_, i) => `row-${i}`) };
		const keys = ["k", "l", "l", "\r", "j", "k", "\x1b[B", "\x1b[A", "\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[5~", back, "j", "l"];
		const { ctx, frames, lifecycle } = customContext(cwd, keys);
		assert.equal(await approvals.request(store, "read", input, reason, ctx), "Approved once.");
		assert.ok(frames[0].includes("  Inspect"));
		assert.ok(frames[2].some((line) => line.includes("metadata")));
		assert.deepEqual(frames[2], frames[3]);
		assert.deepEqual(frames[3], frames[4]);
		for (const frame of frames.slice(2, 14)) assert.ok(frame.length <= 24);
		assert.ok(frames.some((frame) => frame.some((line) => line.includes("row-59"))));
		assert.equal(lifecycle().completions, 1);
		assert.equal(approvals.consume("read", input), true);
		assert.equal(approvals.consume("read", input), false);
	});
}

test("Inspect obeys terminal rows and back alone never approves", async (t) => {
	const { cwd, store, approvals } = fixture(t);
	const input = { path: "file.txt", extra: "x".repeat(2000) };
	const { ctx, frames, lifecycle } = customContext(cwd, ["k", "l", "\x1b[6~", "h", "h"], undefined, 9);
	assert.match(await approvals.request(store, "read", input, reason, ctx), /Blocked:/);
	assert.ok(frames[2].length <= 9);
	assert.ok(frames[3].length <= 9);
	assert.equal(lifecycle().completions, 1);
	assert.equal(approvals.consume("read", input), false);
});
