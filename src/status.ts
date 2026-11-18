/** Footer and text reports. Pure: no runtime imports, so the tests can load it. */

import { SANDBOXES } from "./sandboxes.ts";
import { platformPolicy, requiresBashOnly } from "./platform.ts";
import type { SandboxTarget } from "./sandbox-scope.ts";
import { toolsetMode } from "./types.ts";
import type { PermissionsState } from "./types.ts";

function onOff(value: boolean): string {
	return value ? "on" : "off";
}

/**
 * One-line summary for the footer. The sandbox part names the coverage: every tool on
 * Linux, bash only on macOS, and disabled on Windows.
 */
export function statusLine(
	state: PermissionsState,
	target: SandboxTarget = "bash",
	platform: NodeJS.Platform = process.platform,
): string {
	const on = state.toolsets.filter((toolset) => toolset.enabled === true).length;
	const ask = state.toolsets.filter((toolset) => toolset.enabled === "ask").length;
	const head = `toolsets: ${on} on ${ask} ask ${state.toolsets.length - on - ask} off`;
	const policy = platformPolicy(platform);
	if (policy.plan === "disabled") return `${head} sandbox:disabled ${state.scope}`;
	const active = SANDBOXES.filter((sandbox) => state.sandboxes[sandbox.key]).length;
	if (active === 0) return `${head} sandboxes:off ${state.scope}`;
	const depth = target === "all-tools" ? "all tools" : "bash only";
	const warning = requiresBashOnly(policy) && target === "all-tools" ? " (bash only here)" : "";
	return `${head} sandboxes:${active}/${SANDBOXES.length} ${depth}${warning} ${state.scope}`;
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
		`sandboxes: readonly_bash=${onOff(state.sandboxes.readonly_bash)} no_network=${onOff(state.sandboxes.no_network)}`,
	);
	const policy = platformPolicy(platform);
	lines.push(`sandbox coverage: ${policy.coverage}`);
	if (policy.reason !== undefined) lines.push(`sandbox status: ${policy.reason}`);
	lines.push(`scope: ${state.scope}`);
	lines.push(
		`paths: ${state.extra_paths.length === 0 ? "the project root only" : state.extra_paths.join(", ")}`,
	);
	return lines.join("\n");
}
