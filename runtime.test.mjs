import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import engProtocol from "./index.ts";

const user = (text = "修复并验证") => ({ role: "user", content: text });
const turn = (id, name = "read", args = { path: "a.ts" }, text = "same", exit) => [
	{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
	{ role: "toolResult", toolCallId: id, toolName: name, content: text, ...(exit === undefined ? {} : { details: { exitCode: exit } }) },
];

test("optimized runtime integrates budgets, modes, cooldown, backoff, branch evidence and offline facts", async (t) => {
	const requests = [];
	const notices = [];
	let global = {};
	let project = {};
	let status = 200;
	let selected = ["architecture"];
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body); requests.push(payload);
			response.writeHead(status);
			response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(payload.questions).map(([id, question]) => {
				const winner = id.startsWith("relation_") ? "independent" : selected.includes(id) ? "needed" : "inapplicable";
				return [id, { probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === winner ? 1 : 0])) }];
			})) }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const globalPath = join(homedir(), ".pi", "agent", "eng-protocol.json");
	const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
	t.mock.method(fs, "readFile", async (path) => {
		if (path === fileURLToPath(new URL("./protocol.md", import.meta.url))) return "测试规范";
		if (path === globalPath) return JSON.stringify({ ...global, decision: { endpoint: `http://127.0.0.1:${server.address().port}`, apiKey: "test", ...global.decision } });
		if (String(path).endsWith(join(".pi", "eng-protocol.json"))) return JSON.stringify(project);
		throw missing();
	});
	t.mock.method(fs, "access", async () => { throw missing(); });
	syncBuiltinESMExports();
	const handlers = new Map();
	let command;
	const ctx = { cwd: "C:/test-project", hasUI: true, ui: { notify: (text) => notices.push(text), setStatus() {}, theme: { fg: (_style, text) => text } } };
	engProtocol({ on: (event, handler) => handlers.set(event, handler), registerCommand: (_name, value) => { command = value; } });
	const dispatch = (messages, context = ctx) => handlers.get("context_with_system")({ messages }, context);
	const reload = () => command.handler("reload", ctx);
	try {
		await handlers.get("session_start")({}, ctx);
		await t.test("default single batch and explicit two-batch budget cap HTTP work; exact cache reuse avoids a call", async () => {
			const messages = [user()];
			await dispatch(messages);
			assert.equal(requests.length, 1);
			assert.ok(requests.reduce((count, body) => count + Object.keys(body.questions).length, 0) <= 16);
			const before = requests.length;
			await dispatch(messages);
			assert.equal(requests.length, before);
			global = { maxQuestions: 32 }; await reload();
			await dispatch(messages);
			assert.equal(requests.length, before + 2);
		});
		await t.test("duplicate reads gate requests without replaying stale guidance", async () => {
			global = { maxQuestions: 0 }; await reload();
			const messages = [user(), ...turn("r0")];
			assert.ok(await dispatch(messages));
			const before = requests.length;
			messages.push(...turn("r1"));
			assert.equal(await dispatch(messages), undefined);
			assert.equal(requests.length, before);
			messages.push(...turn("r2", "read", { path: "b.ts" }, "new"));
			assert.equal(await dispatch(messages), undefined, "architecture reminder is cooling after actual injection");
			assert.ok(requests.length > before, "new evidence is evaluated");
			await command.handler("show", ctx);
			assert.match(notices.at(-1), /提醒冷却/);
		});
		await t.test("mode switches reset decisions, update prompts and disable proactive questions", async () => {
			selected = ["intent_discovery"];
			await command.handler("mode proactive", ctx);
			assert.ok(await dispatch([user("有关键分叉")]));
			const prompt = { systemPromptOptions: { sections: {} } };
			await handlers.get("before_agent_start")(prompt, ctx);
			assert.match(prompt.systemPromptOptions.sections.engineering_agency, /proactive/);
			await command.handler("mode passive", ctx);
			const before = requests.length;
			assert.equal(await dispatch([user("有关键分叉")]), undefined);
			assert.ok(requests.slice(before).every((body) => !body.questions.intent_discovery));
			await command.handler("mode balanced", ctx);
			assert.deepEqual(command.getArgumentCompletions("mode pro").map((item) => item.value), ["mode proactive"]);
		});
		await t.test("project card receives an independent assessment and renders its actual title", async () => {
			project = { customCards: [{ id: "project_migration", title: "项目迁移", question: "Does the current change need migration?", guidance: "核对项目迁移要求。" }] };
			selected = ["project_migration"]; await reload();
			const result = await dispatch([user("改数据结构")]);
			assert.match(result.messages.at(-1).content, /【项目迁移】/);
		});
		await t.test("remote failure backs off and supplies truthful local evidence without persisting it", async () => {
			project = {}; global = { decision: { retryAfterMs: 60_000 } }; status = 503; await reload();
			const messages = [user(), ...turn("fail", "bash", { command: "npm test" }, "failed", 1)];
			const original = structuredClone(messages);
			const result = await dispatch(messages);
			assert.match(result.messages.at(-1).content, /检查失败的已知证据/);
			assert.deepEqual(messages, original);
			const before = requests.length;
			messages.push(...turn("inspect", "read", { path: "a.ts" }, "new evidence"));
			await dispatch(messages);
			assert.equal(requests.length, before, "backoff avoids another remote timeout on each step");
			await command.handler("status", ctx);
			const metrics = JSON.parse(notices.at(-1).split("会话指标：")[1]);
			assert.ok(metrics.failures && metrics.local && metrics.requests);
			status = 200;
		});
		await t.test("offline mode requires no credentials and cancellation never injects a fallback", async () => {
			global = { decision: { provider: "local", apiKey: "$DOES_NOT_EXIST_ENG_TEST" } }; await reload();
			const before = requests.length;
			const messages = [user(), ...turn("offline", "bash", { command: "npm test" }, "failed", 2)];
			assert.ok(await dispatch(messages));
			assert.equal(requests.length, before);
			assert.equal(await dispatch(messages, { ...ctx, signal: AbortSignal.abort() }), undefined);
		});
		await t.test("compacted context uses active branch facts and branch changes cannot reuse old evidence", async () => {
			global = { maxQuestions: 16 }; selected = []; await reload();
			const full = [user(), ...turn("old-read", "read", { path: "old.ts" }), ...turn("old-check", "bash", { command: "npm test" }, "pass", 0)];
			for (let i = 0; i < 12; i++) full.push(...turn(`edit${i}`, "edit", { path: `${i}.ts` }));
			let entries = full.map((message, index) => ({ type: "message", id: String(index), message }));
			const branchCtx = { ...ctx, sessionManager: { getBranch: () => entries, getSessionId: () => "session" } };
			await dispatch([user(), ...full.slice(-2)], branchCtx);
			assert.equal(requests.at(-1).state.ledger.completedWrites, 12);
			assert.equal(requests.at(-1).state.ledger.readFiles, 1);
			assert.equal(requests.at(-1).state.ledger.validation, "check-predates-write");
			entries = [{ type: "message", id: "other", message: user("其他分支") }];
			await handlers.get("session_tree")({}, branchCtx);
			await dispatch([user("其他分支")], branchCtx);
			assert.equal(requests.at(-1).state.ledger.completedWrites, 0);
		});
	} finally {
		await handlers.get("session_shutdown")({}, ctx);
		t.mock.restoreAll(); syncBuiltinESMExports(); server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});
