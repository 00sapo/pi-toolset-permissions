import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { canonicalPath, isAllowedPath, resolveDirectory, isInside, outsidePaths, resolvePath, scanBashPaths, stripAt } from "./scope.ts";
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
		const state = stateWith((current) => {
			current.flags.write = true;
		});
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

test("scanBashPaths finds absolute and relative paths", () => {
	withWorkspace((space) => {
		assert.deepEqual(scanBashPaths("cat /etc/passwd", space.project), ["/etc/passwd"]);
		assert.deepEqual(scanBashPaths("cat ../x", space.project), [resolve(space.project, "..", "x")]);
		assert.deepEqual(scanBashPaths("cat ./a/b.txt", space.project), [join(space.project, "a", "b.txt")]);
	});
});

test("scanBashPaths splits --flag=value", () => {
	withWorkspace((space) => {
		assert.deepEqual(scanBashPaths("tool --file=/x", space.project), ["/x"]);
		assert.deepEqual(scanBashPaths("tool --file=notes.txt", space.project), []);
		assert.deepEqual(scanBashPaths("tool --verbose", space.project), []);
	});
});

test("scanBashPaths keeps the argument of cd and pushd", () => {
	withWorkspace((space) => {
		assert.deepEqual(scanBashPaths("cd ..", space.project), [resolve(space.project, "..")]);
		assert.deepEqual(scanBashPaths("cd -P ..", space.project), [resolve(space.project, "..")]);
		assert.deepEqual(scanBashPaths("pushd /tmp", space.project), ["/tmp"]);
	});
});

test("scanBashPaths resolves cd targets without a slash", () => {
	withWorkspace((space) => {
		assert.deepEqual(scanBashPaths("cd /", space.project), ["/"]);
		assert.deepEqual(scanBashPaths("cd /tmp", space.project), ["/tmp"]);
		assert.deepEqual(scanBashPaths("cd -P ..", space.project), [resolve(space.project, "..")]);
		assert.deepEqual(scanBashPaths("cd -L ../x", space.project), [resolve(space.project, "..", "x")]);
		assert.deepEqual(scanBashPaths("cd -P /", space.project), ["/"]);
	});
});

test("scanBashPaths ignores redirection to /dev/null", () => {
	withWorkspace((space) => {
		assert.deepEqual(scanBashPaths("echo hi 2>/dev/null", space.project), []);
		assert.deepEqual(scanBashPaths("ls > /dev/null", space.project), []);
		assert.deepEqual(scanBashPaths("ls 2> /dev/null > /dev/null", space.project), []);
		assert.deepEqual(scanBashPaths("echo hi >/dev/null 2>&1", space.project), []);
		assert.deepEqual(scanBashPaths("echo hi > /tmp/out", space.project), ["/tmp/out"]);
	});
});

test("scanBashPaths detects a path inside --flag=value", () => {
	withWorkspace((space) => {
		assert.deepEqual(scanBashPaths("tool --file=/etc/passwd", space.project), ["/etc/passwd"]);
		assert.deepEqual(scanBashPaths("tool --input=/etc/hosts", space.project), ["/etc/hosts"]);
		assert.deepEqual(scanBashPaths("tool --output=../out.txt", space.project), [resolve(space.project, "..", "out.txt")]);
	});
});

test("scanBashPaths skips URLs, flags, and plain words", () => {
	withWorkspace((space) => {
		assert.deepEqual(scanBashPaths("curl https://example.com/a", space.project), []);
		assert.deepEqual(scanBashPaths("ls -la", space.project), []);
		assert.deepEqual(scanBashPaths("echo hello world", space.project), []);
		assert.deepEqual(scanBashPaths("npm install", space.project), []);
		assert.deepEqual(scanBashPaths("FOO=bar ls", space.project), []);
	});
});

test("scanBashPaths strips quotes and removes duplicates", () => {
	withWorkspace((space) => {
		assert.deepEqual(scanBashPaths(`cat '/etc/passwd' "/etc/passwd"`, space.project), ["/etc/passwd"]);
	});
});

test("scanBashPaths handles shell separators", () => {
	withWorkspace((space) => {
		assert.deepEqual(scanBashPaths("cd /tmp && ls /etc; cat /root/x", space.project), [
			"/tmp",
			"/etc",
			"/root/x",
		]);
	});
});

test("scanBashPaths resolves a tilde path", () => {
	withWorkspace((space) => {
		assert.deepEqual(scanBashPaths("cat ~/notes.txt", space.project), [join(homedir(), "notes.txt")]);
	});
});

test("outsidePaths keeps only the disallowed values", () => {
	withWorkspace((space) => {
		const state = stateWith();
		const values = [join(space.project, "file.txt"), "/etc/passwd", join(space.outside, "secret.txt")];
		assert.deepEqual(outsidePaths(state, space.project, values), [
			"/etc/passwd",
			join(space.outside, "secret.txt"),
		]);
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

test("scanBashPaths ignores variable assignments", () => {
	const cwd = "/tmp/work";
	assert.deepEqual(scanBashPaths("PATH=/usr/local/bin:$PATH pytest", cwd), []);
	assert.deepEqual(scanBashPaths("env PATH=/usr/bin:/bin ls", cwd), []);
});
