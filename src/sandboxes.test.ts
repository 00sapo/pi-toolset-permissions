import assert from "node:assert/strict";
import test from "node:test";
import { SANDBOXES, networkCommandReason, writeCommandReason } from "./sandboxes.ts";

interface Case {
	command: string;
	reason: string | null;
}

function check(reason: (command: string) => string | null, cases: Case[]): void {
	for (const item of cases) {
		const actual = reason(item.command);
		if (item.reason === null) assert.equal(actual, null, `expected no reason for: ${item.command}`);
		else assert.ok(actual?.includes(item.reason), `expected "${item.reason}" for: ${item.command}, got ${actual}`);
	}
}

test("SANDBOXES lists the two switches in order", () => {
	assert.deepEqual(
		SANDBOXES.map((entry) => [entry.key, entry.label, entry.description]),
		[
			["readonly_bash", "Bash read-only", "Reject bash commands that change files."],
			["no_network", "Bash no-network", "Reject bash commands that can reach the network."],
		],
	);
});

test("writeCommandReason detects redirection to a file", () => {
	check(writeCommandReason, [
		{ command: "echo hi > out.txt", reason: "redirects output" },
		{ command: "echo hi >> out.txt", reason: "redirects output" },
		{ command: "cat a b | tee c", reason: "tee" },
	]);
});

test("writeCommandReason ignores safe redirection", () => {
	check(writeCommandReason, [
		{ command: "ls 2>&1", reason: null },
		{ command: "ls > /dev/null", reason: null },
		{ command: "ls > /dev/null 2>&1", reason: null },
		{ command: "ls >> /dev/null", reason: null },
		{ command: "cat a 1>&2", reason: null },
	]);
});

test("writeCommandReason detects file commands", () => {
	check(writeCommandReason, [
		{ command: "rm -rf build", reason: "rm can delete files" },
		{ command: "rmdir empty", reason: "rmdir" },
		{ command: "mv a b", reason: "mv" },
		{ command: "cp a b", reason: "cp" },
		{ command: "dd if=a of=b", reason: "dd" },
		{ command: "truncate -s 0 log", reason: "truncate" },
		{ command: "touch new.txt", reason: "touch" },
		{ command: "mkdir -p a/b", reason: "mkdir" },
		{ command: "chmod 600 file", reason: "chmod" },
		{ command: "chown root file", reason: "chown" },
		{ command: "ln -s a b", reason: "ln" },
		{ command: "sed -i 's/a/b/' file", reason: "sed -i" },
		{ command: "perl -i.bak -pe 's/a/b/' file", reason: "perl -i" },
		{ command: "vim notes.txt", reason: "vim" },
		{ command: "nano notes.txt", reason: "nano" },
		{ command: "sudo ls", reason: "sudo" },
	]);
});

test("writeCommandReason detects git subcommands", () => {
	check(writeCommandReason, [
		{ command: "git commit -m x", reason: "git commit" },
		{ command: "git push origin main", reason: "git push" },
		{ command: "git checkout main", reason: "git checkout" },
		{ command: "git switch main", reason: "git switch" },
		{ command: "git reset --hard", reason: "git reset" },
		{ command: "git clean -fd", reason: "git clean" },
		{ command: "git merge topic", reason: "git merge" },
		{ command: "git rebase main", reason: "git rebase" },
		{ command: "git stash", reason: "git stash" },
		{ command: "git apply x.patch", reason: "git apply" },
		{ command: "git tag v1", reason: "git tag" },
		{ command: "git add .", reason: "git add" },
		{ command: "git -C /repo status", reason: null },
		{ command: "git status", reason: null },
		{ command: "git log --oneline", reason: null },
	]);
});

test("writeCommandReason detects package installers", () => {
	check(writeCommandReason, [
		{ command: "npm install", reason: "npm install" },
		{ command: "npm i left-pad", reason: "npm i" },
		{ command: "pnpm add react", reason: "pnpm add" },
		{ command: "yarn remove react", reason: "yarn remove" },
		{ command: "bun install", reason: "bun install" },
		{ command: "pip install requests", reason: "pip install" },
		{ command: "pip3 install requests", reason: "pip3 install" },
		{ command: "poetry add requests", reason: "poetry add" },
		{ command: "cargo install ripgrep", reason: "cargo install" },
		{ command: "go get example.com/mod", reason: "go get" },
		{ command: "apt-get install -y curl", reason: "apt-get install" },
		{ command: "sudo dnf install git", reason: "sudo" },
		{ command: "brew update", reason: "brew update" },
		{ command: "npm run build", reason: null },
		{ command: "npm test", reason: null },
		{ command: "go build ./...", reason: null },
	]);
});

test("writeCommandReason leaves read-only commands alone", () => {
	check(writeCommandReason, [
		{ command: "ls -la", reason: null },
		{ command: "cat file.txt", reason: null },
		{ command: "grep -rn foo .", reason: null },
		{ command: "git diff", reason: null },
		{ command: "node --version", reason: null },
		{ command: "bun --version", reason: null },
		{ command: "echo hello", reason: null },
	]);
});

test("writeCommandReason checks every segment", () => {
	check(writeCommandReason, [{ command: "cd /tmp && rm -f x", reason: "rm" }]);
});

test("networkCommandReason detects network commands", () => {
	check(networkCommandReason, [
		{ command: "curl https://example.com", reason: "curl" },
		{ command: "wget https://example.com/f", reason: "wget" },
		{ command: "nc -l 8000", reason: "nc" },
		{ command: "nmap 10.0.0.1", reason: "nmap" },
		{ command: "telnet host 25", reason: "telnet" },
		{ command: "scp a host:/x", reason: "scp" },
		{ command: "rsync -a a host:/x", reason: "rsync" },
		{ command: "ssh host", reason: "ssh" },
		{ command: "sftp host", reason: "sftp" },
	]);
});

test("networkCommandReason detects git, docker, and gh", () => {
	check(networkCommandReason, [
		{ command: "git clone https://example.com/x", reason: "git clone" },
		{ command: "git fetch origin", reason: "git fetch" },
		{ command: "git pull", reason: "git pull" },
		{ command: "git push", reason: "git push" },
		{ command: "git ls-remote origin", reason: "git ls-remote" },
		{ command: "docker pull alpine", reason: "docker pull" },
		{ command: "docker run alpine", reason: "docker run" },
		{ command: "gh api /repos/x/y", reason: "gh api" },
		{ command: "gh clone x/y", reason: "gh clone" },
		{ command: "gh repo view", reason: "gh repo" },
		{ command: "git status", reason: null },
		{ command: "docker ps", reason: null },
		{ command: "gh pr list", reason: null },
	]);
});

test("networkCommandReason detects package installers", () => {
	check(networkCommandReason, [
		{ command: "npm install", reason: "npm install" },
		{ command: "cargo install ripgrep", reason: "cargo install" },
		{ command: "apt-get update", reason: "apt-get update" },
		{ command: "npm run build", reason: null },
	]);
});

test("networkCommandReason leaves local commands alone", () => {
	check(networkCommandReason, [
		{ command: "ls -la", reason: null },
		{ command: "cat file.txt", reason: null },
		{ command: "echo hi > out.txt", reason: null },
		{ command: "git commit -m x", reason: null },
	]);
});

test("writeCommandReason sees through wrappers and interpreters", () => {
	check(writeCommandReason, [
		{ command: "ls | xargs rm -rf /", reason: "xargs" },
		{ command: "find /home -delete", reason: "find -delete" },
		{ command: "find . -exec rm {} +", reason: "find -exec" },
		{ command: "sh -c \"rm -rf /\"", reason: "rm" },
		{ command: "bash -lc \"touch x\"", reason: "touch" },
		{ command: "eval \"rm -rf /\"", reason: "rm" },
		{ command: "perl -pi -e s/a/b/ f", reason: "perl -pi" },
		{ command: "\\rm -rf /tmp/x", reason: "rm" },
		{ command: "python3 build.py", reason: "interpreter" },
		{ command: "node -e \"process.exit(0)\"", reason: "interpreter" },
		{ command: "make install", reason: "make" },
		{ command: "git config user.name x", reason: "git config" },
		{ command: "git branch -D main", reason: "git branch" },
		{ command: "docker compose up", reason: "docker compose" },
	]);
});

test("writeCommandReason ignores operators inside quotes", () => {
	check(writeCommandReason, [
		{ command: "grep -rn 'a>b' src", reason: null },
		{ command: "cat x > \"/dev/null\"", reason: null },
		{ command: "bash --version", reason: null },
		{ command: "node --version", reason: null },
	]);
});

test("networkCommandReason sees through shells and docker", () => {
	check(networkCommandReason, [
		{ command: "sh -c \"curl https://example.com\"", reason: "curl" },
		{ command: "docker compose up", reason: "docker compose" },
		{ command: "pip install requests", reason: "pip install" },
	]);
});

test("networkCommandReason sees through xargs and find -exec", () => {
	check(networkCommandReason, [
		{ command: "ls | xargs curl http://evil", reason: "xargs" },
		{ command: "find . -exec ssh host ;", reason: "find -exec" },
	]);
});

test("heredocs keep a real redirect and ignore their body", () => {
	check(writeCommandReason, [
		{ command: "cat <<EOF > f\nhello\nEOF", reason: "redirects" },
		{ command: "cat <<EOF\nrm -rf /\nEOF", reason: null },
	]);
});

test("very long or deeply nested commands do not throw", () => {
	const deep = "eval ".repeat(20000) + "rm -rf /";
	const long = "sh -c ".repeat(60000) + "curl x";
	for (const command of [deep, long]) {
		const reason = writeCommandReason(command);
		assert.notEqual(reason, null);
	}
	assert.notEqual(networkCommandReason(long), null);
});

test("git read-only forms are not writes", () => {
	check(writeCommandReason, [
		{ command: "git branch -a", reason: null },
		{ command: "git config --get user.name", reason: null },
		{ command: "git remote -v", reason: null },
		{ command: "git tag -l", reason: null },
		{ command: "git stash list", reason: null },
		{ command: "git branch -D main", reason: "git branch" },
		{ command: "git config user.name x", reason: "git config" },
	]);
});

test("escaped operators are not redirects", () => {
	assert.equal(writeCommandReason(String.raw`echo a \> b`), null);
});
