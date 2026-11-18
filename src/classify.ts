import type { Classification, Toolset } from "./types.ts";

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

/** Returns the enabled toolsets that match a tool name, in state order. */
export function classify(toolName: string, toolsets: Toolset[]): Classification | null {
	const names: string[] = [];
	const askToolsets: string[] = [];
	let on = false;
	for (const toolset of toolsets) {
		if (!toolset.enabled) continue;
		if (matches(toolset, toolName)) {
			names.push(toolset.name);
			if (toolset.enabled === "ask") askToolsets.push(toolset.name);
			else on = true;
		}
	}
	return names.length === 0 ? null : { toolsets: names, mode: on ? "on" : "ask", askToolsets };
}
