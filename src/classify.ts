import type { Classification, Risk, Toolset } from "./types.ts";

const SEVERITY: Record<Risk, number> = { read: 0, write: 1, execute: 2 };

const cache = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
	const cached = cache.get(pattern);
	if (cached !== undefined) return cached;
	let compiled: RegExp | null = null;
	try {
		compiled = new RegExp(pattern, "i");
	} catch {
		compiled = null;
	}
	if (cache.size > 500) cache.clear();
	cache.set(pattern, compiled);
	return compiled;
}

function matches(toolset: Toolset, toolName: string): boolean {
	for (const pattern of toolset.patterns) {
		const regex = compile(pattern);
		if (regex !== null && regex.test(toolName)) return true;
	}
	return false;
}

function applies(toolset: Toolset): boolean {
	return toolset.builtin || toolset.enabled;
}

/** Maps a tool name to the most severe risk among the matching toolsets. */
export function classify(toolName: string, toolsets: Toolset[]): Classification | null {
	let risk: Risk | null = null;
	const names: string[] = [];
	for (const toolset of toolsets) {
		if (!applies(toolset)) continue;
		if (!matches(toolset, toolName)) continue;
		names.push(toolset.name);
		if (risk === null || SEVERITY[toolset.risk] > SEVERITY[risk]) risk = toolset.risk;
	}
	if (risk === null) return null;
	return { risk, toolsets: names };
}
