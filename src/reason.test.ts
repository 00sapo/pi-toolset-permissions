import assert from "node:assert/strict";
import test from "node:test";
import { callReason, permissionReason, relayedReason } from "./reason.ts";

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
	assert.equal(callReason(branch, "read", {}), "Read the gate to locate its scope decision.");
	branch.push({ type: "message", message: { role: "toolResult", content: [] } });
	branch.push({ type: "message", message: { role: "assistant", content: [] } });
	assert.doesNotMatch(callReason(branch, "read", {}), /Old reason|locate its scope/);
	assert.match(callReason(branch, "read", {}), /Current task: New task/);
});

test("missing session context yields an honest concrete fallback", () => {
	assert.match(callReason([], "bash", {}), /Run the shell command/);
	assert.match(callReason([], "edit", { path: "file.ts" }), /Edit file.ts/);
	assert.match(callReason([], "custom", {}), /Use the tool custom/);
});

 test("sandbox reason survives serialization without private thinking or host context", () => {
 const ctx = { sessionManager: { getBranch: () => [
 {type:"message",message:{role:"user",content:"Sandbox task"}},
 {type:"message",message:{role:"assistant",content:[{type:"text",text:"Inspect the sandbox config to locate the failure."}]}},
 {type:"message",message:{role:"assistant",content:[{type:"thinking",thinking:"private secret"},{type:"toolCall",name:"read"}]}},
 ] } };
 const event = JSON.parse(JSON.stringify({toolName:"read",input:{path:"config.ts"},approvalReason:permissionReason(ctx,"read",{path:"config.ts"})}));
 assert.equal(relayedReason(event),"Inspect the sandbox config to locate the failure.");
 assert.doesNotMatch(JSON.stringify(event),/private secret|Sandbox task/);
 for (const approvalReason of [undefined, null, {}, " "]) {
 assert.match(relayedReason({...event,approvalReason}),/did not provide a specific reason/);
 }
 });
 test("unavailable sandbox history yields an honest fallback", () => {
 assert.match(permissionReason({sessionManager:{getBranch(){throw new Error("unavailable")}}},"read",{path:"config.ts"}),/Read config.ts/);
 });
