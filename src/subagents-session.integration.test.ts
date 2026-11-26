import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { linkSandboxSession, sandboxSessionId, unlinkSandboxSessions } from "./subagents-session.ts";

// Optional integration against the installed owner. Never modify its package or real runs.
const root = process.env.PI_SUBAGENTS_TEST_ROOT ?? join(homedir(), ".pi/agent/npm/node_modules/pi-subagents");
const scanner = join(root, "src/runs/background/async-status.js");
const skip = existsSync(scanner) ? false : "Set PI_SUBAGENTS_TEST_ROOT to an installed pi-subagents package.";

test("installed Fleet disk scanner discovers single and workflow runs only for their host", { skip }, async () => {
	const { listAsyncRuns } = await import(pathToFileURL(scanner).href);
	const { updateTerminalRunIndex } = await import(pathToFileURL(join(root, "src/runs/background/terminal-run-index.js")).href);
	const { updateActiveRunIndex } = await import(pathToFileURL(join(root, "src/runs/background/active-run-index.js")).href);
	const { recordSessionReplacement, keepSessionWork, recordSessionStart } = await import(pathToFileURL(join(root, "src/shared/session-succession.js")).href);
	const directory = await mkdtemp(join(tmpdir(), "pi-fleet-ownership-"));
	const owner = join(directory, "host.jsonl");
	const manager = { getSessionId: () => "host-runtime", getSessionFile: () => owner };
	const alias = sandboxSessionId(manager);
	const other = { getSessionId: () => "other-runtime", getSessionFile: () => join(directory, "other.jsonl") };
	const snapshot = (id: string) => listAsyncRuns(directory, { sessionId: id, resultsDir: join(directory, "results"), reconcile: false, includeNested: false });
	const key = Symbol.for("pi-subagents.session-succession");
	const runtime = globalThis as any;
	const previous = runtime[key];
	try {
		for (const [runId, mode, sessionId, state] of [
			["single-probe", "single", alias, "complete"],
			["workflow-probe", "workflow", alias, "complete"],
			["running-probe", "single", alias, "running"],
			["other-probe", "single", sandboxSessionId(other), "complete"],
		]) {
			const dir = join(directory, runId);
			await mkdir(dir);
			const status = { runId, mode, state, sessionId, startedAt: Date.now(), lastUpdate: Date.now(), ...(state === "complete" ? { endedAt: Date.now() } : {}), steps: [{ agent: "delegate", status: state === "complete" ? "complete" : "running" }] };
			await writeFile(join(dir, "status.json"), JSON.stringify(status));
			if (state === "complete") updateTerminalRunIndex(dir, status);
			else updateActiveRunIndex(dir, state);
		}
		assert.equal(snapshot(owner).length, 0, "unlinked inner runs reproduce the failure");
		linkSandboxSession(manager);
		const linked = snapshot(owner);
		assert.deepEqual(linked.map((item: any) => item.id).sort(), ["running-probe", "single-probe", "workflow-probe"]);
		assert.equal(snapshot(other.getSessionFile()).length, 0);
		linkSandboxSession(other);
		assert.deepEqual(snapshot(other.getSessionFile()).map((item: any) => item.id), ["other-probe"]);
		// A fresh host runtime clears succession history. Re-linking the same owner
		// must rediscover terminal runs written by the previous executor.
		recordSessionStart(owner, true);
		assert.equal(snapshot(owner).length, 0);
		linkSandboxSession(manager);
		assert.equal(snapshot(owner).length, 3);
		// A successor legitimately inherits the owner's sandbox work. Reopening the
		// owner must revoke both its real identity and our synthetic alias there.
		const successorKey = join(directory, "successor.jsonl");
		const successor = { getSessionId: () => "successor", getSessionFile: () => successorKey };
		recordSessionReplacement(successorKey, owner);
		linkSandboxSession(successor);
		assert.equal(snapshot(successorKey).length, 3);
		recordSessionStart(owner, false);
		linkSandboxSession(manager);
		assert.equal(snapshot(successorKey).length, 0);
		assert.equal(snapshot(owner).length, 3);
		// Synthetic identities must not consume pi-subagents' eight real predecessor
		// slots. Simulate shutdown -> replacement -> discovery in either load order.
		let current = owner;
		for (let index = 0; index < 8; index++) {
			unlinkSandboxSessions();
			const next = join(directory, `successor-${index}.jsonl`);
			recordSessionReplacement(next, current);
			linkSandboxSession({ getSessionId: () => `runtime-${index}`, getSessionFile: () => next });
			assert.equal(snapshot(next).length, 3, `lost original runs at replacement ${index + 1}`);
			current = next;
		}
		recordSessionStart(owner, false);
		linkSandboxSession(manager);
		assert.equal(snapshot(current).length, 0, "reopening owner revokes its inherited alias");
		// Choosing to keep work in A must not make it belong to a later session.
		keepSessionWork(owner);
		recordSessionReplacement(successorKey, owner);
		linkSandboxSession(successor);
		assert.equal(snapshot(successorKey).length, 0);
	} finally {
		if (previous === undefined) delete runtime[key]; else runtime[key] = previous;
		await rm(directory, { recursive: true, force: true });
	}
});
