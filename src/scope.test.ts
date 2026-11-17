import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalPath, isAllowedPath, resolveDirectory, isInside, resolvePath, stripAt } from "./scope.ts";
import { defaultState } from "./state.ts";
import type { PermissionsState } from "./types.ts";

interface Workspace {
	root: string;
	project: string;
	outside: string;
	cleanup: () => void;
}

function workspace(): Workspace {
	const root = mkdtempSync(join(tmpdir(), "pi-perm-"));
	const project = join(root, "project");
	const outside = join(root, "outside");
	mkdirSync(project);
	mkdirSync(outside);
	writeFileSync(join(project, "file.txt"), "x");
	writeFileSync(join(outside, "secret.txt"), "x");
	return { root, project, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function withWorkspace(run: (space: Workspace) => void): void {
	const space = workspace();
	try {
		run(space);
	} finally {
		space.cleanup();
	}
}

function stateWith(mutate: (state: PermissionsState) => void = () => {}): PermissionsState {
	const state = defaultState();
	mutate(state);
	return state;
}

test("stripAt removes one leading @", () => {
	assert.equal(stripAt("@/tmp/x"), "/tmp/x");
	assert.equal(stripAt("@@x"), "@x");
	assert.equal(stripAt("/tmp/x"), "/tmp/x");
	assert.equal(stripAt("@"), "");
});

test("resolvePath resolves relative paths against cwd", () => {
	withWorkspace((space) => {
		assert.equal(resolvePath(space.project, "file.txt"), join(space.project, "file.txt"));
		assert.equal(resolvePath(space.project, "./file.txt"), join(space.project, "file.txt"));
		assert.equal(resolvePath(space.project, "../outside"), resolve(space.project, "..", "outside"));
	});
});

test("resolvePath expands a leading tilde", () => {
	withWorkspace((space) => {
		assert.equal(resolvePath(space.project, "~"), homedir());
		assert.equal(resolvePath(space.project, "~/notes.txt"), join(homedir(), "notes.txt"));
	});
});

test("resolvePath strips an @ prefix", () => {
	withWorkspace((space) => {
		assert.equal(resolvePath(space.project, "@/tmp/x"), "/tmp/x");
		assert.equal(resolvePath(space.project, "@file.txt"), join(space.project, "file.txt"));
	});
});

test("canonicalPath keeps a missing tail", () => {
	withWorkspace((space) => {
		assert.equal(canonicalPath(join(space.project, "a", "b.txt")), join(space.project, "a", "b.txt"));
		assert.equal(canonicalPath(space.project), space.project);
	});
});

test("isInside accepts the root and its children only", () => {
	withWorkspace((space) => {
		assert.equal(isInside(space.project, space.project), true);
		assert.equal(isInside(space.project, join(space.project, "file.txt")), true);
		assert.equal(isInside(space.project, join(space.project, "a", "b")), true);
		assert.equal(isInside(space.project, space.outside), false);
		assert.equal(isInside(space.project, join(space.project, "..")), false);
		assert.equal(isInside(join(space.project, "a"), join(space.project, "ab")), false);
	});
});

test("isAllowedPath accepts project paths", () => {
	withWorkspace((space) => {
		const state = stateWith();
		assert.equal(isAllowedPath(state, space.project, "file.txt"), true);
		assert.equal(isAllowedPath(state, space.project, join(space.project, "new", "dir")), true);
	});
});

test("isAllowedPath blocks a parent escape", () => {
	withWorkspace((space) => {
		const state = stateWith();
		assert.equal(isAllowedPath(state, space.project, "../outside/secret.txt"), false);
		assert.equal(isAllowedPath(state, space.project, join(space.outside, "secret.txt")), false);
	});
});

test("isAllowedPath blocks a symlink escape", () => {
	withWorkspace((space) => {
		const link = join(space.project, "link");
		symlinkSync(space.outside, link, "dir");
		const state = stateWith();
		assert.equal(isAllowedPath(state, space.project, "link/secret.txt"), false);
		assert.equal(isInside(space.project, join(link, "secret.txt")), false);
	});
});

test("isAllowedPath blocks a write target that escapes through a symlink", () => {
	withWorkspace((space) => {
		const link = join(space.project, "link");
		symlinkSync(space.outside, link, "dir");
		const state = stateWith();
		assert.equal(isAllowedPath(state, space.project, join(link, "secret.txt")), false);
		assert.equal(isAllowedPath(state, space.project, join(link, "new.txt")), false);
		assert.equal(isAllowedPath(state, space.project, join(space.project, "new.txt")), true);
	});
});

test("isAllowedPath accepts a path inside an extra root", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.extra_paths = [space.outside];
		});
		assert.equal(isAllowedPath(state, space.project, join(space.outside, "secret.txt")), true);
		assert.equal(isAllowedPath(state, space.project, "../outside"), true);
		assert.equal(isAllowedPath(state, space.project, "/etc/passwd"), false);
	});
});

test("everywhere allows any path", () => {
	withWorkspace((space) => {
		const state = stateWith((current) => {
			current.scope = "everywhere";
		});
		assert.equal(isAllowedPath(state, space.project, "/etc/passwd"), true);
		assert.equal(isAllowedPath(state, space.project, join(space.outside, "secret.txt")), true);
	});
});


test("resolveDirectory stores the canonical path of a symlink", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-perm-"));
	try {
		const real = join(root, "real");
		const link = join(root, "link");
		mkdirSync(real);
		symlinkSync(real, link);
		const result = resolveDirectory(root, "link");
		assert.deepEqual(result, { path: canonicalPath(real) });
		assert.deepEqual(resolveDirectory(root, "missing"), { error: `${join(root, "missing")} does not exist.` });
		writeFileSync(join(root, "file"), "x");
		assert.deepEqual(resolveDirectory(root, "file"), { error: `${join(root, "file")} is not a directory.` });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

