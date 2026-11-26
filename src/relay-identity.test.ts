import assert from "node:assert/strict";
import { test } from "node:test";
import { RELAY_MODEL, RELAY_PROVIDER, relayEvent } from "./relay-identity.ts";

function outerMessage(): Record<string, unknown> {
	return {
		role: "assistant", api: "openai-completions", provider: "opencode-go",
		model: "deepseek-v4.1-flash", content: [{ type: "text", text: "hello" }],
		stopReason: "stop", timestamp: 1,
	};
}

test("every assistant message that the relay forwards names the relay model", () => {
	const outer = outerMessage();
	const events: Array<Record<string, unknown>> = [
		{ type: "start", partial: outer },
		{ type: "done", reason: "stop", message: outer },
		{ type: "error", reason: "error", error: outer },
	];
	for (const event of events) {
		const relayed = relayEvent(event) as Record<string, any>;
		const carried = [relayed.partial, relayed.message, relayed.error].filter(Boolean);
		assert.equal(carried.length, 1);
		assert.equal(carried[0].provider, RELAY_PROVIDER);
		assert.equal(carried[0].model, RELAY_MODEL);
		assert.equal(carried[0].api, RELAY_PROVIDER);
		assert.equal(relayed.type, event.type);
	}
});

test("the relay keeps the content and the other fields of a message", () => {
	const relayed = relayEvent({ type: "done", reason: "stop", message: outerMessage() }) as Record<string, any>;
	assert.deepEqual(relayed.message.content, [{ type: "text", text: "hello" }]);
	assert.equal(relayed.reason, "stop");
	assert.equal(relayed.message.role, "assistant");
	assert.equal(relayed.message.stopReason, "stop");
	assert.equal(relayed.message.timestamp, 1);
});

test("the relay leaves a partial event and a non-assistant value alone", () => {
	const delta = { type: "text_delta", contentIndex: 0, delta: "hi" };
	assert.deepEqual(relayEvent(delta), delta);
	const result = { role: "toolResult", toolName: "read", content: [] };
	assert.deepEqual(relayEvent({ type: "tool_result", message: result }), { type: "tool_result", message: result });
	assert.equal(relayEvent(null), null);
});

test("the relay never changes the outer message that it received", () => {
	const outer = outerMessage();
	relayEvent({ type: "done", reason: "stop", message: outer });
	assert.equal(outer.model, "deepseek-v4.1-flash");
	assert.equal(outer.provider, "opencode-go");
});
