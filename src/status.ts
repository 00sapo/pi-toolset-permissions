/** Footer and text reports. Pure: no runtime imports, so the tests can load it. */

import { platformPolicy } from "./platform.ts";
import type { SandboxTarget } from "./sandbox-scope.ts";
import { networkLabel, scopeLabel, toolsetMode } from "./types.ts";
import type { PermissionsState } from "./types.ts";

/**
 * The short word for a filesystem mode. It is the only part that always appears, because
 * the filesystem layer is the restriction that a user changes most often.
 */
function filesystemWord(state: PermissionsState): string {
	return state.sandboxes.filesystem === "read+write" ? "rw" : state.sandboxes.filesystem === "read" ? "read" : "off";
}

/** The short word for the scope. The project root is the default, so it adds no word. */
function scopeWord(state: PermissionsState): string | undefined {
	return state.scope === "custom" ? "custom" : state.scope === "everywhere" ? "all" : undefined;
}

/**
 * One short line for the footer. It names only what is not the default: the toolset count
 * when a toolset is not on, the filesystem mode, the network when connections are forbidden,
 * and the scope unless it is the project root.
 *
 * The caller applies the dim color. This function returns plain text, so a test and an RPC
 * client read the same string.
 */
export function statusLine(
	state: PermissionsState,
	target: SandboxTarget = "bash",
	platform: NodeJS.Platform = process.platform,
): string {
	const parts: string[] = [];
	// A count costs space, so it appears only when a toolset is off or asks.
	const on = state.toolsets.filter((toolset) => toolset.enabled === true).length;
	if (on < state.toolsets.length) parts.push(`${on}/${state.toolsets.length}`);
	const policy = platformPolicy(platform);
	// Windows has no backend, so the layer state would only mislead.
	parts.push(policy.plan === "disabled" ? "sb:off" : `fs:${filesystemWord(state)}`);
	// A forbidden network is the unusual state, so the allowed one stays silent.
	if (state.sandboxes.no_network && policy.plan !== "disabled") parts.push("net:off");
	// The sandbox covers bash alone on macOS, and every other tool must then be off.
	if (policy.plan === "bash-only" && target === "all-tools") parts.push("bash");
	const scope = scopeWord(state);
	if (scope !== undefined) parts.push(scope);
	return parts.join(" ");
}

/** Compact text report of the current state. It always names the coverage and the platform. */
export function statusText(
	state: PermissionsState,
	target: SandboxTarget = "bash",
	platform: NodeJS.Platform = process.platform,
): string {
	const lines = [`toolsets (${state.toolsets.length}):`];
	for (const toolset of state.toolsets) {
		const marker = toolset.builtin ? "builtin" : "custom";
		lines.push(`  ${toolset.name} ${toolsetMode(toolset.enabled)} ${marker} patterns=${toolset.patterns.length}`);
	}
	lines.push(
		`sandboxes: filesystem=${state.sandboxes.filesystem} network=${networkLabel(state.sandboxes.no_network).toLowerCase()}`,
	);
	const policy = platformPolicy(platform);
	lines.push(`sandbox coverage: ${policy.coverage}`);
	if (policy.reason !== undefined) lines.push(`sandbox status: ${policy.reason}`);
	lines.push(`unsandboxed tools: ${state.unsandboxed_tools.length === 0 ? "none" : state.unsandboxed_tools.join(", ")}`);
	lines.push(`custom mounts: ${state.sandbox_mounts.length === 0 ? "none" : state.sandbox_mounts.map((mount) => `${mount.path} (${mount.writable ? "read-write" : "read-only"})`).join(", ")}`);
	lines.push(`scope: ${state.scope} (${scopeLabel(state.scope)})`);
	lines.push(
		`paths: ${state.scope === "everywhere" ? "everywhere" : state.scope === "project" || state.extra_paths.length === 0 ? "the project root only" : "the project root, " + state.extra_paths.join(", ")}`,
		`saved extra paths: ${state.extra_paths.length}`,
	);
	return lines.join("\n");
}
