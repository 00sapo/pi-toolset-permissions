export const approvalChoices = (names: string[]): string[] => [
	"Allow once",
	"Deny",
	"Deny with explanation",
	`Allow and enable ${names.length === 1 ? "toolset" : "toolsets"} ${names.map(plain).join(", ")}`,
];

interface Theme {
	bold(text: string): string;
	fg(color: string, text: string): string;
}

export interface ApprovalDetails {
	tool: string;
	input: Record<string, unknown>;
	reason: string;
	names: string[];
}

// Count terminal cells rather than source lines, including wide Unicode characters.
function cells(char: string): number {
	if (/\p{Mark}/u.test(char)) return 0;
	const code = char.codePointAt(0)!;
	return code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f || code >= 0xff00 && code <= 0xff60 || code >= 0x1f300) ? 2 : 1;
}

export function plain(value: string): string {
	return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "    ");
}

export function wrap(value: string, width: number): string[] {
	const result: string[] = [];
	for (const line of plain(value).split("\n")) {
		let text = "";
		let size = 0;
		for (const char of line) {
			const count = cells(char);
			if (size + count > Math.max(1, width) && text) {
				result.push(text);
				text = "";
				size = 0;
			}
			text += char;
			size += count;
		}
		result.push(text);
	}
	return result;
}

export function inputPreview(tool: string, input: Record<string, unknown>, width: number): string[] {
	const text = tool === "bash" && typeof input.command === "string"
		? input.command : JSON.stringify(input, null, 2);
	const lines = wrap(text, width);
	return lines.length > 4 ? ["[...]"] : lines;
}

// Small Bash lexer: quote, variable, comment, and operator colors, without bold text.
function bashHighlight(line: string, theme: Theme): string {
	return line.replace(/('[^']*'|"(?:\\.|[^"\\])*"|\$\{[^}]*\}|\$[\w?]+|#[^\n]*|&&|\|\||[|;<>])/g, (token) =>
		theme.fg(token.startsWith("#") ? "dim" : token.startsWith("$") ? "accent" : /^["']/.test(token) ? "success" : "warning", token));
}

export function approvalLines(details: ApprovalDetails, width: number, theme: Theme): string[] {
	const field = (label: string, value: string): string[] => [theme.bold(`${label}:`), ...wrap(value, width)];
	const preview = inputPreview(details.tool, details.input, width);
	return [
		"Allow this call?", "",
		...field("Toolset", details.names.join(", ") + " (ask)"), "",
		...field("Action", details.tool), "",
		theme.bold(details.tool === "bash" ? "Command:" : "Input:"),
		...preview.map((line) => details.tool === "bash" && line !== "[...]" ? bashHighlight(line, theme) : line),
		...(details.tool === "bash" && Object.keys(details.input).some((key) => key !== "command")
			? ["", theme.bold("Other arguments:"), ...inputPreview("arguments", Object.fromEntries(Object.entries(details.input).filter(([key]) => key !== "command")), width)] : []),
		"", ...field("Reason", details.reason), "",
	];
}

function jsonHighlight(line: string, theme: Theme): string {
	return line.replace(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?\b)/g,
		(token) => theme.fg(token.endsWith(":") ? "accent" : token.startsWith(String.fromCharCode(34)) ? "success" : "warning", token));
}

function contentHighlight(line: string, path: string, theme: Theme): string {
	if (/\.(?:sh|bash|zsh)$/.test(path)) return bashHighlight(line, theme);
	if (/\.jsonc?$/.test(path)) return jsonHighlight(line, theme);
	return line.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*|#.*|\b(?:const|let|var|function|return|if|else|class|def|import|from|true|false|null|None)\b|\b\d+\b)/g,
		(token) => theme.fg(/^(?:\/\/|#)/.test(token) ? "dim" : token.startsWith(String.fromCharCode(34)) ? "success" : "accent", token));
}

/** Full input, with no preview truncation and no approval controls. */
export function fullInputLines(details: ApprovalDetails, width: number, theme: Theme): string[] {
	const json = (value: unknown) => wrap(JSON.stringify(value, null, 2) ?? "null", width).map((line) => jsonHighlight(line, theme));
	if (details.tool === "bash" && typeof details.input.command === "string") {
		const other = Object.fromEntries(Object.entries(details.input).filter(([key]) => key !== "command"));
		return [theme.bold("Command:"), ...wrap(details.input.command, width).map((line) => bashHighlight(line, theme)),
			...(Object.keys(other).length ? [theme.bold("Other arguments:"), ...json(other)] : [])];
	}
	if (details.tool === "edit") {
		const path = String(details.input.path ?? details.input.file_path ?? "");
		const fields = (value: unknown, label: string): string[] => {
			if (Array.isArray(value) && value.length) return value.flatMap((entry, index) => fields(entry, `${label}[${index}]`));
			if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
				return Object.entries(value).flatMap(([key, entry]) => fields(entry, label ? `${label}.${key}` : key));
			}
			return [theme.bold(`${plain(label)}:`), ...(typeof value === "string"
				? wrap(value, width).map((line) => contentHighlight(line, path, theme)) : json(value))];
		};
		return fields(details.input, "");
	}
	return [theme.bold("Input:"), ...json(details.input)];
}
