import type { BlockKind, GateDecision, PermissionsState } from "./types.ts";
import { classify } from "./classify.ts";
import { isAllowedPath, resolvePath, stripAt } from "./scope.ts";

export const PERMISSIONS_TOOL_NAME = "permissions";

const MAX_REASON = 240;

/** Argument names that hold a path. */
const PATH_KEYS = ["path", "file_path", "filePath", "file", "paths", "files"];

function blocked(kind: BlockKind, reason: string): GateDecision {
	if (reason.length <= MAX_REASON) return { block: true, kind, reason };
	const head = reason.slice(0, MAX_REASON - 102);
	const tail = reason.slice(-97);
	return { block: true, kind, reason: `${head} ... ${tail}` };
}

function stringValues(input: Record<string, unknown>, keys: string[]): string[] {
	const found: string[] = [];
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) found.push(value);
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (typeof entry === "string" && entry.length > 0) found.push(entry);
			}
		}
	}
	return found;
}

function noToolsetReason(toolName: string): string {
	return `Blocked: no toolset matches the tool "${toolName}". Ask the user to turn on a toolset, then call the permissions tool (action "set_toolset"), or add one (action "add_toolset").`;
}

function listPaths(paths: string[]): string {
	const shown = paths.slice(0, 3).join(", ");
	return paths.length > 3 ? `${shown}, and ${paths.length - 3} more` : shown;
}

function pathReason(state: PermissionsState, cwd: string, value: string): string {
	const roots = listPaths([cwd, ...state.extra_paths]);
	return `Blocked: "${stripAt(value)}" resolves to ${resolvePath(cwd, value)}, outside the allowed roots: ${roots}. Ask the user to add the path or change the scope with the permissions tool.`;
}

/** Decides whether a tool call may run. Pure: no I/O, no state changes. */
export function evaluateCall(
	state: PermissionsState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): GateDecision {
	// The permissions tool stays open even if the state says otherwise. Without it the
	// model could not ask for a fix.
	if (toolName === PERMISSIONS_TOOL_NAME) return { block: false };

	const matched = classify(toolName, state.toolsets);
	if (matched === null) return blocked("unknown", noToolsetReason(toolName));

	const locked = new Set(state.toolsets.filter((toolset) => toolset.locked).map((toolset) => toolset.name));
	if (matched.toolsets.some((name) => locked.has(name))) return { block: false };

	for (const path of stringValues(input, PATH_KEYS)) {
		if (!isAllowedPath(state, cwd, path)) return blocked("scope", pathReason(state, cwd, path));
	}

	// Bash is one tool. The sandboxes run it inside the OS boundary.
	return { block: false };
}
