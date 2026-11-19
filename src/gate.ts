import { scopeRoots } from "./scope.ts";
import type { BlockKind, GateDecision, PermissionsState } from "./types.ts";
import { classify } from "./classify.ts";
import { isAllowedPath, resolvePath, stripAt } from "./scope.ts";

const MAX_REASON = 240;

/** Argument names that hold a path. */
const PATH_KEYS = ["path", "file_path", "filePath", "file", "paths", "files"];

function blocked(kind: BlockKind, reason: string): Extract<GateDecision, { block: true }> {
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
	const roots = listPaths(scopeRoots(state, cwd));
	return `Blocked: "${stripAt(value)}" resolves to ${resolvePath(cwd, value)}, outside the allowed roots: ${roots}. Ask the user to add the path or change the scope with the permissions tool.`;
}

/** Decides whether a tool call may run. Pure: no I/O, no state changes. */
export function evaluateCall(
	state: PermissionsState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): GateDecision {
	// This action only requests approval. The coordinator gates the target call.
	if (toolName === "permissions" && input.action === "request_tool") return { block: false };

	// A permission change reaches its own dialog, so its directory argument is not
	// a target file path. Classification still applies below.
	if (toolName !== "permissions") {
		for (const path of stringValues(input, PATH_KEYS)) {
			if (!isAllowedPath(state, cwd, path)) return blocked("scope", pathReason(state, cwd, path));
		}
	}

	const matched = classify(toolName, state.toolsets);
	if (matched === null) {
		// Include disabled patterns only to distinguish known tools from unknown tools.
		const known = classify(toolName, state.toolsets.map((toolset) => ({ ...toolset, enabled: true })));
		if (known === null) return blocked("unknown", noToolsetReason(toolName));
		const permission = classify("permissions", state.toolsets);
		const instruction = permission?.mode === "on"
			? 'Ask the user to turn on a matching toolset with permissions action "set_toolset".'
			: "Ask the user to turn on a matching toolset in /permissions.";
		return blocked("disabled", `Blocked: tool "${toolName}" matches only disabled toolsets. ${instruction}`);
	}
	if (matched.mode === "ask") {
		return {
			...blocked("ask", 'Approval required: explain the action and reason. The user approval resumes this call.'),
			toolsets: matched.askToolsets,
		};
	}

	// Bash is one tool. The sandboxes run it inside the OS boundary.
	return { block: false };
}
