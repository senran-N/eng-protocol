import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import engProtocol from "./index.ts";
import { CARDS, buildDecisionQuestions, batchDecisionQuestions } from "./guidance.ts";

test("extension lifecycle uses current decisions and preserves the transcript", async (t) => {
	const requests = [];
	let httpStatus = 200;
	let maxCards = 2;
	let timeoutMs = 1000;
	let architectureExists = true;
	let protocolText = "规范 v1：宿主提醒";
	let onRequest;
	const batches = batchDecisionQuestions(buildDecisionQuestions()).length;
	const bodies = new WeakMap();
	let ruleStates = {};
	const holdRequests = () => new Promise((resolve) => {
		const held = [];
		onRequest = (response) => {
			held.push(response);
			if (held.length === batches) resolve(held[0]);
		};
	});
	const respond = (response) => {
		response.writeHead(httpStatus, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(bodies.get(response).questions).map(([id, question]) => {
			const winner = ruleStates[id] ?? (id.startsWith("relation_") ? "independent" : ["context", "verify"].includes(id) ? "needed" : "inapplicable");
			const options = Object.keys(question.criteria);
			return [id, { probabilities: Object.fromEntries(options.map((option) => [option, option === winner ? 0.96 : 0.04 / (options.length - 1)])) }];
		})) }));
	};
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body);
			requests.push(payload);
			bodies.set(response, payload);
			if (onRequest) onRequest(response);
			else respond(response);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const globalConfig = join(homedir(), ".pi", "agent", "eng-protocol.json");
	const missing = () => Object.assign(new Error("absent in test environment"), { code: "ENOENT" });
	t.mock.method(fs, "readFile", async (path) => {
		if (path === fileURLToPath(new URL("./protocol.md", import.meta.url))) return protocolText;
		if (path === globalConfig) return JSON.stringify({ maxCards, decision: { endpoint: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "local-test", timeoutMs } });
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
	const statuses = [];
	let command;
	const ctx = { cwd: "C:/test-project", hasUI: true, ui: { notify: (message) => notices.push(message), setStatus: (_key, text) => statuses.push(text), theme: { fg: (_color, text) => text } } };
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
			assert.equal(requests.length, batches);
			assert.ok(requests.every((request) => Object.keys(request.questions).length <= 16));
			assert.ok(CARDS.every(({ id }) => requests.some((request) => id in request.questions)));
			assert.equal(requests[0].state.projectRules, "使用项目既有组件");
			assert.equal(injected.messages.at(-1).content.match(/【/g).length, 2);
			await command.handler("show", ctx);
			const actual = injected.messages.at(-1).content.split("\n\n").slice(1).join("\n\n");
			assert.ok(notices.at(-1).endsWith(actual));
			await dispatch(messages);
			assert.equal(requests.length, batches, "identical state reuses a successful decision");
		});
		await t.test("reload invalidates the selection and its displayed payload", async () => {
			maxCards = 1;
			architectureExists = false;
			await command.handler("reload", ctx);
			await command.handler("show", ctx);
			assert.ok(!notices.at(-1).includes("<engineering-guidance>"));
			const injected = await dispatch(messages);
			assert.equal(requests.length, 2 * batches);
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
			const before = requests.length;
			assert.ok(await dispatch(next));
			assert.equal(requests.length, before + batches);
		});
		await t.test("disabled and cancelled requests emit no guidance", async () => {
			const before = requests.length;
			await command.handler("off", ctx);
			assert.equal(await dispatch(messages), undefined);
			assert.equal(requests.length, before);
			await command.handler("show", ctx);
			assert.ok(!notices.at(-1).includes("<engineering-guidance>"));
			await command.handler("on", ctx);
			const noticeCount = notices.length;
			assert.equal(await dispatch([{ role: "user", content: "取消" }], { ...ctx, signal: AbortSignal.abort() }), undefined);
			assert.equal(notices.length, noticeCount, "cancellation is not a service warning");
		});
		await t.test("reload refreshes the protocol used by the next agent run", async () => {
			protocolText = "规范 v2：验证实际调用入口";
			await command.handler("reload", ctx);
			const event = { systemPromptOptions: { sections: {} } };
			await handlers.get("before_agent_start")(event, ctx);
			assert.equal(event.systemPromptOptions.sections.engineering_protocol, protocolText);
		});
		await t.test("off aborts an in-flight request even when immediately enabled again", { timeout: 2000 }, async () => {
			const received = holdRequests();
			const pending = dispatch([{ role: "user", content: "等待停用" }]);
			const response = await received;
			try {
				const closed = new Promise((resolve) => response.once("close", resolve));
				await command.handler("off", ctx);
				await command.handler("on", ctx);
				const noticeCount = notices.length;
				assert.equal(await pending, undefined);
				await closed;
				assert.equal(notices.length, noticeCount, "turning off is not a service failure");
				await command.handler("show", ctx);
				assert.ok(!notices.at(-1).includes("<engineering-guidance>"));
			} finally {
				onRequest = undefined;
				response.destroy();
			}
		});
		await t.test("reload prevents old decisions from populating the new cache", async () => {
			const next = [{ role: "user", content: "等待重载" }];
			const received = holdRequests();
			const pending = dispatch(next);
			const response = await received;
			try {
				maxCards = 2;
				await command.handler("reload", ctx);
				respond(response);
				assert.equal(await pending, undefined);
				await command.handler("show", ctx);
				assert.ok(!notices.at(-1).includes("<engineering-guidance>"));
				onRequest = undefined;
				const before = requests.length;
				const injected = await dispatch(next);
				assert.equal(injected.messages.at(-1).content.match(/【/g).length, 2);
				assert.equal(requests.length, before + batches, "the new configuration requires a fresh decision");
				await dispatch(next);
				assert.equal(requests.length, before + batches, "old cancellation cannot erase the new cache");
			} finally {
				onRequest = undefined;
				response.destroy();
			}
		});
		await t.test("cancelling an active request is quiet and does not cache its result", async () => {
			const controller = new AbortController();
			const next = [{ role: "user", content: "执行中取消" }];
			const received = holdRequests();
			const pending = dispatch(next, { ...ctx, signal: controller.signal });
			const response = await received;
			try {
				const noticeCount = notices.length;
				controller.abort();
				assert.equal(await pending, undefined);
				assert.equal(notices.length, noticeCount);
				assert.equal(statuses.at(-1), "⚖ —", "cancelled requests clear the prior status");
				onRequest = undefined;
				const before = requests.length;
				assert.ok(await dispatch(next));
				assert.equal(requests.length, before + batches);
			} finally {
				onRequest = undefined;
				response.destroy();
			}
		});
		await t.test("timeouts still report failure and leave no injected guidance", { timeout: 2000 }, async () => {
			timeoutMs = 100;
			await command.handler("reload", ctx);
			const received = holdRequests();
			const pending = dispatch([{ role: "user", content: "等待超时" }]);
			const response = await received;
			try {
				assert.equal(await pending, undefined);
				assert.match(notices.at(-1), /决策模型调用失败/);
				await command.handler("show", ctx);
				assert.match(notices.at(-1), /超时/);
				assert.ok(!notices.at(-1).includes("<engineering-guidance>"));
			} finally {
				onRequest = undefined;
				response.destroy();
				timeoutMs = 1000;
				await command.handler("reload", ctx);
			}
		});
		await t.test("a relevant new edit is reevaluated after satisfied validation and shows conditional coverage", async () => {
			ruleStates = { context: "inapplicable", verify: "satisfied" };
			const verified = [{ role: "user", content: "实现折扣并验证" }, { role: "assistant", content: "修改后的独立验收已通过，代码未再修改。" }];
			assert.equal(await dispatch(verified), undefined);
			await command.handler("show", ctx);
			assert.match(notices.at(-1), /实证验证：已满足/);
			const before = requests.length;
			ruleStates = { context: "inapplicable", verify: "needed", delivery: "needed", relation_verification_covers_completion: "applies" };
			const changed = [...verified, { role: "assistant", content: "随后修改了相同的折扣逻辑，尚未重新验证，准备直接结束。" }];
			const injected = await dispatch(changed);
			assert.equal(requests.length, before + batches);
			assert.equal(injected.messages.at(-1).content.match(/【/g).length, 1);
			await command.handler("show", ctx);
			assert.match(notices.at(-1), /完成已授权工作：需要处理；被覆盖（实证验证）/);
			ruleStates = {};
		});
		await t.test("a newer context supersedes an overlapping decision and owns the cache", async () => {
			const received = holdRequests();
			const older = dispatch([{ role: "user", content: "旧任务仍在等待" }]);
			await received;
			onRequest = undefined;
			const next = [{ role: "user", content: "改做新任务" }];
			const noticeCount = notices.length;
			assert.ok(await dispatch(next));
			assert.equal(await older, undefined);
			assert.equal(notices.length, noticeCount);
			const before = requests.length;
			await dispatch(next);
			assert.equal(requests.length, before, "superseded work cannot erase the current cache");
		});
		await t.test("a superseded cache hit cannot inject guidance while a newer context is pending", async () => {
			const cached = [{ role: "user", content: "旧任务已有缓存" }];
			await dispatch(cached);
			const older = dispatch(cached);
			const newer = dispatch([{ role: "user", content: "缓存命中后立即切换任务" }]);
			assert.equal(await older, undefined);
			assert.ok(await newer);
		});
		await t.test("session shutdown cancels active decisions without a service warning", async () => {
			const received = holdRequests();
			const pending = dispatch([{ role: "user", content: "关闭会话" }]);
			const response = await received;
			try {
				const noticeCount = notices.length;
				await handlers.get("session_shutdown")({}, ctx);
				assert.equal(await pending, undefined);
				assert.equal(notices.length, noticeCount);
				await command.handler("show", ctx);
				assert.ok(!notices.at(-1).includes("<engineering-guidance>"));
			} finally {
				onRequest = undefined;
				response.destroy();
			}
		});
	} finally {
		await handlers.get("session_shutdown")({}, ctx);
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await new Promise((resolve) => server.close(resolve));
	}
});
