/**
 * Configuration: defaults, validation with path-precise messages, and layered
 * loading (built-in defaults <- user-wide file <- project file).
 */

import { isAbsolute, join, normalize, sep } from "node:path";

import { readJsonIfExists, writeJsonAtomic } from "./fsx.ts";
import { CharterError, isRecord, ROLES, type Role, THINKING_LEVELS, type ThinkingLevel } from "./types.ts";

export const CONFIG_VERSION = 1;
export const CONFIG_FILE_NAME = "charter.json";

export interface RoleConfig {
	enabled: boolean;
	/** `provider/model-id`, or `null` to inherit the model of the main session. */
	model: string | null;
	thinking: ThinkingLevel;
	/** Wall-clock budget for one run. `0` disables the limit. */
	timeoutMinutes: number;
}

export interface AuditorConfig extends RoleConfig {
	/** Upper bound of auditor sessions that check disjoint criteria concurrently. */
	shards: number;
}

export interface CheckConfig {
	name: string;
	/** Shell command, run from the project root. */
	run: string;
	timeoutSeconds: number;
}

export interface CharterConfig {
	version: typeof CONFIG_VERSION;
	/** Directory (relative to the project root) that holds every charter. */
	directory: string;
	roles: {
		implementer: RoleConfig;
		auditor: AuditorConfig;
		refiner: RoleConfig;
	};
	/** Deterministic project checks run by code after implementation and refinement. */
	checks: CheckConfig[];
	limits: {
		/** Implementation cycles allowed per approval before the developer must extend the budget. */
		cycles: number;
		/** Automatic implementer repair attempts after a failing check, per cycle. */
		gateRetries: number;
		/** Reminders sent to an agent that stopped without filing its report. */
		reportNudges: number;
	};
	git: {
		/** Snapshot the work tree before each run (never touches HEAD, the index, or the stash). */
		checkpoints: boolean;
	};
}

const DEFAULTS: CharterConfig = {
	version: CONFIG_VERSION,
	directory: ".charter",
	roles: {
		implementer: { enabled: true, model: null, thinking: "high", timeoutMinutes: 60 },
		auditor: { enabled: true, model: null, thinking: "medium", timeoutMinutes: 30, shards: 1 },
		refiner: { enabled: false, model: null, thinking: "medium", timeoutMinutes: 30 },
	},
	checks: [],
	limits: { cycles: 3, gateRetries: 2, reportNudges: 1 },
	git: { checkpoints: true },
};

export const DEFAULT_CONFIG: Readonly<CharterConfig> = Object.freeze(DEFAULTS);

export function cloneConfig(config: CharterConfig): CharterConfig {
	return structuredClone(config) as CharterConfig;
}

class Collector {
	readonly problems: string[] = [];
	add(path: string, message: string): void {
		this.problems.push(`${path}: ${message}`);
	}
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, out: Collector): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			out.add(path === "" ? key : `${path}.${key}`, `unknown setting (expected one of: ${allowed.join(", ")})`);
		}
	}
}

function readInteger(value: unknown, path: string, min: number, max: number, out: Collector): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		out.add(path, `must be a whole number between ${min} and ${max}`);
		return undefined;
	}
	return value;
}

/** A charter directory must be a real subdirectory of the project. */
export function directoryProblem(directory: unknown): string | undefined {
	if (typeof directory !== "string" || directory.trim() === "") return "must be a non-empty relative path";
	if (isAbsolute(directory)) return "must be relative to the project root";
	const normalized = normalize(directory);
	if (normalized === "." || normalized === "") return "must not be the project root itself";
	if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.startsWith("../")) {
		return "must stay inside the project root";
	}
	const first = normalized.split(/[\\/]/)[0];
	if (first === ".git") return "must not live inside .git";
	return undefined;
}

function applyRole(target: RoleConfig, raw: unknown, role: Role, out: Collector): void {
	const path = `roles.${role}`;
	if (!isRecord(raw)) {
		out.add(path, "must be an object");
		return;
	}
	const allowed = ["enabled", "model", "thinking", "timeoutMinutes", ...(role === "auditor" ? ["shards"] : [])];
	rejectUnknownKeys(raw, allowed, path, out);
	if ("enabled" in raw) {
		if (typeof raw.enabled === "boolean") target.enabled = raw.enabled;
		else out.add(`${path}.enabled`, "must be true or false");
	}
	if ("model" in raw) {
		if (raw.model === null || raw.model === "inherit") target.model = null;
		else if (typeof raw.model === "string" && /^[^/\s]+\/\S+$/.test(raw.model)) target.model = raw.model;
		else out.add(`${path}.model`, 'must be "provider/model-id", or null to inherit the session model');
	}
	if ("thinking" in raw) {
		if (typeof raw.thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(raw.thinking)) {
			target.thinking = raw.thinking as ThinkingLevel;
		} else {
			out.add(`${path}.thinking`, `must be one of: ${THINKING_LEVELS.join(", ")}`);
		}
	}
	if ("timeoutMinutes" in raw) {
		const value = readInteger(raw.timeoutMinutes, `${path}.timeoutMinutes`, 0, 24 * 60, out);
		if (value !== undefined) target.timeoutMinutes = value;
	}
	if (role === "auditor" && "shards" in raw) {
		const value = readInteger(raw.shards, `${path}.shards`, 1, 8, out);
		if (value !== undefined) (target as AuditorConfig).shards = value;
	}
}

function readChecks(raw: unknown, out: Collector): CheckConfig[] | undefined {
	if (!Array.isArray(raw)) {
		out.add("checks", "must be a list");
		return undefined;
	}
	const checks: CheckConfig[] = [];
	const names = new Set<string>();
	raw.forEach((entry, index) => {
		const path = `checks[${index}]`;
		if (!isRecord(entry)) {
			out.add(path, "must be an object with name and run");
			return;
		}
		rejectUnknownKeys(entry, ["name", "run", "timeoutSeconds"], path, out);
		const name = entry.name;
		const run = entry.run;
		if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,39}$/.test(name)) {
			out.add(`${path}.name`, "must be 1-40 characters: letters, digits, space, _ . : -");
			return;
		}
		if (names.has(name)) {
			out.add(`${path}.name`, `duplicate check name "${name}"`);
			return;
		}
		if (typeof run !== "string" || run.trim() === "") {
			out.add(`${path}.run`, "must be a non-empty shell command");
			return;
		}
		let timeoutSeconds = 600;
		if ("timeoutSeconds" in entry) {
			const value = readInteger(entry.timeoutSeconds, `${path}.timeoutSeconds`, 1, 6 * 60 * 60, out);
			if (value === undefined) return;
			timeoutSeconds = value;
		}
		names.add(name);
		checks.push({ name, run, timeoutSeconds });
	});
	return checks;
}

/** Merge one raw layer over `base`, collecting every problem instead of stopping at the first. */
function applyLayer(base: CharterConfig, raw: unknown, out: Collector): CharterConfig {
	const config = cloneConfig(base);
	if (!isRecord(raw)) {
		out.add("(root)", "must be a JSON object");
		return config;
	}
	rejectUnknownKeys(raw, ["$schema", "version", "directory", "roles", "checks", "limits", "git"], "", out);
	if (!("version" in raw)) out.add("version", `is required (use ${CONFIG_VERSION})`);
	else if (raw.version !== CONFIG_VERSION) out.add("version", `unsupported value ${JSON.stringify(raw.version)} (this release reads version ${CONFIG_VERSION})`);

	if ("directory" in raw) {
		const problem = directoryProblem(raw.directory);
		if (problem) out.add("directory", problem);
		else config.directory = normalize(raw.directory as string).split(sep).join("/");
	}
	if ("roles" in raw) {
		if (!isRecord(raw.roles)) out.add("roles", "must be an object");
		else {
			rejectUnknownKeys(raw.roles, ROLES, "roles", out);
			for (const role of ROLES) {
				if (role in raw.roles) applyRole(config.roles[role], raw.roles[role], role, out);
			}
		}
	}
	if ("checks" in raw) {
		const checks = readChecks(raw.checks, out);
		if (checks) config.checks = checks;
	}
	if ("limits" in raw) {
		if (!isRecord(raw.limits)) out.add("limits", "must be an object");
		else {
			rejectUnknownKeys(raw.limits, ["cycles", "gateRetries", "reportNudges"], "limits", out);
			if ("cycles" in raw.limits) {
				const value = readInteger(raw.limits.cycles, "limits.cycles", 1, 50, out);
				if (value !== undefined) config.limits.cycles = value;
			}
			if ("gateRetries" in raw.limits) {
				const value = readInteger(raw.limits.gateRetries, "limits.gateRetries", 0, 10, out);
				if (value !== undefined) config.limits.gateRetries = value;
			}
			if ("reportNudges" in raw.limits) {
				const value = readInteger(raw.limits.reportNudges, "limits.reportNudges", 0, 5, out);
				if (value !== undefined) config.limits.reportNudges = value;
			}
		}
	}
	if ("git" in raw) {
		if (!isRecord(raw.git)) out.add("git", "must be an object");
		else {
			rejectUnknownKeys(raw.git, ["checkpoints"], "git", out);
			if ("checkpoints" in raw.git) {
				if (typeof raw.git.checkpoints === "boolean") config.git.checkpoints = raw.git.checkpoints;
				else out.add("git.checkpoints", "must be true or false");
			}
		}
	}
	return config;
}

/** Validate one raw config object over the defaults. Throws with every problem listed. */
export function parseConfig(raw: unknown, source = "configuration", base: CharterConfig = DEFAULT_CONFIG): CharterConfig {
	const out = new Collector();
	const config = applyLayer(base, raw, out);
	if (out.problems.length > 0) throw new CharterError(`Invalid ${source}:`, out.problems);
	return config;
}

export interface ConfigLocations {
	/** Project file, e.g. `<cwd>/.pi/charter.json`. */
	project: string;
	/** User-wide file, e.g. `~/.pi/agent/charter.json`. */
	user?: string;
}

export function configLocations(cwd: string, configDirName: string, agentDir?: string): ConfigLocations {
	return {
		project: join(cwd, configDirName, CONFIG_FILE_NAME),
		user: agentDir ? join(agentDir, CONFIG_FILE_NAME) : undefined,
	};
}

export interface LoadedConfig {
	config: CharterConfig;
	/** Files that contributed, in merge order. Empty when only defaults apply. */
	sources: string[];
}

export async function loadConfig(locations: ConfigLocations, options: { trustProject?: boolean } = {}): Promise<LoadedConfig> {
	let config = cloneConfig(DEFAULT_CONFIG);
	const sources: string[] = [];
	const layers = [locations.user, options.trustProject === false ? undefined : locations.project];
	for (const file of layers) {
		if (!file) continue;
		const raw = await readJsonIfExists(file);
		if (raw === undefined) continue;
		config = parseConfig(raw, file, config);
		sources.push(file);
	}
	return { config, sources };
}

/** Persist a complete config. Unknown/default-equal fields are kept explicit so the file documents itself. */
export async function saveConfig(path: string, config: CharterConfig): Promise<void> {
	parseConfig(config, path);
	await writeJsonAtomic(path, config);
}

export function enabledRoles(config: CharterConfig): Role[] {
	if (!config.roles.implementer.enabled) return [];
	return ROLES.filter((role) => config.roles[role].enabled);
}

export function describeRole(config: CharterConfig, role: Role): string {
	const settings = config.roles[role];
	const model = settings.model ?? "session model";
	const extra = role === "auditor" && config.roles.auditor.shards > 1 ? `, up to ${config.roles.auditor.shards} shards` : "";
	return `${role} (${model}, thinking ${settings.thinking}${extra})`;
}
