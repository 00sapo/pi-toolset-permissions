import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { overlapsProtectedRoot } from "../../src/paths.ts";

/** Permission fixtures must not live in trees owned by the sandbox. */
export function fixtureTmpdir(preferred = tmpdir()): string {
	for (const candidate of [preferred, "/tmp", "/private/tmp", process.cwd()]) {
		try {
			const path = realpathSync(candidate);
			if (overlapsProtectedRoot(path) || !statSync(path).isDirectory()) continue;
			accessSync(path, constants.W_OK | constants.X_OK);
			return path;
		} catch {
			// Try the next location if this one is missing or inaccessible.
		}
	}
	throw new Error("Permission tests need a writable directory outside sandbox-protected trees.");
}
