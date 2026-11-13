/**
 * Runs the project's own checks (tests, linters, type checks) as plain
 * processes. Results are facts, not an agent's claim, and cost no tokens.
 */

import { spawn } from "node:child_process";

import type { CheckConfig } from "./config.ts";
import type { CheckOutcome } from "./reports.ts";

const OUTPUT_LIMIT = 6000;

/** Keeps only the last `limit` characters of a stream without unbounded growth. */
class Tail {
	private chunks: string[] = [];
	private size = 0;
	private dropped = false;
	private readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	push(text: string): void {
		this.chunks.push(text);
		this.size += text.length;
		while (this.chunks.length > 1 && this.size - (this.chunks[0]?.length ?? 0) >= this.limit) {
			this.size -= this.chunks.shift()?.length ?? 0;
			this.dropped = true;
		}
	}

	toString(): string {
		let text = this.chunks.join("");
		if (text.length > this.limit) {
			text = text.slice(text.length - this.limit);
			this.dropped = true;
		}
		// Start on a line boundary when the head was cut.
		if (this.dropped) {
			const newline = text.indexOf("\n");
			text = `[... earlier output omitted ...]\n${newline >= 0 && newline < 400 ? text.slice(newline + 1) : text}`;
		}
		return text.trimEnd();
	}
}

function killTree(pid: number, signal: NodeJS.Signals): void {
	try {
		// Negative pid addresses the whole process group on POSIX.
		if (process.platform !== "win32") process.kill(-pid, signal);
		else process.kill(pid, signal);
	} catch {
		// Already gone.
	}
}

export function runCheck(check: CheckConfig, cwd: string, signal?: AbortSignal): Promise<CheckOutcome> {
	return new Promise((resolve) => {
		const started = performance.now();
		const tail = new Tail(OUTPUT_LIMIT);
		let timedOut = false;
		let settled = false;

		const finish = (exitCode: number | null, note?: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(hardKill);
			signal?.removeEventListener("abort", onAbort);
			if (note) tail.push(`\n${note}`);
			resolve({
				name: check.name,
				command: check.run,
				passed: exitCode === 0 && !timedOut,
				exitCode,
				timedOut,
				durationMs: Math.round(performance.now() - started),
				output: tail.toString(),
			});
		};

		if (signal?.aborted) {
			resolve({ name: check.name, command: check.run, passed: false, exitCode: null, timedOut: false, durationMs: 0, output: "cancelled before start" });
			return;
		}

		const child = spawn(check.run, {
			cwd,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => tail.push(chunk));
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => tail.push(chunk));

		let hardKill: NodeJS.Timeout | undefined;
		const stop = (): void => {
			if (child.pid === undefined) return;
			killTree(child.pid, "SIGTERM");
			hardKill = setTimeout(() => child.pid !== undefined && killTree(child.pid, "SIGKILL"), 2000);
			hardKill.unref();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, check.timeoutSeconds * 1000);
		const onAbort = (): void => stop();
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (error) => finish(null, `could not start: ${error.message}`));
		child.on("close", (code) => finish(code, timedOut ? `timed out after ${check.timeoutSeconds}s` : signal?.aborted ? "cancelled" : undefined));
	});
}

/**
 * Run every check in order. All of them run even after a failure, so one
 * repair pass can address everything that is wrong.
 */
export async function runChecks(
	checks: readonly CheckConfig[],
	cwd: string,
	options: { signal?: AbortSignal; onStart?: (check: CheckConfig, index: number) => void } = {},
): Promise<CheckOutcome[]> {
	const outcomes: CheckOutcome[] = [];
	for (let index = 0; index < checks.length; index++) {
		const check = checks[index];
		if (!check) continue;
		if (options.signal?.aborted) break;
		options.onStart?.(check, index);
		outcomes.push(await runCheck(check, cwd, options.signal));
	}
	return outcomes;
}
