/**
 * On-disk layout of a charter and every read/write against it.
 *
 * ```text
 * <directory>/<id>/
 *   brief.md  spec.md  [design.md]  [attachments/**]
 *   charter.json        workflow state
 *   journal.jsonl       append-only event log
 *   report.md           generated summary (after completion)
 *   reports/            impl-N.json  gate-N.json  audit-N.json  refine-N.json
 *   approved/<rev>/     exact copies of the documents at each approval
 * ```
 */

import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { acquireLock, isNodeError, type LockHandle, pathExists, readJson, readTextIfExists, writeJsonAtomic, writeTextAtomic } from "./fsx.ts";
import type { Report } from "./reports.ts";
import { type CharterState, newState, parseState } from "./state.ts";
import { CharterError } from "./types.ts";

export const DOCUMENT_NAMES = ["brief.md", "spec.md", "design.md"] as const;
const ATTACHMENTS = "attachments";
const ID_PATTERN = /^\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isCharterId(value: string): boolean {
	return ID_PATTERN.test(value);
}

/** Lower-case ASCII slug of at most six words. */
export function slugify(title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.split("-")
		.filter(Boolean)
		.slice(0, 6)
		.join("-")
		.slice(0, 48)
		.replace(/-+$/, "");
	return slug === "" ? "charter" : slug;
}

export interface CharterSummary {
	id: string;
	title: string;
	stage: string;
	updatedAt: string;
}

export interface JournalEvent {
	at: string;
	event: string;
	[key: string]: unknown;
}

export class Charter {
	readonly id: string;
	readonly dir: string;

	constructor(root: string, id: string) {
		this.id = id;
		this.dir = join(root, id);
	}

	get statePath(): string {
		return join(this.dir, "charter.json");
	}
	get journalPath(): string {
		return join(this.dir, "journal.jsonl");
	}
	get summaryPath(): string {
		return join(this.dir, "report.md");
	}
	get lockPath(): string {
		return join(this.dir, ".lock");
	}
	document(name: string): string {
		return join(this.dir, name);
	}
	reportPath(name: string): string {
		return join(this.dir, "reports", `${name}.json`);
	}
	/** Results of the auditors that finished in an audit attempt that failed as a whole. */
	partialAuditPath(name: string): string {
		return join(this.dir, "reports", `${name}.partial.json`);
	}
	approvedDir(revision: number): string {
		return join(this.dir, "approved", String(revision));
	}

	async load(): Promise<CharterState> {
		if (!(await pathExists(this.statePath))) throw new CharterError(`Charter "${this.id}" does not exist (${this.statePath} not found).`);
		const state = parseState(await readJson(this.statePath), this.statePath);
		if (state.id !== this.id) throw new CharterError(`${this.statePath} belongs to charter "${state.id}", not "${this.id}".`);
		return state;
	}

	async save(state: CharterState, at: string): Promise<void> {
		state.updatedAt = at;
		await writeJsonAtomic(this.statePath, state);
	}

	async journal(event: string, data: Record<string, unknown> = {}, at = new Date().toISOString()): Promise<void> {
		const entry: JournalEvent = { at, event, ...data };
		await mkdir(this.dir, { recursive: true });
		await appendFile(this.journalPath, `${JSON.stringify(entry)}\n`, "utf8");
	}

	async readJournal(limit?: number): Promise<JournalEvent[]> {
		const text = (await readTextIfExists(this.journalPath)) ?? "";
		const events: JournalEvent[] = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			try {
				events.push(JSON.parse(line) as JournalEvent);
			} catch {
				// A torn final line after a crash is not worth failing over.
			}
		}
		return limit === undefined ? events : events.slice(-limit);
	}

	async writeReport(report: Report): Promise<void> {
		await writeJsonAtomic(this.reportPath(report.name), report);
	}

	async readReport<T extends Report>(name: string, kind: T["kind"]): Promise<T> {
		const path = this.reportPath(name);
		if (!(await pathExists(path))) throw new CharterError(`Report ${name} is missing (${path}).`);
		const report = (await readJson(path)) as Report;
		if (report.kind !== kind) throw new CharterError(`Report ${name} is a ${report.kind} report, expected ${kind}.`);
		return report as T;
	}

	/** Relative paths of every document that forms the contract, sorted. */
	async documentFiles(): Promise<string[]> {
		const files: string[] = [];
		for (const name of DOCUMENT_NAMES) {
			if (await pathExists(this.document(name))) files.push(name);
		}
		const walk = async (relativeDir: string): Promise<void> => {
			let entries: import("node:fs").Dirent[];
			try {
				entries = await readdir(join(this.dir, relativeDir), { withFileTypes: true });
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") return;
				throw error;
			}
			for (const entry of entries) {
				const path = `${relativeDir}/${entry.name}`;
				if (entry.isDirectory()) await walk(path);
				else if (entry.isFile()) files.push(path);
			}
		};
		await walk(ATTACHMENTS);
		return files.sort();
	}

	/** SHA-256 of every contract document, keyed by relative path. */
	async hashDocuments(): Promise<Record<string, string>> {
		const files = await this.documentFiles();
		const digests = await Promise.all(
			files.map(async (file) => createHash("sha256").update(await readFile(join(this.dir, file))).digest("hex")),
		);
		return Object.fromEntries(files.map((file, index) => [file, digests[index] ?? ""]));
	}

	/** Keep an exact copy of the approved documents so tampering can be undone and revisions compared. */
	async archiveApproved(revision: number, files: readonly string[]): Promise<void> {
		const target = this.approvedDir(revision);
		await rm(target, { recursive: true, force: true });
		for (const file of files) {
			await mkdir(dirname(join(target, file)), { recursive: true });
			await copyFile(join(this.dir, file), join(target, file));
		}
	}

	/**
	 * Compare the documents with an approval. Returns the relative paths that
	 * were changed, added or removed since.
	 */
	async documentDrift(approved: Record<string, string>): Promise<string[]> {
		const current = await this.hashDocuments();
		const names = new Set([...Object.keys(approved), ...Object.keys(current)]);
		return [...names].filter((name) => approved[name] !== current[name]).sort();
	}

	/** Put the documents back exactly as approved. */
	async restoreApproved(revision: number, approved: Record<string, string>): Promise<void> {
		const source = this.approvedDir(revision);
		const current = await this.documentFiles();
		for (const file of current) {
			if (!(file in approved)) await rm(join(this.dir, file), { force: true });
		}
		for (const file of Object.keys(approved)) {
			await mkdir(dirname(join(this.dir, file)), { recursive: true });
			await copyFile(join(source, file), join(this.dir, file));
		}
	}

	lock(): Promise<LockHandle> {
		return acquireLock(this.lockPath, `charter "${this.id}"`);
	}
}

export class CharterStore {
	/** Absolute directory that holds every charter. */
	readonly root: string;
	readonly projectRoot: string;
	/** `root` relative to the project, `/`-separated. */
	readonly relativeRoot: string;

	constructor(projectRoot: string, directory: string) {
		this.projectRoot = resolve(projectRoot);
		this.relativeRoot = directory;
		this.root = resolve(this.projectRoot, directory);
	}

	charter(id: string): Charter {
		if (!isCharterId(id)) throw new CharterError(`"${id}" is not a charter id (expected something like 003-csv-export).`);
		return new Charter(this.root, id);
	}

	async list(): Promise<CharterSummary[]> {
		let entries: string[];
		try {
			entries = await readdir(this.root);
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return [];
			throw error;
		}
		const summaries = await Promise.all(
			entries.filter(isCharterId).map(async (id): Promise<CharterSummary | undefined> => {
				try {
					const state = await this.charter(id).load();
					return { id, title: state.title, stage: state.stage, updatedAt: state.updatedAt };
				} catch {
					return undefined;
				}
			}),
		);
		return summaries.filter((summary): summary is CharterSummary => summary !== undefined).sort((a, b) => (a.id < b.id ? -1 : 1));
	}

	/** Create the next numbered charter with its document templates. */
	async create(title: string, templates: { brief: string; spec: string }, at: string): Promise<{ charter: Charter; state: CharterState }> {
		const cleanTitle = title.replace(/\s+/g, " ").trim();
		if (cleanTitle === "") throw new CharterError("A charter needs a title.");
		await mkdir(this.root, { recursive: true });
		const taken = (await readdir(this.root)).filter(isCharterId).map((id) => Number.parseInt(id, 10));
		let number = taken.length === 0 ? 1 : Math.max(...taken) + 1;
		const slug = slugify(cleanTitle);

		// mkdir without `recursive` is the atomic claim on the number.
		for (;;) {
			const id = `${String(number).padStart(3, "0")}-${slug}`;
			const charter = new Charter(this.root, id);
			try {
				await mkdir(charter.dir);
			} catch (error) {
				if (isNodeError(error) && error.code === "EEXIST") {
					number++;
					continue;
				}
				throw error;
			}
			const state = newState(id, cleanTitle, at);
			const fill = (template: string): string => template.replaceAll("{{title}}", cleanTitle).replaceAll("{{id}}", id);
			await Promise.all([
				writeTextAtomic(charter.document("brief.md"), fill(templates.brief)),
				writeTextAtomic(charter.document("spec.md"), fill(templates.spec)),
				charter.save(state, at),
			]);
			await charter.journal("created", { title: cleanTitle }, at);
			return { charter, state };
		}
	}
}
