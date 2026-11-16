import type { SandboxFlags } from "./types.ts";

export interface SandboxInfo {
	key: keyof SandboxFlags;
	label: string;
	description: string;
}

export const SANDBOXES: SandboxInfo[] = [
	{
		key: "readonly_bash",
		label: "Bash read-only",
		description: "Reject bash commands that change files.",
	},
	{
		key: "no_network",
		label: "Bash no-network",
		description: "Reject bash commands that can reach the network.",
	},
];

const SEPARATORS = /[;\n|&()`]+/;

/** Commands that do nothing by themselves and wrap the real command. */
const PREFIX_WORDS = new Set(["env", "nohup", "command", "time", "exec", "sudo", "builtin", "nice"]);

/** Interpreters that can change files when they run code. */
const INTERPRETERS = new Set([
	"python",
	"python2",
	"python3",
	"node",
	"deno",
	"bun",
	"tsx",
	"ts-node",
	"ruby",
	"perl",
	"php",
	"lua",
	"rscript",
	"osascript",
]);

/** Arguments that only report the interpreter version, with no side effect. */
const INERT_INTERPRETER_ARGS = new Set(["--version", "-v", "-V", "--help", "-h"]);

const WRITE_COMMANDS: Record<string, string> = {
	rm: "rm can delete files",
	rmdir: "rmdir can delete directories",
	mv: "mv can move or overwrite files",
	cp: "cp can copy files",
	dd: "dd can write files",
	truncate: "truncate can change file sizes",
	touch: "touch can create or update files",
	mkdir: "mkdir can create directories",
	chmod: "chmod can change file permissions",
	chown: "chown can change file ownership",
	ln: "ln can create links",
	tee: "tee can write files",
	install: "install can write files",
	shred: "shred can delete files",
	vi: "vi can edit files",
	vim: "vim can edit files",
	nano: "nano can edit files",
	xargs: "xargs can run any command",
};

const GIT_WRITE = new Set([
	"add",
	"apply",
	"branch",
	"checkout",
	"clean",
	"clone",
	"commit",
	"config",
	"filter-branch",
	"gc",
	"init",
	"merge",
	"mv",
	"notes",
	"prune",
	"pull",
	"push",
	"rebase",
	"remote",
	"reset",
	"restore",
	"rm",
	"stash",
	"submodule",
	"switch",
	"tag",
	"update-ref",
	"worktree",
]);

const GIT_NETWORK = new Set(["clone", "fetch", "ls-remote", "pull", "push", "submodule"]);

const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** Git subcommands that also have a read-only form. */
const GIT_READ_SUBS = new Set(["branch", "config", "remote", "stash", "tag"]);

const GIT_READ_FLAGS = new Set(["-l", "--list", "-a", "--all", "-v", "--get", "--get-all", "list"]);

const DOCKER_NETWORK = new Set(["build", "compose", "create", "pull", "push", "run"]);

const DOCKER_WRITE = new Set(["build", "compose", "create", "run", "start", "stop", "rm", "down", "up"]);

const GH_NETWORK = new Set(["api", "clone", "repo"]);

const INSTALLERS: Record<string, Set<string>> = {
	npm: new Set(["install", "i", "ci", "add", "remove", "uninstall", "update"]),
	pnpm: new Set(["install", "i", "add", "remove", "uninstall", "update"]),
	yarn: new Set(["install", "add", "remove", "upgrade", "update"]),
	bun: new Set(["install", "i", "add", "remove"]),
	pip: new Set(["install", "add", "uninstall"]),
	pip3: new Set(["install", "add", "uninstall"]),
	poetry: new Set(["install", "add"]),
	cargo: new Set(["install"]),
	go: new Set(["install", "get"]),
	apt: new Set(["install", "remove", "update", "upgrade"]),
	"apt-get": new Set(["install", "remove", "update", "upgrade"]),
	dnf: new Set(["install", "remove", "update", "upgrade"]),
	yum: new Set(["install", "remove", "update", "upgrade"]),
	pacman: new Set(["install", "remove", "update", "upgrade"]),
	brew: new Set(["install", "remove", "update", "upgrade"]),
	snap: new Set(["install", "remove", "update", "upgrade"]),
	npx: new Set(["*"]),
	pipx: new Set(["install", "run", "upgrade"]),
	uv: new Set(["add", "sync", "pip", "run", "tool"]),
};

const NETWORK_COMMANDS: Record<string, string> = {
	curl: "curl can reach the network",
	wget: "wget can reach the network",
	nc: "nc can reach the network",
	ncat: "ncat can reach the network",
	nmap: "nmap can reach the network",
	telnet: "telnet can reach the network",
	scp: "scp can reach the network",
	rsync: "rsync can reach the network",
	ssh: "ssh can reach the network",
	ftp: "ftp can reach the network",
	sftp: "sftp can reach the network",
};

function unquote(token: string): string {
	if (token.length >= 2) {
		const first = token[0];
		const last = token[token.length - 1];
		if ((first === '"' || first === "'") && first === last) return token.slice(1, -1);
	}
	return token;
}

function segmentsOf(command: string): string[][] {
	return stripQuoted(command)
		.replace(SEPARATORS, ";")
		.split(";")
		.map((segment) =>
			segment
				.split(/\s+/)
				.map(unquote)
				.filter((word) => word.length > 0),
		)
		.filter((words) => words.length > 0);
}

function commandName(word: string | undefined): string {
	if (word === undefined) return "";
	const cleaned = word.replace(/^\\+/, "");
	return cleaned.slice(cleaned.lastIndexOf("/") + 1);
}

/** Drops variable assignments and wrappers such as `sudo` or `env`. */
function splitPrefix(words: string[]): { rest: string[]; prefix: string[] } {
	let index = 0;
	const prefix: string[] = [];
	while (index < words.length) {
		const word = words[index];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			index += 1;
			continue;
		}
		if (PREFIX_WORDS.has(word)) {
			prefix.push(word);
			index += 1;
			continue;
		}
		break;
	}
	return { rest: words.slice(index), prefix };
}

function subcommand(words: string[]): string | null {
	for (let i = 1; i < words.length; i++) {
		const word = words[i];
		if (word.startsWith("-")) continue;
		return word;
	}
	return null;
}

function gitSubcommand(words: string[]): string | null {
	for (let i = 1; i < words.length; i++) {
		const word = words[i];
		if (word.startsWith("-")) {
			if (GIT_VALUE_FLAGS.has(word)) i += 1;
			continue;
		}
		return word;
	}
	return null;
}

/** Removes heredoc bodies and quoted text, keeping the first line of a heredoc header. */
function stripQuoted(command: string): string {
	return command
		.replace(
			/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?([^\n]*)\n[\s\S]*?\n\1\b[^\n]*/g,
			(_match, _word: string, tail: string) => tail,
		)
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/'[^']*'/g, "''");
}

function hasWriteRedirect(command: string): boolean {
	const stripped = stripQuoted(command.replace(/&?>>?\s*["']?\/dev\/null["']?/g, " "))
		.replace(/\d*>&\d+/g, " ")
		.replace(/\\[<>|&]/g, " ");
	return />>?/.test(stripped);
}

/** True for in-place edit flags such as -i, -pi, -i.bak, and --in-place. */
function isInPlaceFlag(word: string): boolean {
	return word.startsWith("--in-place") || /^-[A-Za-z]*i/.test(word);
}

function inPlaceReason(name: string, words: string[]): string | null {
	for (const word of words.slice(1)) {
		if (isInPlaceFlag(word)) return `${name} ${word} can change files`;
	}
	return null;
}

function installerReason(words: string[]): string | null {
	const name = commandName(words[0]);
	const actions = INSTALLERS[name];
	if (actions === undefined) return null;
	if (actions.has("*")) return name;
	const action = subcommand(words);
	if (action === null || !actions.has(action)) return null;
	return `${name} ${action}`;
}

/** Returns a reason when an interpreter runs code, and null for a version query. */
function interpreterReason(words: string[]): string | null {
	const args = words.slice(1);
	if (args.length === 1 && INERT_INTERPRETER_ARGS.has(args[0] ?? "")) return null;
	if (args.length === 0) return null;
	return "the interpreter can run code that changes files";
}

/** Extracts the payload of `sh -c`, `bash -lc`, and `eval` before segmentation. */
function nestedPayloads(command: string): string[] {
	const payloads: string[] = [];
	const shell = /\b(?:sh|bash|zsh|dash|ksh)\b[^;&|\n]*?\s-[A-Za-z]*c\s+(['"])([\s\S]*?)\1/g;
	for (const match of command.matchAll(shell)) {
		const payload = match[2];
		if (payload !== undefined && payload.trim().length > 0) payloads.push(payload);
	}
	const evalPattern = /\beval\s+("[^"]*"|'[^']*'|[^\n;]+)/g;
	for (const match of command.matchAll(evalPattern)) {
		const payload = match[1];
		if (payload !== undefined && payload.trim().length > 0) payloads.push(unquote(payload.trim()));
	}
	return payloads;
}

function writeSegmentReason(words: string[]): string | null {
	const { rest, prefix } = splitPrefix(words);
	if (prefix.includes("sudo")) return "sudo can change the system";
	const name = commandName(rest[0]);
	if (name.length === 0) return null;
	if (name === "git") {
		const sub = gitSubcommand(rest);
		if (sub === null || !GIT_WRITE.has(sub)) return null;
		if (GIT_READ_SUBS.has(sub) && rest.some((word) => GIT_READ_FLAGS.has(word))) return null;
		return `git ${sub} can change files`;
	}
	if (name === "docker") {
		const sub = subcommand(rest);
		if (sub !== null && DOCKER_WRITE.has(sub)) return `docker ${sub} can change files`;
		return null;
	}
	if (name === "find") {
		const restWords = rest.slice(1);
		if (restWords.includes("-delete")) return "find -delete can delete files";
		if (restWords.includes("-exec") || restWords.includes("-execdir")) return "find -exec can run any command";
		return null;
	}
	if (name === "sed" || name === "perl") return inPlaceReason(name, rest);
	const fixed = WRITE_COMMANDS[name];
	if (fixed !== undefined) return fixed;
	const installer = installerReason(rest);
	if (installer !== null) return `${installer} can change installed packages`;
	if (INTERPRETERS.has(name.toLowerCase())) return interpreterReason(rest);
	if (name === "make" && rest.slice(1).some((word) => !word.startsWith("-"))) {
		return "make can write build files";
	}
	return null;
}

const MAX_COMMAND_LENGTH = 8000;
const MAX_NESTING = 3;

function tooLongReason(command: string): string | null {
	if (command.length > MAX_COMMAND_LENGTH) return "the command is too long to check";
	return null;
}

/** Returns a short clause when the command can change the filesystem. */
export function writeCommandReason(command: string, depth = 0): string | null {
	const long = tooLongReason(command);
	if (long !== null) return long;
	if (hasWriteRedirect(command)) return "the command redirects output to a file";
	if (depth < MAX_NESTING) {
		for (const payload of nestedPayloads(command)) {
			if (payload === command) continue;
			const nested = writeCommandReason(payload, depth + 1);
			if (nested !== null) return nested;
		}
	}
	for (const words of segmentsOf(command)) {
		const reason = writeSegmentReason(words);
		if (reason !== null) return reason;
	}
	return null;
}

function networkSegmentReason(words: string[]): string | null {
	const { rest } = splitPrefix(words);
	const name = commandName(rest[0]);
	if (name.length === 0) return null;
	if (name === "xargs") return "xargs can run any command";
	if (name === "find") {
		const restWords = rest.slice(1);
		if (restWords.includes("-exec") || restWords.includes("-execdir")) return "find -exec can run any command";
		return null;
	}
	if (name === "git") {
		const sub = gitSubcommand(rest);
		if (sub !== null && GIT_NETWORK.has(sub)) return `git ${sub} can reach the network`;
		return null;
	}
	if (name === "docker") {
		const sub = subcommand(rest);
		if (sub !== null && DOCKER_NETWORK.has(sub)) return `docker ${sub} can reach the network`;
		return null;
	}
	if (name === "gh") {
		const sub = subcommand(rest);
		if (sub !== null && GH_NETWORK.has(sub)) return `gh ${sub} can reach the network`;
		return null;
	}
	const fixed = NETWORK_COMMANDS[name];
	if (fixed !== undefined) return fixed;
	const installer = installerReason(rest);
	if (installer !== null) return `${installer} can reach the network`;
	return null;
}

/** Returns a short clause when the command can reach the network. */
export function networkCommandReason(command: string, depth = 0): string | null {
	const long = tooLongReason(command);
	if (long !== null) return long;
	if (depth < MAX_NESTING) {
		for (const payload of nestedPayloads(command)) {
			if (payload === command) continue;
			const nested = networkCommandReason(payload, depth + 1);
			if (nested !== null) return nested;
		}
	}
	for (const words of segmentsOf(command)) {
		const reason = networkSegmentReason(words);
		if (reason !== null) return reason;
	}
	return null;
}
