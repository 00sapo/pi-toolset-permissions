import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxSessionId, linkSandboxSession, unlinkSandboxSessions } from "./subagents-session.ts";

const KEY = Symbol.for("pi-subagents.session-succession");
const manager = (id: string, file?: string) => ({ getSessionId: () => id, getSessionFile: () => file });

test("sandbox identity is stable across restarts and uses the full host ownership key", () => {
	const first = manager("runtime-a", "/private/sessions/host.jsonl");
	const second = manager("runtime-b", "/private/sessions/host.jsonl");
	const id = sandboxSessionId(first);
	assert.equal(id, sandboxSessionId(second));
	assert.match(id, /^pi-sandbox-[a-f0-9]{64}$/);
	assert.doesNotMatch(id, /private|host\.jsonl/);
	assert.notEqual(id, sandboxSessionId(manager("runtime-a", "/different/host.jsonl")));
	assert.notEqual(sandboxSessionId(manager("one")), sandboxSessionId(manager("two")));
	assert.throws(() => sandboxSessionId(manager("")), /session identity/i);
});

test("linking registers only the owner's sandbox alias and preserves existing history", () => {
	const a = manager("a", "/sessions/a.jsonl"), b = manager("b", "/sessions/b.jsonl");
	const registry = new Map([["/sessions/a.jsonl", ["older-a"]], ["unrelated", ["older-unrelated"]]]);
	const runtime = { [KEY]: registry };
	assert.equal(linkSandboxSession(a, runtime), sandboxSessionId(a));
	linkSandboxSession(a, runtime);
	assert.ok(registry.get("/sessions/a.jsonl")!.includes(sandboxSessionId(a)));
	assert.ok(registry.get("/sessions/a.jsonl")!.includes("older-a"));
	assert.deepEqual(registry.get("unrelated"), ["older-unrelated"]);
	assert.equal(registry.has("/sessions/b.jsonl"), false);
	linkSandboxSession(b, runtime);
	assert.deepEqual(registry.get("/sessions/b.jsonl"), [sandboxSessionId(b)]);
	assert.ok(!registry.get("/sessions/b.jsonl")!.includes(sandboxSessionId(a)));
});

test("linking can restore the alias after pi-subagents startup resets it", () => {
	const owner = manager("host");
	const runtime: any = {};
	const alias = linkSandboxSession(owner, runtime);
	runtime[KEY].delete("host");
	assert.equal(linkSandboxSession(owner, runtime), alias);
	assert.deepEqual(runtime[KEY].get("host"), [alias]);
});

test("an incompatible private ownership registry fails rather than being replaced", () => {
	for (const value of [{}, new Map([["host", "wrong"]]), new Map([["host", [42]]])]) {
		const runtime = { [KEY]: value };
		assert.throws(() => linkSandboxSession(manager("host"), runtime), /ownership registry/i);
		assert.equal(runtime[KEY], value);
	}
});

test("reopening a predecessor revokes its inherited alias without changing real lineage", () => {
	const a = manager("a"), b = manager("b");
	const registry = new Map<string, string[]>();
	const runtime = { [KEY]: registry };
	const aliasA = linkSandboxSession(a, runtime);
	// pi-subagents records replacement B <- A, including A's predecessor chain.
	registry.set("b", ["a", aliasA, "older"]);
	const aliasB = linkSandboxSession(b, runtime);
	assert.ok(registry.get("b")!.includes(aliasB));
	assert.ok(registry.get("b")!.includes(aliasA));
	// Its recordSessionStart(A) revokes the real A predecessor from B.
	registry.set("b", registry.get("b")!.filter(id => id !== "a"));
	linkSandboxSession(a, runtime);
	assert.ok(!registry.get("b")!.includes(aliasA));
	assert.ok(registry.get("b")!.includes("older"));
	assert.deepEqual(registry.get("a"), [aliasA]);
});

test("linking never drops a full predecessor chain or claims unregistered lookalike IDs", () => {
	const previous = Array.from({length:8}, (_,i)=>`older-${i}`);
	const lookalike = `pi-sandbox-${"a".repeat(64)}`;
	const registry = new Map([["host", [...previous]], ["other", [lookalike]]]);
	const runtime = { [KEY]: registry };
	linkSandboxSession(manager("host"), runtime);
	unlinkSandboxSessions(runtime);
	assert.deepEqual(registry.get("host"), previous);
	assert.deepEqual(registry.get("other"), [lookalike]);
});
