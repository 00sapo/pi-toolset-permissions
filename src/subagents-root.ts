import { join, resolve } from "node:path";

/**
 * The directory where pi-subagents keeps async runs.
 *
 * The host owns one such directory. The sandbox gets the same path mounted, so a run
 * launched from inside a sandbox is the run that the host fleet lists, steers, and
 * cleans up. Without it each side computes its own temporary directory from its own
 * `TMPDIR`, and the two never meet.
 *
 * The default matches pi-subagents: `<tmpdir>/pi-subagents-uid-<uid>`.
 */
export function subagentsRunRoot(
	env: Record<string, string | undefined>,
	fallback: { tmpdir: string; uid?: number | string },
): string {
	const configured = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	if (configured) return resolve(configured);
	const scope = fallback.uid === undefined ? "shared" : `uid-${fallback.uid}`;
	return join(fallback.tmpdir, `pi-subagents-${scope}`);
}
