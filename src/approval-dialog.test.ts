import assert from "node:assert/strict";
import test from "node:test";
import { approvalChoices, approvalLines, inputPreview, plain, wrap } from "./approval-dialog.ts";

function fakeTheme() {
	const bold: string[] = [];
	const colors: Array<{ color: string; text: string }> = [];
	return {
		bold, colors,
		theme: {
			bold(text: string) { bold.push(text); return `<bold>${text}</bold>`; },
			fg(color: string, text: string) { colors.push({ color, text }); return `<${color}>${text}</${color}>`; },
		},
	};
}

const details = { tool: "read", input: { path: "README.md" }, reason: "Read the project instructions.", names: ["project-read"] };

test("only field labels use bold and the explicit toolset name stays visible", () => {
	const { theme, bold } = fakeTheme();
	const lines = approvalLines(details, 100, theme);
	assert.deepEqual(bold, ["Toolset:", "Action:", "Input:", "Reason:"]);
	assert.ok(lines.includes("project-read (ask)"));
	assert.ok(lines.includes("read"));
	assert.ok(lines.includes(details.reason));
	assert.ok(lines.includes('  "path": "README.md"'));
	assert.equal(lines.filter((line) => line.includes("<bold>")).length, bold.length);
});

test("enable choices name one toolset or all overlapping toolsets", () => {
	assert.deepEqual(approvalChoices(["read"]), ["Allow once", "Deny", "Deny with explanation", "Allow and enable toolset read"]);
	assert.equal(approvalChoices(["read", "overlap"])[3], "Allow and enable toolsets read, overlap");
});

test("short Bash command appears directly with colors but no bold values", () => {
	const { theme, bold, colors } = fakeTheme();
	const command = `echo 'hello' "$USER" $HOME && cat file | head > out # note`;
	const lines = approvalLines({ ...details, tool: "bash", input: { command, timeout: 10 } }, 120, theme);
	assert.deepEqual(bold, ["Toolset:", "Action:", "Command:", "Other arguments:", "Reason:"]);
	assert.deepEqual(colors, [
		{ color: "success", text: "'hello'" },
		{ color: "success", text: '"$USER"' },
		{ color: "accent", text: "$HOME" },
		{ color: "warning", text: "&&" },
		{ color: "warning", text: "|" },
		{ color: "warning", text: ">" },
		{ color: "dim", text: "# note" },
	]);
	const preview = lines[lines.indexOf("<bold>Command:</bold>") + 1];
	assert.equal(preview.replace(/<\/?\w+>/g, ""), command);
	assert.ok(!preview.includes("<bold>"));
	assert.ok(lines.includes('  "timeout": 10'));
	assert.deepEqual(inputPreview("bash", { command: "pwd" }, 20), ["pwd"]);
});

test("four terminal rows remain visible and five rows use the placeholder", () => {
	assert.deepEqual(inputPreview("bash", { command: "a\nb\nc\nd" }, 80), ["a", "b", "c", "d"]);
	assert.deepEqual(inputPreview("bash", { command: "a\nb\nc\nd\ne" }, 80), ["[...]"]);
	assert.deepEqual(inputPreview("read", { path: "file", offset: 1, limit: 2 }, 80), ["[...]"]);
});

test("long other arguments use the same four-row limit without hiding a short command", () => {
	const { theme, bold } = fakeTheme();
	const lines = approvalLines({ ...details, tool: "bash", input: { command: "pwd", timeout: 10, cwd: "/tmp", extra: true } }, 80, theme);
	assert.equal(lines[lines.indexOf("<bold>Command:</bold>") + 1], "pwd");
	assert.equal(lines[lines.indexOf("<bold>Other arguments:</bold>") + 1], "[...]");
	assert.deepEqual(bold, ["Toolset:", "Action:", "Command:", "Other arguments:", "Reason:"]);
});

test("wrapped commands use terminal rows rather than source lines", () => {
	assert.deepEqual(inputPreview("bash", { command: "abcdefghijklmnop" }, 4), ["abcd", "efgh", "ijkl", "mnop"]);
	assert.deepEqual(inputPreview("bash", { command: "abcdefghijklmnopq" }, 4), ["[...]"]);
	const { theme, colors } = fakeTheme();
	const lines = approvalLines({ ...details, tool: "bash", input: { command: "x".repeat(41) } }, 10, theme);
	assert.ok(lines.includes("[...]"));
	assert.deepEqual(colors, []);
});

test("Unicode wrapping counts wide characters and preserves combining marks", () => {
	assert.deepEqual(wrap("界界界", 4), ["界界", "界"]);
	assert.deepEqual(wrap("😀😀😀", 4), ["😀😀", "😀"]);
	assert.deepEqual(wrap("e\u0301e\u0301e\u0301", 2), ["e\u0301e\u0301", "e\u0301"]);
	assert.deepEqual(inputPreview("bash", { command: "界".repeat(9) }, 4), ["[...]"]);
	assert.deepEqual(wrap("abc", 0), ["a", "b", "c"]);
});

test("control characters are stripped while newlines and expanded tabs remain", () => {
	assert.equal(plain("a\x00\x07\x08\x0b\x0c\x0d\x1b\x1f\x7f\x85\x9fb\tend\nnext"), "ab    end\nnext");
	assert.deepEqual(inputPreview("bash", { command: "echo\x07 hi\tthere\nnext\x1b" }, 80), ["echo hi    there", "next"]);
	const { theme } = fakeTheme();
	const lines = approvalLines({ ...details, names: ["read\x07"], reason: "why\x00", tool: "bash", input: { command: "pwd\x1b" } }, 80, theme);
	assert.ok(lines.includes("read (ask)"));
	assert.ok(lines.includes("why"));
	assert.ok(lines.includes("pwd"));
	assert.doesNotMatch(lines.join("\n"), /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
});

test("full input colors read JSON, Bash arguments, and edit contents without bold values", async () => {
	const { fullInputLines } = await import("./approval-dialog.ts");
	for (const [tool, input, expected] of [
		["read", { path: "file.json", offset: 12 }, ["path", "file.json", "12"]],
		["bash", { command: "echo \"hello\" $HOME", timeout: 12, extra: { value: true } }, ["hello", "$HOME", "timeout", "true"]],
		["edit", { path: "file.json", edits: [{ oldText: "{\"a\": 1}", newText: "{\"a\": 2}" }], extra: [] }, ["a", "1", "2"]],
		["edit", { path: "file.ts", oldText: "const a = 1", newText: "return 2" }, ["const", "return"]],
	] as const) {
		const { theme, bold, colors } = fakeTheme();
		const lines = fullInputLines({ ...details, tool, input }, 120, theme);
		for (const token of expected) assert.ok(colors.some((entry) => entry.text.includes(token)), token);
		assert.ok(bold.every((label) => label.endsWith(":")));
		assert.ok(!lines.includes("[...]"));
		if (tool === "edit" && "extra" in input) assert.ok(lines.includes("[]"));
	}
});
