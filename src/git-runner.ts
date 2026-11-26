/** Direct argv execution for the packaged git/forge client tool. No command shell. */
export interface GitInput {
	program?: "git" | "gh" | "tea";
	args: string[];
	cwd?: string;
	timeout?: number;
}
interface CliResult { stdout: string; stderr: string; code: number; killed: boolean; truncated?: boolean }
type Exec = (program: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeout: number; maxBuffer: number }) => Promise<CliResult>;

export async function runGit(exec: Exec, input: GitInput, defaultCwd: string, signal?: AbortSignal): Promise<CliResult> {
	const program = input.program === undefined ? "git" : input.program;
	if (!["git", "gh", "tea"].includes(program)) throw new Error("Select git, gh, or tea.");
	if (!Array.isArray(input.args) || !input.args.every(arg => typeof arg === "string" && !arg.includes("\0"))) {
		throw new Error("Supply arguments as an array of strings without null bytes.");
	}
	if (input.cwd !== undefined && (typeof input.cwd !== "string" || !input.cwd || input.cwd.includes("\0"))) {
		throw new Error("Supply a nonempty working directory without null bytes.");
	}
	const timeout = input.timeout === undefined ? 60 : input.timeout;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) throw new Error("Set timeout to an integer from 1 to 600 seconds.");
	return exec(program, input.args, { cwd: input.cwd ?? defaultCwd, signal, timeout: timeout * 1000, maxBuffer: 1024 * 1024 });
}
