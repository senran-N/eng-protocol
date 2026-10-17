// Evaluates the actual candidate budget/providers. Calls only the configured decision service.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentCaseDocument } from "./agent-cases.mjs";
import { experimentMetadata } from "./experiment.mjs";
import { CARDS, DEFAULT_CONFIG, buildDecisionState, parseConfig, selectAssessments } from "../guidance.ts";
import { resolveDecisionSource } from "../index.ts";
import { getDecisionProvider, resolveProviderResult, localAssessments, LOCAL_CARDS } from "../providers.ts";
import { observeTools, digest } from "../ledger.ts";
import { planEvaluation } from "../scheduling.ts";
import { closeDecisionClient } from "../decision.ts";

const path = join(homedir(), ".pi", "agent", "eng-protocol.json");
const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
const overrides = { ...raw, ...(process.env.MAX_QUESTIONS === undefined ? {} : { maxQuestions: Number(process.env.MAX_QUESTIONS) }), ...(process.env.AGENCY_LEVEL ? { agencyLevel: process.env.AGENCY_LEVEL } : {}) };
const { config, errors } = parseConfig(overrides, DEFAULT_CONFIG, path);
if (errors.length) throw new Error("Invalid evaluation configuration");
const source = await resolveDecisionSource(config.decision);
if ("error" in source) throw new Error(source.error);
const document = process.env.CASE_FILE ? JSON.parse(readFileSync(process.env.CASE_FILE, "utf8")) : agentCaseDocument;
const cases = document.cases.filter(({ id }) => !process.env.CASE_IDS || process.env.CASE_IDS.split(",").includes(id));
if (!cases.length || new Set(cases.map(({ id }) => id)).size !== cases.length) throw new Error("No matching or duplicate cases");
const cards = [...CARDS, ...config.customCards];
const rows = [];
try {
	for (const scenario of cases) {
		const state = { ...buildDecisionState(scenario.messages, config), agencyLevel: config.agencyLevel };
		const observations = observeTools(scenario.messages);
		const plan = planEvaluation(state, cards, observations, config.localPrefilter, config.maxQuestions);
		const start = performance.now();
		try {
			let resolved, result;
			if (source.provider === "local") {
				result = { batchCount: 0, questionCount: 0, errors: [] };
				resolved = { assessments: Object.fromEntries(cards.map((card) => [card.id, { state: "unknown", probabilities: {}, source: "unavailable" }])), activeRelations: [] };
				Object.assign(resolved.assessments, localAssessments(state, observations));
			} else {
				result = await getDecisionProvider(source).evaluate(source, state, plan.questions, AbortSignal.timeout(config.decision.timeoutMs));
				resolved = resolveProviderResult(result, cards, config.minProbability, plan.local, config);
			}
			const selection = selectAssessments(resolved.assessments, resolved.activeRelations, config, source.provider === "local" ? [...cards, ...LOCAL_CARDS] : cards);
			const pass = result.errors.length === 0 && (!scenario.none || !selection.cardIds.length) && (scenario.include ?? []).every((id) => selection.cardIds.includes(id)) && (scenario.exclude ?? []).every((id) => !selection.cardIds.includes(id));
			rows.push({ case: scenario.id, pass, selected: selection.cardIds, phase: plan.phase, deferred: Object.entries(plan.local).filter(([, item]) => item.source === "deferred").map(([id]) => id), assessments: resolved.assessments, activeRelations: selection.activeRelations, requests: result.batchCount, questions: result.questionCount, errors: result.errors, latencyMs: Math.round(performance.now() - start) });
		} catch (error) { rows.push({ case: scenario.id, pass: false, error: error.message, latencyMs: Math.round(performance.now() - start) }); }
	}
	console.log(JSON.stringify({ experiment: experimentMetadata(), maxQuestions: config.maxQuestions, agencyLevel: config.agencyLevel, caseHash: digest(cases), note: "Each case is a fresh snapshot; no warm-up, cooldown or retries. Service failure is failure. Deferred required cards are misses. Labels are synthetic, not exhaustive.", rows }, null, 2));
} finally { closeDecisionClient(); }
