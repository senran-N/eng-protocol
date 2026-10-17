import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	buildDecisionRequest,
	buildDecisionQuestions,
	batchDecisionQuestions,
	buildDecisionState,
	CARDS,
	DEFAULT_CONFIG,
	MAX_DECISION_QUESTIONS,
	extractPlan,
	getEndpointError,
	parseConfig,
	parseConfigValueReference,
	parseDecisionResponse,
	parseProjectConfig,
	renderGuidance,
	selectCards,
	selectGuidance,
	validateRuleGraph,
	CARD_RELATIONS,
	RULE_STATES,
	type DecisionProbabilities,
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

test("research-backed cards resolve to scoped primary evidence without leaking audit metadata into prompts", () => {
	const evidence = JSON.parse(readFileSync(new URL("./research/model-failures-2026.json", import.meta.url), "utf8"));
	for (const card of CARDS) {
		for (const sourceId of card.evidence ?? []) {
			const source = evidence.sources[sourceId];
			assert.ok(source, `${card.id}: unknown evidence ${sourceId}`);
			assert.equal(new URL(source.url).protocol, "https:");
			assert.ok(source.models.length && source.limit && source.kind, sourceId);
		}
	}
	for (const id of ["verification_budget", "trust_boundary", "evidence_provenance", "progress_visibility"]) {
		assert.ok(CARDS.find((card) => card.id === id)?.evidence?.length, id);
	}
	const request = JSON.stringify(buildDecisionRequest("model", buildDecisionState([], withReasoning), buildDecisionQuestions().slice(0, 16)));
	assert.ok(!request.includes("astra_prompt_audit"));
	assert.ok(!request.includes("model-failures-2026"));
});

test("expanded card library and relation questions are unique and each batch fits the API", () => {
	assert.equal(new Set(CARDS.map((card) => card.id)).size, CARDS.length);
	assert.ok(CARDS.length > MAX_DECISION_QUESTIONS);
	const questions = buildDecisionQuestions();
	const batches = batchDecisionQuestions(questions);
	assert.deepEqual(batches.flat(), questions, "every card and relation is evaluated exactly once");
	assert.equal(questions.length, CARDS.length + CARD_RELATIONS.filter((edge) => edge.evaluation !== "structural").length);
	assert.ok(batches.every((batch) => batch.length > 0 && batch.length <= 16));
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

test("buildDecisionState preserves evidence across user messages with explicit ordering", () => {
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
	assert.deepEqual(state.earlierRequests, [{ messageIndex: 0, text: "不要改公开 API" }, { messageIndex: 1, text: "old task" }]);
	assert.equal(state.omittedSteps, 0);
	assert.deepEqual(
		state.recentSteps.map(({ tool, status }) => [tool, status]),
		[
			["edit", "ok"],
			["ffgrep", "ok"],
			["bash", "error"],
		],
	);
	assert.ok(state.recentSteps[0].messageIndex < state.requestIndex);
	assert.ok(state.recentSteps[1].messageIndex > state.requestIndex);
	assert.ok(!state.recentSteps[2].output.includes("MIDDLE"));
	assert.ok(state.recentSteps[2].output.endsWith("z"));
	assert.equal(state.agentMessage?.text, "测试失败，我来看看原因");
	assert.equal(state.agentReasoning?.text, "测试期望 division by zero，我打算直接改断言");
	assert.equal(buildDecisionState(messages, { sendReasoning: false }).agentReasoning, undefined);
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
	assert.equal(state.agentPlan?.text, "计划：读 math.ts，然后引入 zod 做校验");
	assert.equal(state.agentMessage?.text, "文件读完了。");
	assert.ok(state.agentPlan!.messageIndex < state.recentSteps[0].resultIndex!);
	assert.ok(state.agentPlan!.messageIndex < state.agentMessage!.messageIndex);
});

test("buildDecisionState keeps the tail of long reasoning, where the next step is planned", () => {
	const reasoning = `${"x".repeat(3000)}下一步：安装 zod`;
	const state = buildDecisionState([user("t"), { role: "assistant", content: [{ type: "thinking", thinking: reasoning }] }], withReasoning);
	assert.ok(state.agentReasoning?.text.startsWith("…"));
	assert.ok(state.agentReasoning?.text.endsWith("下一步：安装 zod"));
});

test("buildDecisionState summarises steps older than the recent window", () => {
	const messages = [user("task"), ...Array.from({ length: 13 }, (_, i) => toolTurn(i < 3 ? "read" : "bash", { i })).flat()];
	const state = buildDecisionState(messages, withReasoning);
	assert.equal(state.omittedSteps, 3);
	assert.equal(state.recentSteps.length, 10);
});

test("decision requests distinguish current rule states and include relation conditions within the question limit", () => {
	const questions = buildDecisionQuestions();
	const batch = batchDecisionQuestions(questions)[0];
	const request = buildDecisionRequest("m", buildDecisionState([user("t")], withReasoning), batch) as {
		model: string;
		questions: Record<string, { type: string; criteria: object }>;
	};
	assert.equal(request.model, "m");
	assert.deepEqual(Object.keys(request.questions), batch.map((question) => question.id));
	assert.deepEqual(Object.keys(request.questions.halt.criteria), ["needed", "addressing", "satisfied", "inapplicable", "unknown"]);
	const tooMany = Array.from({ length: MAX_DECISION_QUESTIONS + 1 }, (_, i) => ({ ...batch[0], id: `c${i}` }));
	assert.throws(() => buildDecisionRequest("m", buildDecisionState([user("t")], withReasoning), tooMany), /最多 16/);
	assert.throws(() => buildDecisionRequest("m", buildDecisionState([user("t")], withReasoning), []), /1 至/);
});

test("malformed or missing state distributions fail the decision instead of becoming negative scores", () => {
	const questions = buildDecisionQuestions(CARDS.slice(0, 2), []);
	const probabilities = { needed: 0.9, addressing: 0.025, satisfied: 0.025, inapplicable: 0.025, unknown: 0.025 };
	const answer = { probabilities };
	assert.deepEqual(parseDecisionResponse({ answers: Object.fromEntries(questions.map(({ id }) => [id, answer])) }, questions), Object.fromEntries(questions.map(({ id }) => [id, probabilities])));
	assert.throws(() => parseDecisionResponse({ answers: { [questions[0].id]: answer } }, questions), new RegExp(questions[1].id));
	for (const invalid of [{ needed: 1 }, { ...probabilities, unknown: -1 }, { ...probabilities, needed: NaN }, { ...probabilities, needed: 0.5 }, { ...probabilities, no: 0 }]) {
		assert.throws(() => parseDecisionResponse({ answers: { [questions[0].id]: { probabilities: invalid } } }, questions.slice(0, 1)), /决策响应/);
	}
	assert.throws(() => parseDecisionResponse({}, questions), /answers/);
});

test("selectCards keeps confident cards by score, capped", () => {
	assert.deepEqual(selectCards({ a: 0.6, b: 0.95, c: 0.2, d: 0.7 }, { maxCards: 2, minProbability: 0.6 }), ["b", "d"]);
	assert.deepEqual(selectCards({ a: 0.59 }, { maxCards: 4, minProbability: 0.6 }), []);
});

test("renderGuidance renders selected cards and the available architecture path", () => {
	assert.equal(renderGuidance({ cardIds: [], architectureDoc: undefined }), undefined);
	const text =
		renderGuidance({ cardIds: ["delivery", "context", "scope"], architectureDoc: "ARCHITECTURE.md" }) ?? "";
	assert.ok(text.startsWith("<engineering-guidance>"));
	for (const fragment of ["【完成已授权工作】", "【上下文与假设核验】", "ARCHITECTURE.md", "【任务锚点与行动边界】"]) {
		assert.ok(text.includes(fragment), fragment);
	}
});

function judgments(states: Record<string, string>, applied: string[] = []): DecisionProbabilities {
	return Object.fromEntries(buildDecisionQuestions().map(({ id, criteria }) => [id, Object.fromEntries(Object.keys(criteria).map((option) => {
		const winner = id.startsWith("relation_") ? (applied.includes(id.slice(9)) ? "applies" : "independent") : states[id] ?? "inapplicable";
		return [option, option === winner ? 0.96 : 0.04 / (Object.keys(criteria).length - 1)];
	}))]));
}
const policy = { minProbability: 0.6, maxCards: 3 };

test("only needed rules are injected; ongoing, satisfied and uncertain obligations remain visible", () => {
	const result = selectGuidance(judgments({ context: "addressing", verify: "satisfied", halt: "unknown", research: "needed" }), policy);
	assert.deepEqual(result.cardIds, ["research"]);
	assert.equal(result.assessments.context.state, "addressing");
	assert.equal(result.assessments.verify.state, "satisfied");
	assert.equal(result.assessments.halt.state, "unknown");
	const uncertain = judgments({});
	uncertain.context = Object.fromEntries(RULE_STATES.map((state) => [state, 0.2]));
	assert.equal(selectGuidance(uncertain, policy).assessments.context.state, "unknown");
});

test("validation covers completion only for the same obligation and before the injection cap", () => {
	const input = judgments({ verify: "needed", delivery: "needed", reporting: "needed" }, ["verification_covers_completion", "verification_covers_report"]);
	input.verify = { needed: 0.65, addressing: 0.1, satisfied: 0.1, inapplicable: 0.1, unknown: 0.05 };
	const result = selectGuidance(input, { ...policy, maxCards: 1 });
	assert.deepEqual(result.cardIds, ["verify"], "the concrete correction outranks duplicate higher scores");
	assert.deepEqual(result.reasons.delivery, { kind: "covered", by: "verify" });
	const separate = selectGuidance(judgments({ verify: "needed", delivery: "needed" }), policy);
	assert.deepEqual(new Set(separate.cardIds), new Set(["verify", "delivery"]), "a separate unfinished feature is not suppressed");
	const coveredButNotNeeded = selectGuidance(judgments({ verify: "satisfied", delivery: "needed" }, ["verification_covers_completion"]), policy);
	assert.deepEqual(coveredButNotNeeded.cardIds, ["delivery"], "a non-selected source cannot erase a needed target");
});

test("a real pending user decision blocks only dependent work, even while the agent is already asking", () => {
	const applied = ["decision_blocks_continuation"];
	const blocked = selectGuidance(judgments({ halt: "addressing", delivery: "needed" }, applied), policy);
	assert.deepEqual(blocked.cardIds, []);
	assert.deepEqual(blocked.reasons.delivery, { kind: "blocked", by: "halt" });
	assert.deepEqual(selectGuidance(judgments({ halt: "satisfied", delivery: "needed" }, applied), policy).cardIds, ["delivery"]);
	assert.deepEqual(selectGuidance(judgments({ halt: "addressing", delivery: "needed" }), policy).cardIds, ["delivery"], "independently authorized work continues");
});

test("unresolved contradictory acceptance requirements defer only their dependent verification", () => {
	const result = selectGuidance(judgments({ no_cheat: "needed", verify: "needed" }, ["contract_before_acceptance"]), policy);
	assert.deepEqual(result.cardIds, ["no_cheat"]);
	assert.deepEqual(result.reasons.verify, { kind: "prerequisite", by: "no_cheat" });
	const uncertain = judgments({ no_cheat: "needed", verify: "needed" });
	uncertain.relation_contract_before_acceptance = { applies: 0.4, independent: 0.3, unknown: 0.3 };
	assert.equal(selectGuidance(uncertain, policy).cardIds.length, 2, "unknown relations cannot suppress a rule");
});

test("invalid graph references and cycles are rejected before requests", () => {
	assert.throws(() => validateRuleGraph(CARDS, [{ ...CARD_RELATIONS[0], target: "absent" }]), /引用/);
	assert.throws(() => validateRuleGraph(CARDS, [CARD_RELATIONS[0], { ...CARD_RELATIONS[0], id: "reverse", source: "delivery", target: "verify" }]), /循环/);
});

test("new evidence invalidates the snapshot cache even when the changed text is truncated", () => {
	const before = [user("验证"), ...toolTurn("edit", { text: "a".repeat(800) + "old" + "z".repeat(800) })];
	const after = structuredClone(before);
	(after[1].content as { arguments: { text: string } }[])[0].arguments.text = "a".repeat(800) + "new" + "z".repeat(800);
	const a = buildDecisionState(before, withReasoning);
	const b = buildDecisionState(after, withReasoning);
	assert.equal(a.recentSteps[0].input, b.recentSteps[0].input);
	assert.notEqual(a.evidenceRevision, b.evidenceRevision);
	assert.equal(a.evidenceRevision, buildDecisionState(before, withReasoning).evidenceRevision);
});

test("short continuations retain the original constraints and tool evidence", () => {
	const messages = [
		user("修复缓存，全程不要改公开 API"),
		...toolTurn("read", { path: "cache.ts" }),
		user("继续定位"), user("现在修复"), user("继续"),
	];
	const state = buildDecisionState(messages, withReasoning);
	assert.equal(state.request, "继续");
	assert.equal(state.earlierRequests[0].text, "修复缓存，全程不要改公开 API");
	assert.equal(state.omittedRequests, 0);
	assert.equal(state.recentSteps[0].tool, "read");
});

test("new user instructions are distinguishable from an earlier plan and completed actions", () => {
	const messages = [user("安装依赖"), { role: "assistant", content: "计划：安装 zod" }, ...toolTurn("bash", { command: "npm install zod" }), user("停止安装，改为只解释方案")];
	const state = buildDecisionState(messages, withReasoning);
	assert.equal(state.request, "停止安装，改为只解释方案");
	assert.ok(state.agentPlan!.messageIndex < state.requestIndex);
	assert.ok(state.recentSteps[0].resultIndex! < state.requestIndex);
});

test("context budgets bound long and tiny histories while retaining text boundaries", () => {
	const state = buildDecisionState([...Array.from({ length: 1000 }, () => user("x")), user(`START${"x".repeat(4000)}END`), ...toolTurn("edit", { text: "x".repeat(4000), path: "important.ts" })], withReasoning);
	assert.ok(state.earlierRequests.length < 100);
	assert.ok(state.omittedRequests > 0);
	assert.ok(state.request.length <= 2000);
	assert.ok(state.request.startsWith("START"));
	assert.ok(state.request.endsWith("END"));
	assert.ok(state.recentSteps[0].input.includes("important.ts"));
	assert.ok(state.recentSteps[0].input.length <= 600);
	const longHistory = buildDecisionState(Array.from({ length: 10 }, (_, i) => user(`${i}${"x".repeat(2000)}`)), withReasoning);
	assert.ok(longHistory.earlierRequests.reduce((n, entry) => n + entry.text.length + 40, 0) <= 3000);
});

test("pending calls, absent user text and project guidance remain explicit", () => {
	const state = buildDecisionState([{ role: "assistant", content: [{ type: "toolCall", id: "pending", name: "bash", arguments: { command: "npm test" } }] }], { sendReasoning: false, projectRules: "使用项目既有组件" });
	assert.equal(state.requestIndex, -1);
	assert.equal(state.request, "");
	assert.equal(state.omittedRequests, 0);
	assert.equal(state.recentSteps[0].status, "pending");
	assert.equal(state.recentSteps[0].resultIndex, undefined);
	assert.equal(state.projectRules, "使用项目既有组件");
});
