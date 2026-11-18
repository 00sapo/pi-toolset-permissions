/** Pure helpers for the pattern editor. The screen keeps the dialogs and the state. */

import { MAX_TOOLSET_PATTERNS, checkPatterns } from "./state.ts";

export type PatternResult = { patterns: string[] } | { error: string };

/** A single pattern, checked the same way as a whole list. */
function checkOne(source: string): PatternResult {
	const checked = checkPatterns([source]);
	if ("error" in checked) return checked;
	return { patterns: checked.patterns };
}

/** Appends one pattern to a list. `allowEmpty` keeps an empty list valid for the exceptions. */
export function appendPattern(patterns: string[], source: string, allowEmpty = false): PatternResult {
	if (patterns.length >= MAX_TOOLSET_PATTERNS) {
		return { error: `A list holds ${MAX_TOOLSET_PATTERNS} patterns at most.` };
	}
	const checked = checkOne(source);
	if ("error" in checked) return checked;
	const value = checked.patterns[0] ?? "";
	if (patterns.includes(value)) return { error: `The pattern ${value} is already in the list.` };
	return checkPatterns([...patterns, value], allowEmpty);
}

/** Replaces the pattern at one position. */
export function replacePattern(patterns: string[], position: number, source: string): PatternResult {
	if (position < 0 || position >= patterns.length) return { error: "That pattern is no longer in the list." };
	const checked = checkOne(source);
	if ("error" in checked) return checked;
	const value = checked.patterns[0] ?? "";
	if (patterns.some((entry, index) => index !== position && entry === value)) {
		return { error: `The pattern ${value} is already in the list.` };
	}
	return checkPatterns(patterns.map((entry, index) => (index === position ? value : entry)));
}

/** Removes the pattern at one position. A list keeps at least one pattern. */
export function removePattern(patterns: string[], position: number): PatternResult {
	if (position < 0 || position >= patterns.length) return { error: "That pattern is no longer in the list." };
	if (patterns.length <= 1) return { error: "A toolset needs at least one pattern." };
	return checkPatterns(patterns.filter((_entry, index) => index !== position));
}

/** The tool names that match one pattern, in the order of the list. */
export function matchingNames(pattern: string, toolNames: string[]): string[] {
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, "i");
	} catch {
		return [];
	}
	return toolNames.filter((name) => regex.test(name));
}
