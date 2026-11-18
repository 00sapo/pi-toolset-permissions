import assert from "node:assert/strict";
import test from "node:test";
import {
	askParent,
	childLink,
	claimSession,
	dropChild,
	dropForwarder,
	environmentParent,
	releaseSession,
	setChild,
	setForwarder,
	setChild as setChildLink,
} from "./sessions.ts";

test("a session accepts one owner and refuses a second", () => {
	const first = {};
	const second = {};
	assert.equal(claimSession("session-a", first), true);
	assert.equal(claimSession("session-a", first), true);
	assert.equal(claimSession("session-a", second), false);
	releaseSession("session-a", first);
	assert.equal(claimSession("session-a", second), true);
	releaseSession("session-a", second);
});

test("releasing with the wrong token leaves the claim", () => {
	const owner = {};
	assert.equal(claimSession("session-b", owner), true);
	releaseSession("session-b", {});
	assert.equal(claimSession("session-b", {}), false);
	releaseSession("session-b", owner);
	assert.equal(claimSession("session-b", {}), true);
	releaseSession("session-b", {});
});

test("a child ask reaches the parent dialog and returns its answer", async () => {
	const seen: unknown[] = [];
	setChild("child-1", { parentSessionId: "parent-1" });
	assert.deepEqual(childLink("child-1"), { parentSessionId: "parent-1" });
	setForwarder("parent-1", async (ask) => {
		seen.push(ask);
		return { choice: "Allow once" };
	});
	const outcome = await askParent({
		sessionId: "child-1",
		tool: "write",
		input: { path: "/tmp/x" },
		reason: "Leave a note.",
		names: ["write"],
	});
	assert.equal(outcome.kind, "reply");
	if (outcome.kind === "reply") assert.deepEqual(outcome.reply, { choice: "Allow once" });
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0], {
		sessionId: "child-1",
		tool: "write",
		input: { path: "/tmp/x" },
		reason: "Leave a note.",
		names: ["write"],
	});
	dropChild("child-1");
	dropForwarder("parent-1");
	assert.equal(childLink("child-1"), undefined);
});

test("a denial explanation comes back to the child", async () => {
	setChild("child-2", { parentSessionId: "parent-2" });
	setForwarder("parent-2", async () => ({ choice: "Deny with explanation", explanation: "Use the project files." }));
	const outcome = await askParent({ sessionId: "child-2", tool: "read", input: {}, reason: "Read it.", names: ["read"] });
	assert.equal(outcome.kind, "reply");
	if (outcome.kind === "reply") {
		assert.equal(outcome.reply.choice, "Deny with explanation");
		assert.equal(outcome.reply.explanation, "Use the project files.");
	}
	dropChild("child-2");
	dropForwarder("parent-2");
});

test("a child without a parent fails closed with a reason", async () => {
	const previous = process.env.PI_SUBAGENT_PARENT_SESSION;
	delete process.env.PI_SUBAGENT_PARENT_SESSION;
	try {
		const outcome = await askParent({ sessionId: "orphan", tool: "write", input: {}, reason: "Write.", names: ["write"] });
		assert.equal(outcome.kind, "unavailable");
		if (outcome.kind === "unavailable") assert.match(outcome.reason, /^Blocked: .*no parent interface/);
	} finally {
		if (previous !== undefined) process.env.PI_SUBAGENT_PARENT_SESSION = previous;
	}
});

test("a parent that registered no forwarder fails closed", async () => {
	setChild("child-3", { parentSessionId: "parent-3" });
	try {
		const outcome = await askParent({ sessionId: "child-3", tool: "write", input: {}, reason: "Write.", names: ["write"] });
		assert.equal(outcome.kind, "unavailable");
		if (outcome.kind === "unavailable") assert.match(outcome.reason, /not answering approval requests/);
	} finally {
		dropChild("child-3");
	}
});

test("a parent that closes the request fails closed", async () => {
	setChild("child-4", { parentSessionId: "parent-4" });
	setForwarder("parent-4", async () => undefined);
	try {
		const outcome = await askParent({ sessionId: "child-4", tool: "write", input: {}, reason: "Write.", names: ["write"] });
		assert.equal(outcome.kind, "unavailable");
		if (outcome.kind === "unavailable") assert.match(outcome.reason, /closed the approval request/);
	} finally {
		dropChild("child-4");
		dropForwarder("parent-4");
	}
});

test("an unanswered request times out instead of waiting forever", async () => {
	const previous = process.env.PI_PERMISSIONS_ASK_TIMEOUT_MS;
	process.env.PI_PERMISSIONS_ASK_TIMEOUT_MS = "40";
	setChild("child-5", { parentSessionId: "parent-5" });
	setForwarder("parent-5", () => new Promise(() => {}));
	try {
		const outcome = await askParent({ sessionId: "child-5", tool: "write", input: {}, reason: "Write.", names: ["write"] });
		assert.equal(outcome.kind, "unavailable");
		if (outcome.kind === "unavailable") assert.match(outcome.reason, /did not answer/);
	} finally {
		dropChild("child-5");
		dropForwarder("parent-5");
		if (previous === undefined) delete process.env.PI_PERMISSIONS_ASK_TIMEOUT_MS;
		else process.env.PI_PERMISSIONS_ASK_TIMEOUT_MS = previous;
	}
});

test("a child started as its own process reads its parent from the environment", async () => {
	const previous = process.env.PI_SUBAGENT_PARENT_SESSION;
	process.env.PI_SUBAGENT_PARENT_SESSION = "parent-env";
	setForwarder("parent-env", async () => ({ choice: "Deny" }));
	try {
		assert.equal(environmentParent(), "parent-env");
		const outcome = await askParent({ sessionId: "elsewhere", tool: "read", input: {}, reason: "Read.", names: ["read"] });
		assert.equal(outcome.kind, "reply");
		if (outcome.kind === "reply") assert.equal(outcome.reply.choice, "Deny");
	} finally {
		dropForwarder("parent-env");
		if (previous === undefined) delete process.env.PI_SUBAGENT_PARENT_SESSION;
		else process.env.PI_SUBAGENT_PARENT_SESSION = previous;
	}
});

test("the registry is shared through globalThis across module copies", () => {
	setChildLink("child-shared", { parentSessionId: "parent-shared" });
	const key = Symbol.for("pi-toolset-permissions.registry");
	const shared = (globalThis as unknown as Record<symbol, { children: Map<string, unknown> }>)[key];
	assert.ok(shared);
	assert.deepEqual(shared.children.get("child-shared"), { parentSessionId: "parent-shared" });
	dropChild("child-shared");
});
