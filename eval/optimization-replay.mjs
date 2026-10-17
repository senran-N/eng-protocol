// Deterministic scheduler workload: no HTTP, no paid model, no latency/cost claim.
import { writeFileSync } from "node:fs";
import { CARDS, DEFAULT_CONFIG, buildDecisionState } from "../guidance.ts";
import { GuidanceScheduler, planEvaluation } from "../scheduling.ts";
import { observeTools } from "../ledger.ts";

const rows = [];
for (const workload of ["identical-reads", "changing-reads"]) {
	for (const maxQuestions of [16, 32, 0]) {
		for (const readOnlyGating of ["duplicates", "bounded", "off"]) {
			const scheduler = new GuidanceScheduler();
			const messages = [{ role: "user", content: "Investigate the parser; do not edit yet." }];
			const config = { ...DEFAULT_CONFIG, maxQuestions, readOnlyGating };
			const row = { workload, maxQuestions, readOnlyGating, contexts: 30, evaluated: 0, gated: 0, requests: 0, questions: 0, maxRequestQuestions: 0, uniqueAssessedCards: 0 };
			const seen = new Set();
			for (let i = 0; i < row.contexts; i++) {
				const id = `read-${i}`;
				messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "parser.ts" } }] }, { role: "toolResult", toolCallId: id, toolName: "read", content: workload === "identical-reads" ? "same content" : `revision ${i}` });
				const state = buildDecisionState(messages, config);
				const observations = observeTools(messages);
				if (scheduler.observe(state, observations, config).gate) { row.gated++; continue; }
				const plan = planEvaluation(state, CARDS, observations, config.localPrefilter, maxQuestions, scheduler.ages(CARDS));
				row.evaluated++; row.requests += Math.ceil(plan.questions.length / 16); row.questions += plan.questions.length;
				row.maxRequestQuestions = Math.max(row.maxRequestQuestions, plan.questions.length);
				for (const card of CARDS) if (plan.questions.some(({ id }) => id === card.id)) seen.add(card.id);
				scheduler.markEvaluated(plan.questions.map(({ id }) => id));
			}
			row.uniqueAssessedCards = seen.size;
			rows.push(row);
		}
	}
}
const report = { date: "2026-10-17", kind: "deterministic-scheduler-replay", assumptions: "Every scheduled answer succeeds. No model inference, wire latency, token usage or billable cost is measured. Unique coverage excludes conservatively prefiltered cards. Bounded mode may delay reacting to new read evidence.", originalBaseline: { contexts: 30, questionsPerContext: 32, requests: 60, questions: 960 }, rows };
writeFileSync(new URL("results-optimization-20261017.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(rows.filter((row) => row.maxQuestions === 16 && row.readOnlyGating === "duplicates"), null, 2));
