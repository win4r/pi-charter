/**
 * The closest thing to production that runs without a real model: the actual
 * `pi` executable in RPC mode, this package installed through Pi's settings,
 * and a local HTTP server speaking the OpenAI chat-completions protocol as the
 * model. Nothing is injected: agents create their own sessions, discover
 * extensions the normal way, and must not end up with the coordinator's tools.
 */

import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

import type { CharterState } from "../../src/core/state.ts";
import { BRIEF, specWith, tempProject } from "../support/fixtures.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "../..");
const PI = join(PACKAGE_ROOT, "node_modules/.bin/pi");

interface ChatRequest {
	model: string;
	messages: Array<{ role: string; content: unknown }>;
	tools?: Array<{ function: { name: string } }>;
}
type Reply = { text: string } | { tool: string; args: Record<string, unknown> };

/** Flatten an OpenAI message content (string or parts) to text. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : "")).join("\n");
	return "";
}

function mockModelServer(decide: (request: ChatRequest) => Reply): Promise<{ server: Server; url: string; requests: ChatRequest[] }> {
	const requests: ChatRequest[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const request = JSON.parse(body) as ChatRequest;
			requests.push(request);
			const reply = decide(request);
			const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
				`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream" });
			if ("text" in reply) {
				res.write(chunk({ role: "assistant", content: reply.text }));
				res.write(chunk({}, "stop"));
			} else {
				res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }));
				res.write(chunk({}, "tool_calls"));
			}
			res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model: request.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests })));
}

/** Minimal RPC client: JSONL in, JSONL out, with helpers to wait for records. */
class Rpc {
	readonly records: Array<Record<string, unknown>> = [];
	stderr = "";
	private buffer = "";
	private waiters: Array<{ match: (record: Record<string, unknown>) => boolean; resolve: (record: Record<string, unknown>) => void }> = [];
	private readonly child: ChildProcessWithoutNullStreams;

	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		child.stdout.on("data", (data: Buffer) => {
			this.buffer += data.toString("utf8");
			for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				let record: Record<string, unknown>;
				try {
					record = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				this.records.push(record);
				this.waiters = this.waiters.filter((waiter) => {
					if (!waiter.match(record)) return true;
					waiter.resolve(record);
					return false;
				});
			}
		});
		child.stderr.on("data", (data: Buffer) => (this.stderr += data.toString("utf8")));
	}

	send(record: Record<string, unknown>): void {
		this.child.stdin.write(`${JSON.stringify(record)}\n`);
	}

	waitFor(match: (record: Record<string, unknown>) => boolean, label: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
		const seen = this.records.find(match);
		if (seen) return Promise.resolve(seen);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}\nstderr: ${this.stderr.slice(-2000)}\nlast records: ${JSON.stringify(this.records.slice(-6)).slice(0, 3000)}`)), timeoutMs);
			this.waiters.push({ match, resolve: (record) => { clearTimeout(timer); resolve(record); } });
		});
	}

	/** Send a prompt and wait until Pi has nothing left to do. */
	async prompt(message: string): Promise<void> {
		const mark = this.records.length;
		this.send({ type: "prompt", message });
		await this.waitFor((record) => this.records.indexOf(record) >= mark && record.type === "agent_settled", `agent_settled after "${message}"`);
	}
}

test("the real pi executable runs a charter end to end with this package installed", { timeout: 180_000 }, async () => {
	const project = tempProject();
	const home = join(project.root, "..", `${project.root.split("/").pop()}-home`);
	const agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });

	const criteria = (text: string): string[] => [...(text.split("\n").findLast((line) => line.includes("result and evidence for each of:")) ?? "").matchAll(/AC\d+/g)].map((match) => match[0]);
	const passing = (ids: string[]) => ids.map((id) => ({ id, result: "pass", evidence: `verified ${id}` }));
	const turns: Record<string, number> = {};
	const { server, url, requests } = await mockModelServer((request) => {
		const turn = (turns[request.model] = (turns[request.model] ?? 0) + 1);
		const brief = textOf(request.messages.find((message) => message.role === "user")?.content);
		if (request.model === "impl") {
			if (turn === 1) return { tool: "write", args: { path: "src/greet.js", content: "export const greet = (name) => `Hello, ${name}`;\n" } };
			return { tool: "charter_report", args: { status: "done", summary: "Added greet().", criteria: passing(criteria(brief)), filesChanged: ["src/greet.js"] } };
		}
		if (request.model === "audit") return { tool: "charter_report", args: { criteria: passing(criteria(brief)) } };
		// The coordinator: acknowledge the new charter, then request approval, then present the result.
		if (turn === 1) return { text: "What should the greeting say?" };
		if (turn === 2) return { tool: "charter_approve", args: {} };
		return { text: "The charter is complete and audited." };
	});

	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [PACKAGE_ROOT] }));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: url, api: "openai-completions", apiKey: "mock-key", models: [{ id: "main" }, { id: "impl" }, { id: "audit" }] } } }));
	// User-wide configuration, so the test does not depend on project trust.
	writeFileSync(join(agentDir, "charter.json"), JSON.stringify({ version: 1, roles: { implementer: { model: "mock/impl", thinking: "off" }, auditor: { model: "mock/audit", thinking: "off" } } }));

	const child = spawn(PI, ["--mode", "rpc", "--no-session", "--model", "mock/main", "--thinking", "off"], {
		cwd: project.root,
		env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const rpc = new Rpc(child);
	try {
		rpc.send({ id: "commands", type: "get_commands" });
		const commands = await rpc.waitFor((record) => record.id === "commands", "get_commands");
		assert.ok(JSON.stringify(commands).includes('"name":"charter"'), "the /charter command is registered by the installed package");

		await rpc.prompt("/charter new Greeting");
		const dir = join(project.root, ".charter/001-greeting");
		assert.match(readFileSync(join(dir, "brief.md"), "utf8"), /^# Brief: Greeting/, "templates are found next to the installed package");
		project.write(".charter/001-greeting/brief.md", BRIEF);
		project.write(".charter/001-greeting/spec.md", specWith(2));

		// The approval dialog arrives over RPC; this client plays the developer and confirms.
		const settled = rpc.prompt("The documents are ready. Please request approval.");
		const dialog = await rpc.waitFor((record) => record.type === "extension_ui_request" && record.method === "confirm", "approval dialog");
		assert.equal(dialog.title, "Approve charter 001-greeting?");
		assert.match(String(dialog.message), /2 requirement\(s\), 2 acceptance criteria[\s\S]*implementer \(mock\/impl.*-> auditor \(mock\/audit/);
		rpc.send({ type: "extension_ui_response", id: dialog.id, confirmed: true });
		await settled;

		const state = JSON.parse(readFileSync(join(dir, "charter.json"), "utf8")) as CharterState;
		assert.equal(state.stage, "done", `stderr: ${rpc.stderr.slice(-1500)}`);
		assert.deepEqual(state.runs.map((run) => `${run.label}:${run.outcome}:${run.model}`), ["impl-1:reported:mock/impl", "audit-1:reported:mock/audit"]);
		assert.ok(state.usage.input > 0, "usage reported by the provider is accounted");
		assert.match(project.read("src/greet.js"), /Hello, /);
		assert.match(readFileSync(join(dir, "report.md"), "utf8"), /\| AC2 \| pass \| pass \| verified AC2 \|/);

		// What each model was offered, as seen on the wire.
		const toolsOf = (model: string): string[] => [...new Set(requests.filter((request) => request.model === model).flatMap((request) => (request.tools ?? []).map((tool) => tool.function.name)))];
		assert.ok(toolsOf("main").includes("charter_approve"));
		for (const agent of ["impl", "audit"]) {
			assert.deepEqual(toolsOf(agent).filter((name) => name.startsWith("charter_")), ["charter_report"], `${agent} must only get its report tool`);
		}
		const implSystem = requests.filter((request) => request.model === "impl").flatMap((request) => request.messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => textOf(message.content))).join("\n");
		assert.match(implSystem, /# Role: implementer/);
		assert.doesNotMatch(implSystem, /# Charter mode/, "agents do not receive the coordinator's instructions");
		assert.equal(requests.filter((request) => request.model === "impl").length, 2);
		assert.equal(requests.filter((request) => request.model === "audit").length, 1);
		assert.equal(requests.filter((request) => request.model === "main").length, 3);

		const status = rpc.records.findLast((record) => record.type === "extension_ui_request" && record.method === "setStatus");
		assert.equal(status?.statusText, "charter 001-greeting · done");
	} finally {
		child.kill();
		server.close();
		rmSync(home, { recursive: true, force: true });
		project.cleanup();
	}
});
