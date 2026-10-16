import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import engProtocol from "./index.ts";
import { CARDS } from "./guidance.ts";

test("extension lifecycle uses current decisions and preserves the transcript", async (t) => {
	const requests = [];
	let httpStatus = 200;
	let maxCards = 2;
	let architectureExists = true;
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			requests.push(JSON.parse(body));
			response.writeHead(httpStatus, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ answers: Object.fromEntries(CARDS.map(({ id }) => [id, { probabilities: { yes: id === "context" ? 0.95 : id === "verify" ? 0.9 : 0.1 } }])) }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const globalConfig = join(homedir(), ".pi", "agent", "eng-protocol.json");
	const missing = () => Object.assign(new Error("absent in test environment"), { code: "ENOENT" });
	t.mock.method(fs, "readFile", async (path) => {
		if (path === globalConfig) return JSON.stringify({ maxCards, decision: { endpoint: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "local-test", timeoutMs: 1000 } });
		if (String(path).endsWith(join(".pi", "eng-protocol.md"))) return "使用项目既有组件";
		throw missing();
	});
	t.mock.method(fs, "access", async (path) => {
		if (architectureExists && path === join("C:/test-project", "ARCHITECTURE.md")) return;
		throw missing();
	});
	syncBuiltinESMExports();
	const handlers = new Map();
	const notices = [];
	let command;
	const ctx = { cwd: "C:/test-project", hasUI: true, ui: { notify: (message) => notices.push(message), setStatus: () => {}, theme: { fg: (_color, text) => text } } };
	engProtocol({ on: (event, handler) => handlers.set(event, handler), registerCommand: (_name, definition) => { command = definition; } });
	const dispatch = (messages, context = ctx) => handlers.get("context_with_system")({ messages }, context);
	const messages = [{ role: "user", content: "继续" }];
	try {
		await handlers.get("session_start")({}, ctx);
		await t.test("base prompt and project rules are installed without rewriting the conversation", async () => {
			const event = { systemPromptOptions: { sections: {} } };
			await handlers.get("before_agent_start")(event, ctx);
			assert.ok(event.systemPromptOptions.sections.engineering_protocol.includes("宿主提醒"));
			assert.equal(event.systemPromptOptions.sections.project_engineering_rules, "使用项目既有组件");
			const snapshot = structuredClone(messages);
			const injected = await dispatch(messages);
			assert.deepEqual(messages, snapshot);
			assert.equal(requests.length, 1);
			assert.equal(requests[0].state.projectRules, "使用项目既有组件");
			assert.equal(injected.messages.at(-1).content.match(/【/g).length, 2);
			await command.handler("show", ctx);
			const actual = injected.messages.at(-1).content.split("\n\n").slice(1).join("\n\n");
			assert.ok(notices.at(-1).endsWith(actual));
			await dispatch(messages);
			assert.equal(requests.length, 1, "identical state reuses a successful decision");
		});
		await t.test("reload invalidates the selection and its displayed payload", async () => {
			maxCards = 1;
			architectureExists = false;
			await command.handler("reload", ctx);
			await command.handler("show", ctx);
			assert.ok(!notices.at(-1).includes("<engineering-guidance>"));
			const injected = await dispatch(messages);
			assert.equal(requests.length, 2);
			assert.equal(injected.messages.at(-1).content.match(/【/g).length, 1);
			assert.ok(!injected.messages.at(-1).content.includes("ARCHITECTURE.md"));
		});
		await t.test("failed decisions skip injection even when a different turn repeats the same request", async () => {
			httpStatus = 503;
			const next = [...messages, { role: "assistant", content: "上一项已完成" }, { role: "user", content: "继续" }];
			assert.equal(await dispatch(next), undefined);
			await command.handler("show", ctx);
			assert.ok(notices.at(-1).includes("HTTP 503"));
			assert.ok(!notices.at(-1).includes("<engineering-guidance>"));
			httpStatus = 200;
			assert.ok(await dispatch(next));
			assert.equal(requests.length, 4);
		});
		await t.test("disabled and cancelled requests emit no guidance", async () => {
			await command.handler("off", ctx);
			assert.equal(await dispatch(messages), undefined);
			assert.equal(requests.length, 4);
			await command.handler("show", ctx);
			assert.ok(!notices.at(-1).includes("<engineering-guidance>"));
			await command.handler("on", ctx);
			const noticeCount = notices.length;
			assert.equal(await dispatch([{ role: "user", content: "取消" }], { ...ctx, signal: AbortSignal.abort() }), undefined);
			assert.equal(notices.length, noticeCount, "cancellation is not a service warning");
		});
	} finally {
		await handlers.get("session_shutdown")({}, ctx);
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await new Promise((resolve) => server.close(resolve));
	}
});
