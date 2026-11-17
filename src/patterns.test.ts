import assert from "node:assert/strict";
import test from "node:test";
import { appendPattern, matchingNames, removePattern, replacePattern } from "./patterns.ts";
import { MAX_TOOLSET_PATTERNS } from "./state.ts";

const BASE = ["^read$", "^ls$"];

test("appendPattern trims the new pattern and keeps the order", () => {
	const result = appendPattern(BASE, "  ^cat_  ");
	assert.ok("patterns" in result);
	assert.deepEqual(result.patterns, ["^read$", "^ls$", "^cat_"]);
});

test("appendPattern refuses a duplicate", () => {
	const result = appendPattern(BASE, "^ls$");
	assert.ok("error" in result);
	assert.match(result.error, /already in the list/);
});

test("appendPattern refuses an empty or broken pattern", () => {
	for (const source of ["", "   ", "[", "x".repeat(501)]) {
		const result = appendPattern(BASE, source);
		assert.ok("error" in result, `expected an error for ${JSON.stringify(source)}`);
	}
});

test("appendPattern caps the list", () => {
	const full = Array.from({ length: MAX_TOOLSET_PATTERNS }, (_, position) => `^tool${position}$`);
	const result = appendPattern(full, "^one-more$");
	assert.ok("error" in result);
	assert.match(result.error, /at most/);
	assert.deepEqual(full.length, MAX_TOOLSET_PATTERNS);
});

test("replacePattern changes one entry only", () => {
	const result = replacePattern(BASE, 1, "^list$");
	assert.ok("patterns" in result);
	assert.deepEqual(result.patterns, ["^read$", "^list$"]);
});

test("replacePattern keeps a pattern that is equal to the old one", () => {
	const result = replacePattern(BASE, 0, "^read$");
	assert.ok("patterns" in result);
	assert.deepEqual(result.patterns, BASE);
});

test("replacePattern refuses a duplicate of another entry", () => {
	const result = replacePattern(BASE, 1, "^read$");
	assert.ok("error" in result);
	assert.match(result.error, /already in the list/);
});

test("replacePattern refuses a position that is out of range", () => {
	for (const position of [-1, 2]) {
		const result = replacePattern(BASE, position, "^new$");
		assert.ok("error" in result);
	}
});

test("removePattern removes one entry", () => {
	const result = removePattern(BASE, 0);
	assert.ok("patterns" in result);
	assert.deepEqual(result.patterns, ["^ls$"]);
});

test("removePattern refuses the last pattern", () => {
	const result = removePattern(["^read$"], 0);
	assert.ok("error" in result);
	assert.match(result.error, /at least one pattern/);
});

test("matchingNames ignores case and skips a broken pattern", () => {
	const tools = ["read", "Read_File", "ls", "bash"];
	assert.deepEqual(matchingNames("^read", tools), ["read", "Read_File"]);
	assert.deepEqual(matchingNames("^re", tools), ["read", "Read_File"]);
	assert.deepEqual(matchingNames("[", tools), []);
});
