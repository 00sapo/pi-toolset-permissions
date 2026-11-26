import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mergeState, type StateStore } from "./state.ts";
import type { PermissionsState } from "./types.ts";
import type { SandboxTarget } from "./sandbox-scope.ts";

// Approximate terminal cells for these fixtures: CJK and emoji are wide,
// combining marks take no cells, and ANSI styling takes no cells.
function cellWidth(character: string): number {
	if (/\p{Mark}/u.test(character) || character === "\u200d" || character === "\ufe0f") return 0;
	const point = character.codePointAt(0)!;
	return point >= 0x1100 && (
		point <= 0x115f ||
		(point >= 0x2e80 && point <= 0xa4cf) ||
		(point >= 0xac00 && point <= 0xd7a3) ||
		(point >= 0xf900 && point <= 0xfaff) ||
		(point >= 0xfe10 && point <= 0xfe6f) ||
		(point >= 0xff00 && point <= 0xff60) ||
		point >= 0x1f300
	) ? 2 : 1;
}

function visibleWidth(text: string): number {
	return Array.from(stripVTControlCharacters(text)).reduce((width, character) => width + cellWidth(character), 0);
}

// One terminal color per theme name, so a test can name the style that a row uses.
const COLOR_CODE: Record<string, number> = { accent: 1, success: 2, warning: 3, muted: 4, dim: 5 };

function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
	const plain = stripVTControlCharacters(text);
	if (visibleWidth(plain) <= width) return text;
	let result = "";
	let used = 0;
	const budget = Math.max(0, width - visibleWidth(ellipsis));
	for (const character of plain) {
		const cells = cellWidth(character);
		if (used + cells > budget) break;
		result += character;
		used += cells;
	}
	return result + (visibleWidth(ellipsis) <= width ? ellipsis : "");
}

// Keep the actual UI, patterns, and state helpers. Avoid loading the host runtime.
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		let source: string | undefined;
		if (specifier === "@earendil-works/pi-tui") {
			source = `import { stripVTControlCharacters } from 'node:util';
${cellWidth.toString()}
${visibleWidth.toString()}
export ${truncateToWidth.toString()}`;
		} else if (specifier === "./tool.ts" && context.parentURL?.endsWith("/ui.ts")) {
			source = "export const statusText = () => 'Permissions status';";
		}
		if (source !== undefined) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
let openPermissions: typeof import("./ui.ts").openPermissions;
try {
	({ openPermissions } = await import("./ui.ts"));
} finally {
	hooks.deregister();
}

type Screen = {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
};

async function screenFixture(scope: "project" | "everywhere" | "custom" = "everywhere", platform: NodeJS.Platform = "linux", target: SandboxTarget = "all-tools") {
	const longName = "界🧪e\u0301".repeat(24);
	const patterns = ["^界🧪e\u0301" + "長".repeat(80), "^second_", "^third_"];
	let state: PermissionsState = {
		version: 3,
		scope,
		extra_paths: ["/extra/" + "資料🧪e\u0301/".repeat(30)],
		toolsets: [
			{ name: longName, patterns, enabled: "ask", builtin: false },
			{ name: "second", patterns: ["^second_"], enabled: true, builtin: true },
		],
		sandboxes: { filesystem: "off", no_network: false },
		unsandboxed_tools: ["^exempt_tool$"],
		sandbox_mounts: [],
	};
	const notifications: string[] = [];
	const inputs: Array<string | undefined> = [];
	const confirmations: string[] = [];
	let consent = false;
	const edits: Array<{ title: string; value: string }> = [];
	let screen!: Screen;
	let renders = 0;
	let closed = false;
	// The screen calls saveDefaults and reads the template path, so the fixture names them.
	const saved: string[] = [];
	const store = {
		defaultsFile: "/agent/permissions.json",
		saveDefaults: () => { saved.push(JSON.stringify(state)); },
		get: () => state,
		update: (change: (current: PermissionsState) => PermissionsState) => { const next = change(state); state = { ...next, sandboxes: mergeState(next).sandboxes }; },
	} as StateStore;
	const ctx = {
		mode: "tui",
		cwd: "/project/" + "研究🧪e\u0301/".repeat(30),
		ui: {
			input: async () => inputs.shift(),
			confirm: async (_title: string, message: string) => { confirmations.push(message); return consent; },
			notify: (text: string) => notifications.push(text),
			editor: async (title: string, value: string) => {
				edits.push({ title, value });
				return undefined;
			},
			custom: async (factory: Function) => {
				screen = factory(
					{ requestRender: () => { renders += 1; } },
					{
						fg: (color: string, text: string) => `\x1b[38;5;${COLOR_CODE[color] ?? 0}m${text}\x1b[39m`,
						bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
					},
					{ matches: () => false },
					() => { closed = true; },
				);
			},
		},
	} as unknown as ExtensionContext;
	await openPermissions(store, ctx, ["界🧪e\u0301" + "長".repeat(90), "second_" + longName, "exempt_tool"], target, platform);
	return { savedDefaults: () => saved, inputs, confirmations, setConsent: (value: boolean) => { consent = value; }, state: () => state, notifications, screen, patterns, longName, edits, renders: () => renders, closed: () => closed };
}

function assertFits(screen: Screen, width: number): string[] {
	const lines = screen.render(width);
	assert.ok(lines.length > 5, "The screen contains its rows and instructions");
	for (const [index, line] of lines.entries()) {
		assert.ok(visibleWidth(line) <= width,
			`Line ${index} uses ${visibleWidth(line)} cells at width ${width}: ${JSON.stringify(line)}`);
	}
	return lines.map(stripVTControlCharacters);
}

for (const width of [83, 40, 20]) {
	test(`main view fits ${width} terminal cells with long Unicode names and paths`, async () => {
		const { screen } = await screenFixture();
		const lines = assertFits(screen, width);
		for (const heading of ["Permissions", "Toolsets", "Sandboxes", "Scope"]) {
			assert.ok(lines.some((line) => line === ` ${heading}` || line.startsWith(` ${heading} (`)), `Missing ${heading} section`);
		}
		assert.ok(lines.some((line) => line.startsWith("   > 界")));
		assert.ok(lines.some((line) => line.includes("Custom Paths")));
		assert.ok(!lines.some((line) => line.includes("/project/")));
		assert.ok(!lines.includes(" Paths"));
		// Exercise width-dependent caching during terminal resizing.
		assertFits(screen, width === 83 ? 20 : 83);
		assert.deepEqual(assertFits(screen, width), lines);
	});

	test(`patterns view fits ${width} terminal cells with long Unicode patterns and matches`, async () => {
		const { screen } = await screenFixture();
		screen.handleInput("l");
		const lines = assertFits(screen, width);
		assert.match(lines[0], /Permissions.*›/u);
		assert.ok(lines.some((line) => line.startsWith("   > ^界")));
		assert.ok(lines.some((line) => line.includes("^second_")));
		assert.ok(lines.some((line) => line.includes("^third_")));
		assertFits(screen, width === 83 ? 20 : 83);
		assert.deepEqual(assertFits(screen, width), lines);
	});

	test(`j/k/l/h navigate and edit at width ${width}`, async () => {
		const fixture = await screenFixture();
		const { screen, patterns, edits, longName } = fixture;
		const selected = () => assertFits(screen, width).find((line) => line.startsWith("   > "))!;
		assert.match(selected(), /界/u);
		screen.handleInput("j");
		assert.match(selected(), /second/);
		screen.handleInput("k");
		assert.match(selected(), /界/u);
		screen.handleInput("l");
		assert.match(selected(), /\^界/u);
		screen.handleInput("j");
		assert.match(selected(), /\^second_/);
		screen.handleInput("k");
		assert.match(selected(), /\^界/u);
		// k wraps from the first pattern to the last.
		screen.handleInput("k");
		assert.match(selected(), /\^third_/);
		screen.handleInput("l");
		await Promise.resolve();
		assert.deepEqual(edits, [{ title: `Edit a pattern for ${longName}`, value: patterns[2] }]);
		assert.equal(fixture.closed(), false);
		screen.handleInput("h");
		assert.ok(assertFits(screen, width).includes(" Toolsets"));
		assert.match(selected(), /界/u);
		assert.equal(fixture.closed(), false);
		screen.handleInput("h");
		assert.equal(fixture.closed(), true);
		assert.equal(fixture.renders(), 7);
	});
}

test("filesystem menu cycles modes and scope resets through the store", async () => {
 const fixture = await screenFixture("project");
 const { screen } = fixture;
 screen.handleInput("j"); screen.handleInput("j");
 for (const mode of ["read", "read+write", "off"]) {
  screen.handleInput(" ");
  await Promise.resolve();
  assert.equal(fixture.state().sandboxes.filesystem, mode);
  assert.match(assertFits(screen, 120).join("\n"), /Filesystem/);
  assert.ok(assertFits(screen, 120).some((line) => line.includes(`[${mode.toUpperCase()}]`)));
 }
 screen.handleInput(" "); await Promise.resolve();
 screen.handleInput("s");
 assert.equal(fixture.state().scope, "everywhere");
 assert.equal(fixture.state().sandboxes.filesystem, "off");
 screen.handleInput(" "); await Promise.resolve();
 assert.equal(fixture.state().sandboxes.filesystem, "off");
 assert.match(fixture.notifications.join("\n"), /project or custom scope/);
 assert.match(assertFits(screen, 120).join("\n"), /project or custom scope/);
});
test("Windows keeps filesystem disabled", async () => {
 const fixture = await screenFixture("project", "win32");
 const lines = assertFits(fixture.screen, 120);
 assert.ok(!lines.some((line) => line.startsWith(" Sandboxes")), "The Sandboxes section is hidden on Windows");
 fixture.screen.handleInput("j"); fixture.screen.handleInput("j"); fixture.screen.handleInput(" ");
 await Promise.resolve();
 assert.equal(fixture.state().sandboxes.filesystem, "off");
});

test("the coverage note sits under the Sandboxes title, before the rows", async () => {
 const linux = assertFits((await screenFixture("project", "linux")).screen, 120);
 const title = linux.findIndex((line) => line.startsWith(" Sandboxes"));
 assert.ok(title >= 0);
 assert.match(linux[title + 1], /Applies to all tools except unsandboxed tools/);
 assert.match(linux[title + 2], /Filesystem/);
 const mac = assertFits((await screenFixture("project", "darwin", "bash")).screen, 120);
 const macTitle = mac.findIndex((line) => line.startsWith(" Sandboxes"));
 assert.match(mac[macTitle + 1], /Applies to only bash/);
});

test("a filesystem layer at off uses the same grey mark as the other off states", async () => {
 const { screen } = await screenFixture("project", "linux");
 const lines = screen.render(120);
 const row = lines.find((line) => line.includes("Filesystem"))!;
 assert.match(row, /\x1b\[38;5;4m\[OFF\]\x1b\[39m/, "The filesystem off mark uses the muted color");
 // The network row names the allow value, so its off state reads differently.
 const network = lines.find((line) => line.includes("Network"))!;
 assert.match(network, /\[ALLOW CONNECTIONS\]/);
});

test("the exceptions list opens, shows matches, and edits like a pattern list", async () => {
	const fixture = await screenFixture("project");
	const { screen, notifications } = fixture;
	const lines = () => assertFits(screen, 120);
	// Two toolsets, then the two sandboxes, then the exceptions row.
	assert.ok(!lines().includes(" Exceptions"), "no separate Exceptions heading");
	assert.ok(lines().some((line) => line.includes("Unsandboxed tools run on the host")), "the note explains the effect");
	for (let step = 0; step < 4; step += 1) screen.handleInput("j");
	assert.ok(lines().some((line) => line.startsWith("   > Unsandboxed tools")), "the row is selectable");
	screen.handleInput("l");
	const view = lines();
	assert.ok(view.some((line) => line.includes("^exempt_tool$")), "the stored pattern is shown");
	assert.match(view.join("\n"), /\^exempt_tool\$\s+exempt_tool/, "the matched tool name is shown next to it");
	screen.handleInput("h");
	assert.ok(lines().includes(" Toolsets"));
	assert.equal(fixture.state().unsandboxed_tools.length, 1);
	assert.deepEqual(notifications, []);
});

test("an empty exception list says that every tool stays inside the sandbox", async () => {
	const fixture = await screenFixture("project");
	const { screen } = fixture;
	fixture.state().unsandboxed_tools = [];
	screen.handleInput("j");
	screen.handleInput("j");
	screen.handleInput("j");
	screen.handleInput("j");
	screen.handleInput("l");
	const lines = assertFits(screen, 120);
	assert.ok(lines.some((line) => line.includes("No exception")), "an empty list is explained");
});

for (const width of [0, 1, 10, 20, 40, 83, 160]) {
 test(`Custom Paths submenu fits width ${width} and protects the root`, async () => {
  const fixture = await screenFixture("project");
  const { screen } = fixture;
  // Toolsets, two sandboxes, the exceptions row, the mounts row, then Scope.
  for (let i = 0; i < 6; i++) screen.handleInput("j");
  screen.handleInput("j");
  screen.handleInput("l");
  const lines = screen.render(width);
  for (const line of lines) assert.ok(visibleWidth(line) <= width);
  const root = screen.render(300).find(line => line.includes("Project root"))!;
  assert.ok(root.indexOf("Project root") < root.indexOf("/project/"));
  assert.match(root, /Project root  \x1b\[38;5;5m\/project\//);
  assert.doesNotMatch(root.slice(0, root.indexOf("Project root")), /\x1b\[38;5;5m/);
  screen.handleInput("d");
  assert.match(fixture.notifications.join("\n"), /project root cannot be removed/);
  assert.equal(fixture.state().extra_paths.length, 1);
  screen.handleInput("j"); screen.handleInput("d");
  assert.equal(fixture.state().extra_paths.length, 0);
  screen.handleInput("d");
  assert.equal(fixture.state().extra_paths.length, 0);
  screen.handleInput("h");
  assert.ok(screen.render(120).some(line => line.includes("Modality")));
 });
}

test("scope UI cycles all modes without reactivating or deleting saved paths", async () => {
 const f = await screenFixture("project");
 const saved = [...f.state().extra_paths];
 for (const [scope, label] of [["everywhere", "EVERYWHERE"], ["custom", "CUSTOM PATHS"], ["project", "PROJECT ONLY"]]) {
  f.screen.handleInput("s");
  assert.equal(f.state().scope, scope);
  assert.deepEqual(f.state().extra_paths, saved);
  assert.match(f.screen.render(160).join("\n"), new RegExp(`\\[${label}\\]`));
 }
 const lines = f.screen.render(160).map(stripVTControlCharacters);
 const heading = lines.indexOf(" Scope");
 assert.equal(lines[heading + 1], "     Scope defines the paths exposed to the read and write toolsets and to the sandboxed tools.");
 assert.ok(lines.includes("     Unsandboxed tools run on the host even while a layer is on."));
 assert.equal(lines.filter(line => line.startsWith(" Sandboxes")).length, 1);
 assert.ok(lines.findIndex(line => line.includes("Unsandboxed tools") && !line.includes("run on")) < heading);
});


test("adding a path asks before activating inactive saved extras", async () => {
 const { fixtureTmpdir: tmpdir } = await import("../tests/helpers/temp.ts");
 const { canonicalPath } = await import("./scope.ts");
 const f = await screenFixture("project");
 const saved = [...f.state().extra_paths];
 f.inputs.push(tmpdir()); f.screen.handleInput("a");
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(f.state().scope, "project");
 assert.deepEqual(f.state().extra_paths, saved);
 assert.match(f.confirmations[0], /all saved extra paths become allowed/);
 f.setConsent(true);
 f.inputs.push(tmpdir()); f.screen.handleInput("a");
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(f.state().scope, "custom");
 assert.deepEqual(f.state().extra_paths, [...saved, canonicalPath(tmpdir())]);
 f.inputs.push(tmpdir()); f.screen.handleInput("a");
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(f.state().extra_paths.length, 2);
});

test("the mounts submenu adds, toggles, deletes, and refuses a protected path", async () => {
 const f = await screenFixture("project");
 const lines = () => assertFits(f.screen, 120);
 // Toolsets, two sandboxes, exceptions, then the mounts row.
 for (let step = 0; step < 5; step += 1) f.screen.handleInput("j");
 f.screen.handleInput("l");
 assert.ok(lines().some((line) => line.includes("Custom mounts")));
 assert.ok(lines().some((line) => line.includes("No mount")));
 f.inputs.push("/tmp"); f.screen.handleInput("a");
 await new Promise((resolve) => setImmediate(resolve));
 assert.equal(f.state().sandbox_mounts.length, 1);
 assert.equal(f.state().sandbox_mounts[0].writable, false);
 assert.ok(lines().some((line) => line.includes("[READ ONLY]")));
 f.screen.handleInput("w");
 assert.equal(f.state().sandbox_mounts[0].writable, true);
 assert.ok(lines().some((line) => line.includes("[READ+WRITE]")));
 f.inputs.push("/run"); f.screen.handleInput("a");
 await new Promise((resolve) => setImmediate(resolve));
 assert.equal(f.state().sandbox_mounts.length, 1, "a protected path is refused");
 assert.match(f.notifications.join("\n"), /belongs to the sandbox/);
 f.screen.handleInput("d");
 assert.equal(f.state().sandbox_mounts.length, 0);
 f.screen.handleInput("h");
 assert.ok(lines().some((line) => line.includes("Modality")));
});

test("the mounts submenu fits narrow widths", async () => {
 for (const width of [20, 40, 83]) {
  const f = await screenFixture("project");
  for (let step = 0; step < 5; step += 1) f.screen.handleInput("j");
  f.screen.handleInput("l");
  for (const line of f.screen.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
 }
});

test("the defaults row asks and saves the template", async () => {
 const f = await screenFixture("project");
 f.setConsent(true);
 const lines = f.screen.render(160).map(stripVTControlCharacters);
 assert.ok(lines.some((line) => line.includes("Make these settings default")));
 assert.ok(lines.some((line) => line.includes("Defaults")), "the row has its own section");
 assert.ok(lines.some((line) => line.includes("New sessions start from")));
 // Walk to the last row: five toolsets, two sandboxes, exceptions, mounts, scope, paths, defaults.
 for (let step = 0; step < 8; step += 1) f.screen.handleInput("j");
 f.screen.handleInput("l");
 await new Promise((resolve) => setImmediate(resolve));
 assert.ok(f.confirmations.some((text) => /Make these settings the default|template is/.test(text)), "the row asks first");
 assert.match(f.notifications.join("\n"), /A new session starts from these settings/);
 assert.equal(f.savedDefaults().length, 1, "the template is written once");
 assert.deepEqual(f.savedDefaults()[0], JSON.stringify(f.state()), "the template holds the session state");
});

test("adding a whole private tree is refused with a reason", async () => {
 const f = await screenFixture("project");
 const saved = [...f.state().extra_paths];
 for (const path of ["/run", "/etc"]) {
  f.inputs.push(path); f.screen.handleInput("a");
  await new Promise(resolve => setImmediate(resolve));
 }
 assert.deepEqual(f.state().extra_paths, saved);
 assert.match(f.notifications.join("\n"), /belongs to the sandbox itself/);
});
