import type { GateDecision, PermissionsState, Risk } from "./types.ts";
import { classify } from "./classify.ts";
import { networkCommandReason, writeCommandReason } from "./sandboxes.ts";
import { isAllowedPath, outsidePaths, resolvePath, scanBashPaths, stripAt } from "./scope.ts";

export const PERMISSIONS_TOOL_NAME = "permissions";

const MAX_REASON = 240;

/** Argument names that hold a command line or a path. */
const COMMAND_KEYS = ["command", "cmd", "script", "code"];
const PATH_KEYS = ["path", "file_path", "filePath", "file", "paths", "files"];

function blocked(reason: string): GateDecision {
	if (reason.length <= MAX_REASON) return { block: true, reason };
	const head = reason.slice(0, MAX_REASON - 102);
	const tail = reason.slice(-97);
	return { block: true, reason: `${head} ... ${tail}` };
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
	return `Blocked: no toolset matches the tool "${toolName}". Ask the user to add one, then call the permissions tool (action "add_toolset").`;
}

function flagReason(risk: Risk, toolName: string): string {
	return `Blocked: the "${risk}" flag is off, so the tool "${toolName}" is blocked. Ask the user to allow ${risk} tools, then call the permissions tool (action "set_flag").`;
}

function listPaths(paths: string[]): string {
	const shown = paths.slice(0, 3).join(", ");
	return paths.length > 3 ? `${shown}, and ${paths.length - 3} more` : shown;
}

function pathReason(state: PermissionsState, cwd: string, value: string): string {
	const roots = listPaths([cwd, ...state.extra_paths]);
	return `Blocked: "${stripAt(value)}" resolves to ${resolvePath(cwd, value)}, outside the allowed roots: ${roots}. Ask the user to add the path or change the scope with the permissions tool.`;
}

function readOnlyCause(state: PermissionsState): string {
	const causes: string[] = [];
	if (!state.flags.write) causes.push("the write flag is off");
	if (state.sandboxes.readonly_bash) causes.push("the read-only bash sandbox is on");
	return causes.join(" and ");
}

function readOnlyReason(state: PermissionsState, detail: string): string {
	return `Blocked: ${readOnlyCause(state)}, so bash must stay read-only, and ${detail}. Ask the user to change it with the permissions tool.`;
}

function networkReason(detail: string): string {
	return `Blocked: the no-network sandbox is on and ${detail}. Ask the user to change it with the permissions tool (action "set_sandbox").`;
}

function bashScopeReason(paths: string[]): string {
	return `Blocked: bash mentions paths outside the allowed roots: ${listPaths(paths)}. This scope check is a heuristic. Ask the user to add the path or change the scope with the permissions tool.`;
}

function noCommandReason(toolName: string): string {
	return `Blocked: the execute tool "${toolName}" has no recognized command argument, so bash must stay read-only and the command cannot be checked. Ask the user to allow write tools with the permissions tool.`;
}

/** Decides whether a tool call may run. Pure: no I/O, no state changes. */
export function evaluateCall(
	state: PermissionsState,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): GateDecision {
	if (toolName === PERMISSIONS_TOOL_NAME) return { block: false };

	const classification = classify(toolName, state.toolsets);
	if (classification === null) return blocked(noToolsetReason(toolName));

	const risk = classification.risk;
	if (!state.flags[risk]) return blocked(flagReason(risk, toolName));

	if (risk === "read" || risk === "write") {
		for (const path of stringValues(input, PATH_KEYS)) {
			if (!isAllowedPath(state, cwd, path)) return blocked(pathReason(state, cwd, path));
		}
	}

	if (risk === "execute") {
		const commands = stringValues(input, COMMAND_KEYS);
		const readOnly = state.sandboxes.readonly_bash || !state.flags.write;
		if (commands.length === 0) {
			if (readOnly) return blocked(noCommandReason(toolName));
			return { block: false };
		}
		for (const command of commands) {
			if (readOnly) {
				const detail = writeCommandReason(command);
				if (detail !== null) return blocked(readOnlyReason(state, detail));
			}
			if (state.sandboxes.no_network) {
				const detail = networkCommandReason(command);
				if (detail !== null) return blocked(networkReason(detail));
			}
			if (state.scope === "project") {
				const outside = outsidePaths(state, cwd, scanBashPaths(command, cwd));
				if (outside.length > 0) return blocked(bashScopeReason(outside));
			}
		}
	}

	return { block: false };
}
