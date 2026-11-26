import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixtureTmpdir } from "../tests/helpers/temp.ts";
import { overlapsProtectedRoot } from "./paths.ts";

test("permission fixtures avoid sandbox-owned and system temporary directories", () => {
	for (const preferred of ["/run/pi-home/tmp", "/usr", "/proc", "/"]) {
		assert.equal(overlapsProtectedRoot(fixtureTmpdir(preferred)), false);
	}
});

test("permission fixtures keep a suitable temporary directory", () => {
	const root = mkdtempSync(join(fixtureTmpdir(), "pi-fixture-test-"));
	try {
		assert.equal(fixtureTmpdir(root), realpathSync(root));
		assert.equal(overlapsProtectedRoot(fixtureTmpdir(join(root, "missing"))), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("permission fixtures check symlink targets before accepting a temporary directory", { skip: process.platform === "win32" }, () => {
	const root = mkdtempSync(join(fixtureTmpdir(), "pi-fixture-link-"));
	try {
		const link = join(root, "protected");
		symlinkSync("/usr", link);
		assert.equal(overlapsProtectedRoot(fixtureTmpdir(link)), false);
		assert.notEqual(fixtureTmpdir(link), realpathSync(link));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
