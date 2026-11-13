/**
 * Small filesystem helpers: atomic JSON writes, tolerant reads, and an
 * advisory lock so two Pi sessions cannot drive the same charter at once.
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { CharterError } from "./types.ts";

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
		throw error;
	}
}

/** Read a UTF-8 file, or `undefined` when it does not exist. */
export async function readTextIfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
		throw error;
	}
}

export async function readJson(path: string): Promise<unknown> {
	const text = await readFile(path, "utf8");
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new CharterError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function readJsonIfExists(path: string): Promise<unknown | undefined> {
	const text = await readTextIfExists(path);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new CharterError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Write through a temporary sibling and rename, so a reader (or a crash) never
 * sees a half-written file.
 */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(temporary, text, "utf8");
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await writeTextAtomic(path, `${JSON.stringify(value, null, "\t")}\n`);
}

/** True when `child` is `parent` or lies below it. Both must be absolute. */
export function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolve a model-supplied path the way Pi's file tools do (leading `@` is decoration). */
export function resolveToolPath(cwd: string, path: string): string {
	return resolve(cwd, path.startsWith("@") ? path.slice(1) : path);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error) && error.code === "EPERM";
	}
}

export interface LockHandle {
	release(): Promise<void>;
}

/**
 * Take an exclusive advisory lock. A lock left behind by a dead process is
 * reclaimed; a lock held by a live one fails fast with a clear message.
 */
export async function acquireLock(path: string, description: string): Promise<LockHandle> {
	await mkdir(dirname(path), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(path, "wx");
			await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
			await handle.close();
			let released = false;
			return {
				async release() {
					if (released) return;
					released = true;
					await rm(path, { force: true });
				},
			};
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") throw error;
			let holder: number | undefined;
			try {
				const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
				if (typeof parsed === "object" && parsed !== null && "pid" in parsed && typeof parsed.pid === "number") {
					holder = parsed.pid;
				}
			} catch {
				// Unreadable lock: treat as stale below.
			}
			if (holder !== undefined && holder !== process.pid && processAlive(holder)) {
				throw new CharterError(
					`${description} is in use by another Pi process (pid ${holder}). Wait for it to finish or stop it first.`,
				);
			}
			await rm(path, { force: true });
		}
	}
	throw new CharterError(`Could not lock ${description}.`);
}
