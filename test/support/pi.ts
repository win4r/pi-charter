/**
 * End-to-end harness: a real Pi `AgentSession` with this extension loaded,
 * real child sessions for the agents, and Pi's faux provider standing in for
 * the models. Each model id has its own script, so main-session and agent
 * replies cannot be mixed up even when agents run in parallel.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type ExtensionUIContext, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

import { createCharterExtension } from "../../src/pi/extension.ts";
import { type Project, tempProject } from "./fixtures.ts";

export type Reply = AssistantMessage | ((context: { messages: Message[] }, options: { signal?: AbortSignal }) => AssistantMessage | Promise<AssistantMessage>);

export const call = (name: string, args: Record<string, unknown> = {}): AssistantMessage => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
export const calls = (...entries: Array<[string, Record<string, unknown>]>): AssistantMessage =>
	fauxAssistantMessage(entries.map(([name, args]) => fauxToolCall(name, args as never)), { stopReason: "toolUse" });
export const say = (text: string): AssistantMessage => fauxAssistantMessage(text);

/** Text of every part of every message, for loose assertions on what a model was shown. */
export function transcript(messages: Message[]): string {
	return JSON.stringify(messages);
}

/** Names of the tools declared to the model in this request. */
export function declaredTools(messages: Message[]): string[] {
	const names = new Set<string>();
	for (const message of messages) {
		const added = (message as { toolsAdded?: Array<{ name: string }> }).toolsAdded;
		for (const tool of added ?? []) names.add(tool.name);
	}
	return [...names];
}

/** First user message of a request: for an agent, that is its task brief. */
export function briefOf(messages: Message[]): string {
	const user = messages.find((message) => message.role === "user");
	if (!user) return "";
	return typeof user.content === "string" ? user.content : user.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

export interface FakeUI {
	context: ExtensionUIContext;
	/** Answers for confirm(), consumed in order; default when empty: true. */
	confirms: boolean[];
	/** Answers for select(), consumed in order; default when empty: first option. */
	selects: Array<string | undefined>;
	inputs: Array<string | undefined>;
	dialogs: Array<{ kind: string; title: string; message?: string; options?: string[] }>;
	notifications: Array<{ message: string; type: string }>;
	status: Map<string, string | undefined>;
}

function fakeUI(): FakeUI {
	const ui: FakeUI = { context: undefined as unknown as ExtensionUIContext, confirms: [], selects: [], inputs: [], dialogs: [], notifications: [], status: new Map() };
	const implemented: Record<string, unknown> = {
		confirm: async (title: string, message: string) => {
			ui.dialogs.push({ kind: "confirm", title, message });
			return ui.confirms.length > 0 ? ui.confirms.shift() : true;
		},
		select: async (title: string, options: string[]) => {
			ui.dialogs.push({ kind: "select", title, options });
			return ui.selects.length > 0 ? ui.selects.shift() : options[0];
		},
		input: async (title: string) => {
			ui.dialogs.push({ kind: "input", title });
			return ui.inputs.shift();
		},
		notify: (message: string, type = "info") => void ui.notifications.push({ message, type }),
		setStatus: (key: string, text: string | undefined) => void ui.status.set(key, text),
	};
	// Everything else a UI offers is irrelevant here and safely ignored.
	ui.context = new Proxy(implemented, { get: (target, property) => target[property as string] ?? (() => undefined) }) as unknown as ExtensionUIContext;
	return ui;
}

export interface PiHarness {
	project: Project;
	agentDir: string;
	session: AgentSession;
	ui: FakeUI;
	modelRuntime: ModelRuntime;
	/** Queue replies for a model id: "main", "impl", "audit" or "refine". */
	script(model: string, ...replies: Reply[]): void;
	/** Reply used for a model once its queue is empty. */
	fallback(model: string, reply: Reply): void;
	/** Requests each model received, in order. */
	seen: Record<string, Message[][]>;
	prompt(text: string): Promise<void>;
	/** Text of the tool results returned to the main model, in order. */
	toolResults(): string[];
	charterDir(id: string): string;
	dispose(): Promise<void>;
}

export interface PiHarnessOptions {
	/** Written to `<project>/.pi/charter.json`. Role models default to faux/impl, faux/audit, faux/refine. */
	config?: Record<string, unknown>;
	ui?: boolean;
	files?: Record<string, string>;
	git?: boolean;
	/** Reuse a session manager to simulate resuming a session. */
	sessionManager?: SessionManager;
	project?: Project;
}

const MODELS = ["main", "impl", "audit", "refine"];

export async function piHarness(options: PiHarnessOptions = {}): Promise<PiHarness> {
	const project = options.project ?? tempProject({ git: options.git, files: options.files });
	const agentDir = join(project.root, "..", `${project.root.split("/").pop()}-agent`);
	mkdirSync(agentDir, { recursive: true });

	const baseConfig = {
		version: 1,
		roles: {
			implementer: { model: "faux/impl", thinking: "off" },
			auditor: { model: "faux/audit", thinking: "off" },
			refiner: { model: "faux/refine", thinking: "off" },
		},
	};
	const config = options.config ?? {};
	const roles = { ...baseConfig.roles } as Record<string, Record<string, unknown>>;
	for (const [role, settings] of Object.entries((config.roles as Record<string, Record<string, unknown>> | undefined) ?? {})) roles[role] = { ...roles[role], ...settings };
	if (!options.project) project.write(".pi/charter.json", JSON.stringify({ ...baseConfig, ...config, roles }, null, 2));

	const faux = fauxProvider({ provider: "faux", models: MODELS.map((id) => ({ id })) });
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);

	const queues: Record<string, Reply[]> = {};
	const fallbacks: Record<string, Reply> = {};
	const seen: Record<string, Message[][]> = {};
	const router = async (context: { messages: Message[] }, options: { signal?: AbortSignal } | undefined, _state: unknown, model: { id: string }): Promise<AssistantMessage> => {
		(seen[model.id] ??= []).push(context.messages);
		const reply = queues[model.id]?.shift() ?? fallbacks[model.id];
		if (!reply) return fauxAssistantMessage(`(no scripted reply left for model ${model.id})`);
		return typeof reply === "function" ? reply(context, options ?? {}) : reply;
	};
	faux.setResponses(Array.from({ length: 400 }, () => router as never));

	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: project.root,
		agentDir,
		settingsManager,
		extensionFactories: [createCharterExtension({ modelRuntime, agentDir })],
	});
	await resourceLoader.reload();
	const main = modelRuntime.getModel("faux", "main");
	if (!main) throw new Error("faux main model missing");
	const { session } = await createAgentSession({
		cwd: project.root,
		agentDir,
		modelRuntime,
		resourceLoader,
		settingsManager,
		model: main,
		thinkingLevel: "off",
		sessionManager: options.sessionManager ?? SessionManager.inMemory(project.root),
	});
	const ui = fakeUI();
	await session.bindExtensions(options.ui === false ? { mode: "print" } : { mode: "rpc", uiContext: ui.context });

	return {
		project,
		agentDir,
		session,
		ui,
		modelRuntime,
		seen,
		script(model, ...replies) {
			(queues[model] ??= []).push(...replies);
		},
		fallback(model, reply) {
			fallbacks[model] = reply;
		},
		async prompt(text) {
			await session.prompt(text);
			await session.waitForIdle();
		},
		toolResults() {
			return session.messages.flatMap((message) => (message.role === "toolResult" ? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")] : []));
		},
		charterDir(id) {
			return join(project.root, ".charter", id);
		},
		async dispose() {
			session.dispose();
			project.cleanup();
		},
	};
}
