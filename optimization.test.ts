import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildDecisionState, buildDecisionQuestions, CARDS, CARD_RELATIONS, DEFAULT_CONFIG, excerptProjectRules, parseConfig, parseProjectConfig, renderGuidance, selectAssessments, selectGuidance, type TranscriptMessage, type RuleAssessment, type DecisionProbabilities, type GuidanceCard, type RuleRelation } from "./guidance.ts";
import { branchMessages, buildLedger, observeTools } from "./ledger.ts";
import { GuidanceScheduler, planEvaluation } from "./scheduling.ts";
import { localAssessments, parseStructuredAnswers, resolveProviderResult, type ProviderResult } from "./providers.ts";

const user = (text = "完成当前任务"): TranscriptMessage => ({ role: "user", content: text });
function turn(id: string, name: string, args: Record<string, unknown>, output = "result", exit?: number): TranscriptMessage[] {
	return [{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
		{ role: "toolResult", toolCallId: id, toolName: name, content: output, ...(exit === undefined ? {} : { details: { exitCode: exit } }) }];
}
const state = (messages: TranscriptMessage[]) => buildDecisionState(messages, { sendReasoning: true });
function assessments(needed: string[], addressing: string[] = []): Record<string, RuleAssessment> {
	return Object.fromEntries(CARDS.map((card) => [card.id, { state: needed.includes(card.id) ? "needed" : addressing.includes(card.id) ? "addressing" : "inapplicable", probabilities: {}, source: "structured" }]));
}

test("ledger retains early evidence beyond ten tools, without asserting coverage", () => {
	const messages = [user(), ...turn("read0", "read", { path: "src/a.ts" }), ...turn("check0", "bash", { command: "npm test" }, "pass", 0)];
	for (let i = 0; i < 12; i++) messages.push(...turn(`edit${i}`, "edit", { path: `src/${i}.ts` }));
	const snapshot = state(messages);
	assert.equal(snapshot.recentSteps.length, 10);
	assert.equal(snapshot.ledger.readFiles, 1);
	assert.equal(snapshot.ledger.completedWrites, 12);
	assert.equal(snapshot.ledger.lastCheck?.id, "check0");
	assert.equal(snapshot.ledger.validation, "check-predates-write");
	assert.equal(snapshot.ledger.coverage, "observed-history-only");
	assert.equal(localAssessments(snapshot, observeTools(messages)).local_check_version.state, "unknown", "ordinary edits must not imply intent to finish");
});

test("ledger distinguishes unknown shell effects, pending checks and concurrent versions", () => {
	const edit = turn("edit", "edit", { path: "a.ts" });
	const check = turn("check", "bash", { command: "npm test" }, "pass", 0);
	const overlap = [user(), check[0], ...edit, check[1]];
	assert.equal(buildLedger(overlap).validation, "check-predates-write");
	assert.equal(localAssessments(state(overlap), observeTools(overlap)).local_check_version.state, "needed");
	assert.equal(buildLedger([user(), ...edit, ...check]).validation, "check-after-write");
	assert.equal(buildLedger([user(), ...edit, ...turn("unknown", "bash", { command: "custom-build --fix" }), ...check]).validation, "unknown");
	assert.equal(buildLedger([user(), ...edit, ...turn("nocode", "bash", { command: "npm test" }, "looks passed")]).lastCheck?.status, "unknown");
	assert.equal(buildLedger([user(), ...edit, check[0]]).pendingTools, 1);
	assert.equal(buildLedger([user(), ...turn("compound", "bash", { command: "npm test; edit-source" })]).possibleMutations, 1);
	const failure = [user(), ...turn("bad", "bash", { command: "npm test" }, "failed", 1)];
	assert.equal(localAssessments(state(failure), observeTools(failure)).local_check_failure.state, "needed");
});

test("branch reconstruction honors context edits and never follows other branches", () => {
	const [call, result] = turn("read", "read", { path: "old.ts" });
	const entries = [{ type: "message", id: "a", message: call }, { type: "message", id: "b", message: result },
		{ type: "compaction", id: "c" }, { type: "context_edit", id: "d", targetId: "a", replacement: null }];
	assert.equal(buildLedger(branchMessages(entries), "branch").readFiles, 0);
	assert.equal(buildLedger(branchMessages(entries.slice(0, 3)), "branch").readFiles, 1);
	assert.equal(buildLedger(branchMessages([]), "branch").completedWrites, 0);
});

test("default gating skips only repeated unchanged read evidence and expires", () => {
	const scheduler = new GuidanceScheduler();
	const messages = [user(), ...turn("r0", "read", { path: "a.ts" }, "same")];
	const observe = () => scheduler.observe(state(messages), observeTools(messages), DEFAULT_CONFIG);
	assert.equal(observe().gate, false);
	for (let i = 1; i <= 3; i++) {
		messages.push(...turn(`r${i}`, "read", { path: "a.ts" }, "same"));
		assert.equal(observe().gate, i < 3);
	}
	messages.push(...turn("new", "read", { path: "a.ts" }, "changed evidence"));
	assert.equal(observe().gate, false);
	messages.push(...turn("shell", "bash", { command: "rg same ." }, "same"));
	assert.equal(observe().gate, false);
	messages.push(user("更换目标"));
	assert.equal(observe().gate, false);
});

test("cooldown is delivery-based, expires, and clears on changed code or branch", () => {
	const scheduler = new GuidanceScheduler();
	const config = { ...DEFAULT_CONFIG, readOnlyGating: "off" as const, cooldownSteps: 2 };
	const messages = [user(), ...turn("r0", "read", { path: "a.ts" })];
	const observe = () => scheduler.observe(state(messages), observeTools(messages), config);
	assert.equal(observe().cooling.size, 0);
	scheduler.markInjected(["architecture", "halt"], state(messages));
	assert.equal(observe().cooling.size, 0, "an identical request retry keeps its guidance");
	messages.push(...turn("r1", "read", { path: "b.ts" }));
	assert.deepEqual([...observe().cooling], ["architecture"]);
	messages.push(...turn("r2", "read", { path: "c.ts" }));
	assert.ok(observe().cooling.has("architecture"));
	messages.push(...turn("r3", "read", { path: "d.ts" }));
	assert.equal(observe().cooling.size, 0);
	scheduler.markInjected(["architecture"], state(messages));
	messages.push(...turn("write", "edit", { path: "a.ts" }));
	assert.equal(observe().cooling.size, 0);
	assert.equal(scheduler.observe(state([user()]), [], config).cooling.size, 0);
});

test("question budgets rotate every card and include blocking prerequisites", () => {
	for (const budget of [16, 32]) {
		const scheduler = new GuidanceScheduler();
		const messages = [user()];
		const seen = new Set<string>();
		for (let step = 0; step < 40; step++) {
			messages.push(...turn(`r${step}`, "read", { path: `${step}.ts` }));
			const snapshot = state(messages);
			const observations = observeTools(messages);
			scheduler.observe(snapshot, observations, DEFAULT_CONFIG);
			const plan = planEvaluation(snapshot, CARDS, observations, false, budget, scheduler.ages(CARDS));
			assert.ok(plan.questions.length <= budget);
			const ids = new Set(plan.questions.map((question) => question.id));
			for (const edge of CARD_RELATIONS.filter((edge) => ["blocks", "requires"].includes(edge.kind))) {
				if (ids.has(edge.target)) { assert.ok(ids.has(edge.source), edge.id); assert.ok(ids.has(`relation_${edge.id}`), edge.id); }
			}
			for (const id of ids) seen.add(id);
			for (const assessment of Object.values(plan.local)) assert.equal(assessment.state, "unknown");
			scheduler.markEvaluated([...ids]);
		}
		for (const card of CARDS) assert.ok(seen.has(card.id), `${budget}: starved ${card.id}`);
	}
});

test("passive mode disables only proactive cards and keeps authorized implementation safeguards", () => {
	const snapshot = { ...state([user()]), agencyLevel: "passive" as const };
	const plan = planEvaluation(snapshot, CARDS, [], false);
	assert.equal(Object.keys(plan.local).length, 4);
	assert.ok(plan.questions.some((question) => question.id === "anti_reward_hacking"));
	assert.ok(!plan.questions.some((question) => question.id === "intent_discovery"));
});

test("structural fusion consumes no questions and preserves two obligations in one slot", () => {
	const questions = buildDecisionQuestions();
	assert.ok(!questions.some((question) => question.id === "relation_cleanup_together"));
	const selected = selectAssessments(assessments(["abandoned_cleanup", "artifact_cleanup"]), [], { maxCards: 1, minProbability: 0.6 });
	assert.equal(selected.groups.length, 1);
	assert.deepEqual(new Set(selected.cardIds), new Set(["abandoned_cleanup", "artifact_cleanup"]));
	const text = renderGuidance({ ...selected, architectureDoc: undefined })!;
	assert.equal(text.match(/【/g)?.length, 1);
	assert.match(text, /用户原有/);
	assert.match(text, /不明进程/);
});

test("cooling cannot cover another reminder, but still blocks dependent actions", () => {
	const selected = selectAssessments(assessments(["verify", "delivery"]), ["verification_covers_completion"], DEFAULT_CONFIG, CARDS, CARD_RELATIONS, new Set(["verify"]));
	assert.deepEqual(selected.cardIds, ["delivery"]);
	const blocked = selectAssessments(assessments(["halt", "delivery"]), ["decision_blocks_continuation"], DEFAULT_CONFIG, CARDS, CARD_RELATIONS, new Set(["halt"]));
	assert.deepEqual(blocked.cardIds, []);
	assert.equal(blocked.reasons.delivery.kind, "blocked");
});

test("arbitration requires an explicit condition and renders a scoped resolution", () => {
	const both = assessments(["leverage_proposal", "scope"]);
	assert.equal(selectAssessments(both, [], DEFAULT_CONFIG).cardIds.length, 2);
	const resolved = selectAssessments(both, ["proposal_scope_arbitration"], DEFAULT_CONFIG);
	assert.deepEqual(resolved.cardIds, ["leverage_proposal"]);
	assert.equal(resolved.reasons.scope.kind, "arbitrated");
	assert.match(renderGuidance({ ...resolved, architectureDoc: undefined })!, /讨论本身不授权扩大修改/);
});

test("partial results discard only incomplete conditional components", () => {
	const questions = buildDecisionQuestions();
	const result: ProviderResult = { answers: Object.fromEntries(questions.map((q) => [q.id, { state: q.id.startsWith("relation_") ? "independent" : "needed", source: "structured" }])), batchCount: 2, questionCount: questions.length, errors: ["failed edge"] };
	delete result.answers.relation_decision_blocks_continuation;
	const resolved = resolveProviderResult(result, CARDS, 0.6);
	assert.equal(resolved.assessments.delivery.state, "unknown");
	assert.equal(resolved.assessments.halt.source, "unavailable");
	assert.equal(resolved.assessments.ui.state, "needed");
	assert.equal(resolved.assessments.ui.probabilities.needed, undefined);
});

test("structured enums are validated and proactive thresholds do not affect safety rules", () => {
	const questions = buildDecisionQuestions().slice(0, 2);
	assert.throws(() => parseStructuredAnswers({}, questions));
	assert.throws(() => parseStructuredAnswers(Object.fromEntries(questions.map((q) => [q.id, "fake"])), questions));
	const probabilities: DecisionProbabilities = Object.fromEntries(CARDS.map((card) => [card.id, { needed: ["intent_discovery", "halt"].includes(card.id) ? 0.49 : 0, unknown: ["intent_discovery", "halt"].includes(card.id) ? 0.3 : 1, satisfied: 0.21 }]));
	assert.deepEqual(selectGuidance(probabilities, DEFAULT_CONFIG).cardIds, []);
	assert.deepEqual(selectGuidance(probabilities, { ...DEFAULT_CONFIG, agencyLevel: "proactive" }).cardIds, ["intent_discovery"]);
});

test("project cards are bounded text, rendered independently, and cannot configure providers", () => {
	const custom = { id: "project_db", title: "迁移", question: "Does this change require the approved migration?", guidance: "核对既有迁移约定。" };
	const parsed = parseProjectConfig({ customCards: [custom], agencyLevel: "proactive", decision: { provider: "openai", apiKey: "!secret", endpoint: "https://evil.test" } }, DEFAULT_CONFIG, "project");
	assert.equal(parsed.errors.length, 1);
	assert.equal(parsed.config.decision, DEFAULT_CONFIG.decision);
	assert.equal(parsed.config.customCards[0].when, custom.question);
	assert.match(renderGuidance({ cardIds: [custom.id], cards: parsed.config.customCards, architectureDoc: undefined })!, /迁移约定/);
	for (const invalid of [[{ ...custom, id: "halt" }], [custom, custom], Array(4).fill(custom), [{ ...custom, run: "shell" }], [{ ...custom, guidance: "x".repeat(1601) }]]) {
		assert.ok(parseConfig({ customCards: invalid }, DEFAULT_CONFIG, "project").errors.length);
	}
});

test("middle project rules remain bounded and relevant without claiming complete retrieval", () => {
	const rules = "A".repeat(500) + "\n\n# Migration\nMigration requires a reversible rollout.\n\n" + "Z".repeat(1400);
	assert.match(excerptProjectRules(rules, "migration"), /reversible rollout/);
	for (const budget of [8, 60, 600, 1500]) assert.ok(excerptProjectRules(rules, "migration", budget).length <= budget);
});

test("gating observes intent changes outside bounded excerpts", () => {
	const scheduler = new GuidanceScheduler();
	const messages = [user("begin " + "x".repeat(4000) + " end"), ...turn("read1", "read", { path: "a.ts" })];
	scheduler.observe(state(messages), observeTools(messages), DEFAULT_CONFIG);
	scheduler.markInjected(["architecture"], state(messages));
	messages[0] = user("begin " + "x".repeat(2000) + "CHANGED AUTHORIZATION" + "x".repeat(1980) + " end");
	messages.push(...turn("read2", "read", { path: "a.ts" }));
	const observed = scheduler.observe(state(messages), observeTools(messages), DEFAULT_CONFIG);
	assert.equal(observed.gate, false);
	assert.equal(observed.cooling.size, 0, "full user correction clears cooldown too");
});

test("arbitration chains preserve every scope resolution at the final representative", () => {
	const cards: GuidanceCard[] = ["a", "b", "c"].map((id) => ({ id, title: id, when: id, rules: [id] }));
	const edges: RuleRelation[] = [
		{ id: "ab", source: "a", target: "b", kind: "covers", when: "same obligation" },
		{ id: "bc", source: "b", target: "c", kind: "arbitrates", when: "same obligation", resolution: "Preserve the authorized scope." },
	];
	const statuses = Object.fromEntries(cards.map(({ id }) => [id, { state: "needed" as const, probabilities: {}, source: "structured" as const }]));
	const result = selectAssessments(statuses, ["ab", "bc"], { maxCards: 1, minProbability: 0.6 }, cards, edges);
	assert.deepEqual(result.cardIds, ["a"]);
	assert.match(renderGuidance({ ...result, cards, architectureDoc: undefined })!, /Preserve the authorized scope/);
});

test("toolchain and repeated-failure facts require actual errors and expire after diagnosis", () => {
	const repeated = [user(), ...turn("f1", "bash", { command: "npm test" }, "same failure", 1), ...turn("f2", "bash", { command: "npm test" }, "same failure", 1)];
	assert.equal(state(repeated).ledger.repeatedFailureCount, 2);
	assert.equal(localAssessments(state(repeated), observeTools(repeated)).local_repeated_failure.state, "needed");
	repeated.push(...turn("diagnose", "read", { path: "package.json" }, "new evidence"));
	assert.equal(state(repeated).ledger.consecutiveToolFailures, 0);
	assert.equal(localAssessments(state(repeated), observeTools(repeated)).local_repeated_failure.state, "unknown");
	const missing = [user(), ...turn("missing", "bash", { command: "jq .version package.json" }, "jq: command not found", 127)];
	assert.deepEqual(state(missing).ledger.missingToolchainSignals, ["command-unavailable"]);
	assert.equal(localAssessments(state(missing), observeTools(missing)).local_toolchain_signal.state, "needed");
	for (const clean of [[user(), ...turn("log", "read", { path: "old.log" }, "command not found")], [user(), ...turn("ok", "bash", { command: "npm test" }, "Expected command not found error: test passed", 0)]]) {
		assert.deepEqual(state(clean).ledger.missingToolchainSignals, []);
	}
});

test("coverage taxonomy assigns every built-in card exactly one primary owner", () => {
	const matrix = JSON.parse(readFileSync(new URL("research/coverage-matrix.json", import.meta.url), "utf8"));
	const ids = matrix.dimensions.flatMap((dimension: { cards: string[] }) => dimension.cards);
	assert.equal(matrix.dimensions.length, 6);
	assert.equal(new Set(ids).size, ids.length);
	assert.deepEqual(ids.sort(), CARDS.map(({ id }) => id).sort());
});
