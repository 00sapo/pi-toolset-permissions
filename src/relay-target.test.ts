import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelRef, resolveRelayTarget } from "./relay-target.ts";

const models: Record<string, { provider: string; id: string }> = {
	"alias/low": { provider: "alias", id: "low" },
	"openai-codex/gpt-6.2-sol": { provider: "openai-codex", id: "gpt-6.2-sol" },
};

const registry = {
	find(provider: string, id: string) {
		return models[`${provider}/${id}`];
	},
};

test("a provider-qualified reference keeps its parts", () => {
	assert.deepEqual(parseModelRef("alias/low"), { provider: "alias", id: "low" });
	assert.deepEqual(parseModelRef("openai-codex/gpt-6.2-sol:high"), { provider: "openai-codex", id: "gpt-6.2-sol" });
	assert.deepEqual(parseModelRef("  alias/low  "), { provider: "alias", id: "low" });
});

test("a bare reference has no provider, and an empty one is absent", () => {
	assert.deepEqual(parseModelRef("low"), { id: "low" });
	assert.deepEqual(parseModelRef("gpt-6.2-sol:xhigh"), { id: "gpt-6.2-sol" });
	assert.equal(parseModelRef(undefined), undefined);
	assert.equal(parseModelRef("   "), undefined);
});

test("the host resolves the requested model without any catalogue in the sandbox", () => {
	const fallback = { provider: "alias", id: "parent-fallback" };
	assert.deepEqual(resolveRelayTarget(registry, "alias/low", fallback), models["alias/low"]);
	assert.deepEqual(resolveRelayTarget(registry, "openai-codex/gpt-6.2-sol:max", fallback), models["openai-codex/gpt-6.2-sol"]);
});

test("an absent reference inherits the session model", () => {
	const fallback = { provider: "alias", id: "parent-fallback" };
	assert.equal(resolveRelayTarget(registry, undefined, fallback), fallback);
	assert.equal(resolveRelayTarget(registry, "   ", fallback), fallback);
});

test("a named reference that cannot be resolved is not replaced by another model", () => {
	const fallback = { provider: "alias", id: "parent-fallback" };
	assert.equal(resolveRelayTarget(registry, "low", fallback), undefined);
	assert.equal(resolveRelayTarget(registry, "alias/missing", fallback), undefined);
	assert.equal(resolveRelayTarget(registry, "alias/low", undefined), models["alias/low"]);
});
