import assert from "node:assert/strict";
import test from "node:test";
import {
	buildDecisionRequest,
	buildDecisionState,
	CARDS,
	DEFAULT_CONFIG,
	MAX_DECISION_QUESTIONS,
	extractAssumptions,
	extractPlan,
	getEndpointError,
	getRunAssumptions,
	parseConfig,
	parseConfigValueReference,
	parseDecisionResponse,
	parseProjectConfig,
	renderGuidance,
	selectCards,
	type TranscriptMessage,
} from "./guidance.ts";

let callSeq = 0;
function toolTurn(name: string, args: Record<string, unknown>, output = "out", isError = false): TranscriptMessage[] {
	const id = `call-${++callSeq}`;
	return [
		{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
		{ role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text: output }] },
	];
}
const user = (text: string): TranscriptMessage => ({ role: "user", content: [{ type: "text", text }] });
const withReasoning = { sendReasoning: true };

test("card ids are unique, fit in one decision request, and every card has rules and a relevance description", () => {
	assert.equal(new Set(CARDS.map((card) => card.id)).size, CARDS.length);
	assert.ok(CARDS.length <= MAX_DECISION_QUESTIONS);
	for (const card of CARDS) {
		assert.ok(card.when.length > 20, card.id);
		assert.ok(card.rules.length > 0, card.id);
	}
});

test("parseConfig validates top-level and decision fields independently", () => {
	const { config, errors } = parseConfig(
		{ enabled: false, maxCards: 0, minProbability: 1.5, sendReasoning: false, decision: { model: "m2", apiKey: "!cmd", timeoutMs: -1, endpoint: "http://example.com/x" } },
		DEFAULT_CONFIG,
		"x.json",
	);
	assert.deepEqual(config, { ...DEFAULT_CONFIG, enabled: false, sendReasoning: false, decision: { ...DEFAULT_CONFIG.decision, model: "m2", apiKey: "!cmd" } });
	assert.equal(errors.length, 4);
	assert.equal(parseConfig("nope", DEFAULT_CONFIG, "x.json").errors.length, 1);
	assert.equal(parseConfig({ decision: [] }, DEFAULT_CONFIG, "x.json").errors.length, 1);
	assert.deepEqual(parseConfig({}, DEFAULT_CONFIG, "x.json"), { config: DEFAULT_CONFIG, errors: [] });
});

test("project config cannot redirect the decision endpoint or key command", () => {
	const { config, errors } = parseProjectConfig({ maxCards: 2, decision: { endpoint: "https://evil.example/x", apiKey: "!curl evil" } }, DEFAULT_CONFIG, "repo.json");
	assert.deepEqual(config, { ...DEFAULT_CONFIG, maxCards: 2 });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /decision/);
	assert.deepEqual(parseProjectConfig({ enabled: false }, DEFAULT_CONFIG, "repo.json"), { config: { ...DEFAULT_CONFIG, enabled: false }, errors: [] });
});

test("getEndpointError only accepts HTTPS or loopback HTTP without credentials", () => {
	assert.equal(getEndpointError("https://api.subq.ai/v1/systemone"), undefined);
	assert.equal(getEndpointError("http://localhost:8080/v1"), undefined);
	assert.ok(getEndpointError("http://example.com/v1"));
	assert.ok(getEndpointError("https://user:pw@example.com/v1"));
	assert.ok(getEndpointError("https://example.com/v1?key=1"));
	assert.ok(getEndpointError("not a url"));
});

test("parseConfigValueReference follows Pi config-value conventions", () => {
	assert.deepEqual(parseConfigValueReference("!powershell.exe -File read.ps1"), { kind: "command", command: "powershell.exe -File read.ps1" });
	assert.deepEqual(parseConfigValueReference("$SUBQ_API_KEY"), { kind: "env", name: "SUBQ_API_KEY" });
	assert.deepEqual(parseConfigValueReference("${SUBQ_API_KEY}"), { kind: "env", name: "SUBQ_API_KEY" });
	assert.deepEqual(parseConfigValueReference("sk-literal"), { kind: "literal", value: "sk-literal" });
});

test("buildDecisionState covers the current run, earlier requests and the latest reasoning", () => {
	const longOutput = `${"a".repeat(400)}MIDDLE${"z".repeat(400)}`;
	const messages: TranscriptMessage[] = [
		user("不要改公开 API"),
		user("old task"),
		...toolTurn("edit", { path: "old.ts" }),
		user("新任务：修 divide"),
		...toolTurn("ffgrep", { pattern: "divide" }),
		...toolTurn("bash", { command: "npm test" }, longOutput, true),
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "测试期望 division by zero，我打算直接改断言" },
				{ type: "thinking", thinking: "secret", redacted: true },
				{ type: "text", text: "测试失败，我来看看原因" },
			],
		},
	];
	const state = buildDecisionState(messages, withReasoning);
	assert.equal(state.request, "新任务：修 divide");
	assert.deepEqual(state.earlierRequests, ["不要改公开 API", "old task"]);
	assert.deepEqual(state.earlierSteps, {});
	assert.deepEqual(
		state.recentSteps.map(({ tool, status }) => [tool, status]),
		[
			["ffgrep", "ok"],
			["bash", "error"],
		],
	);
	assert.ok(!state.recentSteps[1].output.includes("MIDDLE"));
	assert.ok(state.recentSteps[1].output.endsWith("z"));
	assert.equal(state.agentMessage, "测试失败，我来看看原因");
	assert.equal(state.agentReasoning, "测试期望 division by zero，我打算直接改断言");
	assert.equal(buildDecisionState(messages, { sendReasoning: false }).agentReasoning, "");
});

test("extractPlan takes the last plan block in either language and markup", () => {
	assert.equal(extractPlan("先看看。\n\n计划：读 src/math.ts\n然后 npm install zod\n\n其他说明"), "计划：读 src/math.ts\n然后 npm install zod");
	assert.equal(extractPlan("**Plan:** read math.ts, add zod"), "Plan:** read math.ts, add zod");
	assert.equal(extractPlan("- 计划：先跑测试\n\n计划：改 divide 签名并同步调用方"), "计划：改 divide 签名并同步调用方");
	assert.equal(extractPlan("没有计划标记的普通文字"), "");
});

test("buildDecisionState carries the agent's latest written plan, even after later messages", () => {
	const messages: TranscriptMessage[] = [
		user("给 divide 加输入校验"),
		{ role: "assistant", content: [{ type: "text", text: "计划：读 math.ts，然后引入 zod 做校验" }, { type: "toolCall", id: "p1", name: "read", arguments: { path: "src/math.ts" } }] },
		{ role: "toolResult", toolCallId: "p1", toolName: "read", isError: false, content: [{ type: "text", text: "..." }] },
		{ role: "assistant", content: [{ type: "text", text: "文件读完了。" }] },
	];
	const state = buildDecisionState(messages, withReasoning);
	assert.equal(state.agentPlan, "计划：读 math.ts，然后引入 zod 做校验");
	assert.equal(state.agentMessage, "文件读完了。");
});

test("buildDecisionState keeps the tail of long reasoning, where the next step is planned", () => {
	const reasoning = `${"x".repeat(3000)}下一步：安装 zod`;
	const state = buildDecisionState([user("t"), { role: "assistant", content: [{ type: "thinking", thinking: reasoning }] }], withReasoning);
	assert.ok(state.agentReasoning.startsWith("…"));
	assert.ok(state.agentReasoning.endsWith("下一步：安装 zod"));
});

test("buildDecisionState summarises steps older than the recent window", () => {
	const messages = [user("task"), ...Array.from({ length: 13 }, (_, i) => toolTurn(i < 3 ? "read" : "bash", { i })).flat()];
	const state = buildDecisionState(messages, withReasoning);
	assert.deepEqual(state.earlierSteps, { read: 3 });
	assert.equal(state.recentSteps.length, 10);
});

test("decision request asks one yes/no question per card", () => {
	const request = buildDecisionRequest("m", buildDecisionState([user("t")], withReasoning), CARDS) as {
		model: string;
		questions: Record<string, { type: string; criteria: object }>;
	};
	assert.equal(request.model, "m");
	assert.deepEqual(Object.keys(request.questions), CARDS.map((card) => card.id));
	assert.deepEqual(Object.keys(request.questions.halt.criteria), ["yes", "no"]);
	const tooMany = Array.from({ length: MAX_DECISION_QUESTIONS + 1 }, (_, i) => ({ ...CARDS[0], id: `c${i}` }));
	assert.throws(() => buildDecisionRequest("m", buildDecisionState([user("t")], withReasoning), tooMany), /最多 16/);
});

test("parseDecisionResponse requires a yes probability for every card", () => {
	const cards = CARDS.slice(0, 2);
	const answer = (yes: number) => ({ type: "choice", choice: yes >= 0.5 ? "yes" : "no", probabilities: { yes, no: 1 - yes } });
	assert.deepEqual(parseDecisionResponse({ answers: { [cards[0].id]: answer(0.9), [cards[1].id]: answer(0.1) } }, cards), { [cards[0].id]: 0.9, [cards[1].id]: 0.1 });
	assert.throws(() => parseDecisionResponse({ answers: { [cards[0].id]: answer(0.9) } }, cards), new RegExp(cards[1].id));
	assert.throws(() => parseDecisionResponse({}, cards), /answers/);
});

test("selectCards keeps confident cards by score, capped", () => {
	assert.deepEqual(selectCards({ a: 0.6, b: 0.95, c: 0.2, d: 0.7 }, { maxCards: 2, minProbability: 0.6 }), ["b", "d"]);
	assert.deepEqual(selectCards({ a: 0.59 }, { maxCards: 4, minProbability: 0.6 }), []);
});

test("renderGuidance renders selected cards with run-specific extras", () => {
	assert.equal(renderGuidance({ cardIds: [], request: "", assumptions: [], architectureDoc: undefined }), undefined);
	const text =
		renderGuidance({ cardIds: ["delivery", "context", "scope"], request: "修 divide", assumptions: ["金额以分为单位"], architectureDoc: "ARCHITECTURE.md" }) ?? "";
	assert.ok(text.startsWith("<engineering-guidance>\n【交付报告】"));
	for (const fragment of ["金额以分为单位", "【上下文与假设核验】", "ARCHITECTURE.md", "【任务锚点与行动边界】", "「修 divide」"]) {
		assert.ok(text.includes(fragment), fragment);
	}
});

test("assumptions are collected from any tool call in the run", () => {
	const messages = [
		user("old"),
		...toolTurn("write", { content: "// @ASSUMPTION: 旧任务\n" }),
		user("new"),
		...toolTurn("edit", { edits: [{ oldText: "a", newText: "// @ASSUMPTION: 时区固定 UTC\nb" }] }),
		...toolTurn("apply_patch", { patch: "+# @ASSUMPTION: 订单不可部分退款\n" }),
	];
	assert.deepEqual(getRunAssumptions(messages), ["时区固定 UTC", "订单不可部分退款"]);
	assert.deepEqual(extractAssumptions("/* @ASSUMPTION: x */"), ["x"]);
});
