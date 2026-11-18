import assert from "node:assert/strict";
import test from "node:test";
import { callReason } from "./reason.ts";

test("subagent fallback shows concrete action and assigned task", () => {
	const reason = callReason([
		{ type: "message", message: { role: "user", content: "Find the cause of the approval failure. Do not change files." } },
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "toolCall" }] } },
	], "read", { path: "src/approval.ts" });
	assert.match(reason, /Read src\/approval.ts/);
	assert.match(reason, /did not provide a specific reason/);
	assert.match(reason, /Current task: Find the cause/);
	assert.doesNotMatch(reason, /secret/);
});

test("current public explanation wins and old explanation does not leak", () => {
	const branch = [
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Old reason" }] } },
		{ type: "message", message: { role: "user", content: "New task" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Read the gate to locate its scope decision." }] } },
	];
	assert.equal(callReason(branch, "read", {}), "Read the gate to locate its scope decision.");
	branch.push({ type: "message", message: { role: "assistant", content: [] } });
	assert.doesNotMatch(callReason(branch, "read", {}), /Old reason|locate its scope/);
	assert.match(callReason(branch, "read", {}), /Current task: New task/);
});

test("missing session context yields an honest concrete fallback", () => {
	assert.match(callReason([], "bash", {}), /Run the shell command/);
	assert.match(callReason([], "edit", { path: "file.ts" }), /Edit file.ts/);
	assert.match(callReason([], "custom", {}), /Use the tool custom/);
});
