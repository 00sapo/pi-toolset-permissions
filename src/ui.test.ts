import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StateStore } from "./state.ts";
import type { PermissionsState } from "./types.ts";

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

async function screenFixture() {
	const longName = "界🧪e\u0301".repeat(24);
	const patterns = ["^界🧪e\u0301" + "長".repeat(80), "^second_", "^third_"];
	let state: PermissionsState = {
		version: 2,
		scope: "everywhere",
		extra_paths: ["/extra/" + "資料🧪e\u0301/".repeat(30)],
		toolsets: [
			{ name: longName, patterns, enabled: "ask", builtin: false },
			{ name: "second", patterns: ["^second_"], enabled: true, builtin: true },
		],
		sandboxes: { readonly_bash: true, no_network: false },
	};
	const edits: Array<{ title: string; value: string }> = [];
	let screen!: Screen;
	let renders = 0;
	let closed = false;
	const store = {
		get: () => state,
		update: (change: (current: PermissionsState) => PermissionsState) => { state = change(state); },
	} as StateStore;
	const ctx = {
		mode: "tui",
		cwd: "/project/" + "研究🧪e\u0301/".repeat(30),
		ui: {
			notify: () => assert.fail("Unexpected notification"),
			editor: async (title: string, value: string) => {
				edits.push({ title, value });
				return undefined;
			},
			custom: async (factory: Function) => {
				screen = factory(
					{ requestRender: () => { renders += 1; } },
					{
						fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
						bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
					},
					{ matches: () => false },
					() => { closed = true; },
				);
			},
		},
	} as unknown as ExtensionContext;
	await openPermissions(store, ctx, ["界🧪e\u0301" + "長".repeat(90), "second_" + longName]);
	return { screen, patterns, longName, edits, renders: () => renders, closed: () => closed };
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
		for (const heading of ["Permissions", "Toolsets", "Sandboxes", "Scope", "Paths"]) {
			assert.ok(lines.some((line) => line === ` ${heading}` || line.startsWith(` ${heading} (`)), `Missing ${heading} section`);
		}
		assert.ok(lines.some((line) => line.startsWith("   > 界")));
		assert.ok(lines.some((line) => line.includes("/project/")));
		assert.ok(lines.some((line) => line.includes("/extra/")));
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
