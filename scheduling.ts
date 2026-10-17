import { buildDecisionQuestions, CARD_RELATIONS, type DecisionState, type GuidanceCard, type ProtocolConfig, type RuleAssessment } from "./guidance.ts";
import { digest, type ToolObservation } from "./ledger.ts";

export interface EvaluationPlan {
	questions: ReturnType<typeof buildDecisionQuestions>;
	local: Record<string, RuleAssessment>;
	phase: "diagnosis" | "implementation" | "delivery";
}

const CORE = new Set(["halt", "scope", "no_cheat", "anti_reward_hacking", "trust_boundary"]);
const DIAGNOSIS = new Set(["context", "navigation", "research", "topology", "two_strike", "thrashing", "reproduce_before_fix", "local_version_truth", "evidence_provenance"]);
const DELIVERY = new Set(["verify", "delivery", "reporting", "verification_budget", "abandoned_cleanup", "artifact_cleanup"]);
export const cardPhase = (card: GuidanceCard): string => card.phase ?? (DIAGNOSIS.has(card.id) ? "diagnosis" : DELIVERY.has(card.id) ? "delivery" : "implementation");

/** Only prune a narrowly provable lack of the evidence required by a rule.
 * No write yet never disables authorization, caller investigation or requested checks.
 */
export function planEvaluation(state: DecisionState, cards: readonly GuidanceCard[], observations: readonly ToolObservation[], enabled: boolean, budget = 0, ages: ReadonlyMap<string, number> = new Map()): EvaluationPlan {
	const local: Record<string, RuleAssessment> = {};
	if (state.agencyLevel === "passive") for (const card of cards.filter((item) => item.agency)) local[card.id] = { state: "inapplicable", probabilities: {}, source: "local", evidence: ["Proactive card disabled by passive mode."] };
	if (enabled && observations.length > 0 && observations.every((item) => item.kind === "read" && item.status === "ok")
		&& !state.agentMessage && !state.agentPlan && !state.agentReasoning && state.earlierRequests.length === 0 && state.omittedRequests === 0) {
		local.two_strike = { state: "unknown", probabilities: {}, source: "local", evidence: ["Only successful read operations observed; no visible repeated fix-and-check attempt or assistant hypothesis."] };
	}
	const phase = observations.at(-1)?.kind === "check" ? "delivery" : state.ledger.completedWrites || state.ledger.possibleMutations ? "implementation" : "diagnosis";
	const candidates = cards.filter((card) => !local[card.id]);
	const questionsFor = (chosen: readonly GuidanceCard[]) => {
		const ids = new Set(chosen.map((card) => card.id));
		return buildDecisionQuestions(chosen, CARD_RELATIONS.filter((relation) => ids.has(relation.source) && ids.has(relation.target)));
	};
	if (!budget || questionsFor(candidates).length <= budget) return { local, phase, questions: questionsFor(candidates) };
	const rank = (card: GuidanceCard) => (CORE.has(card.id) ? 10_000 : 0)
		+ (card.id === "toolchain_gap" && state.ledger.missingToolchainSignals.length ? 500 : 0)
		+ (card.id === "thrashing" && state.ledger.repeatedFailureCount >= 2 ? 500 : 0)
		+ (ages.get(card.id) ?? 0) * 20 + (cardPhase(card) === phase ? 10 : 0) + (card.priority ?? 0);
	const chosen: GuidanceCard[] = [];
	const byId = new Map(candidates.map((card) => [card.id, card]));
	for (const card of candidates.slice().sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id))) {
		const proposed = new Map(chosen.map((item) => [item.id, item]));
		const include = (item: GuidanceCard): void => {
			if (proposed.has(item.id)) return;
			proposed.set(item.id, item);
			for (const edge of CARD_RELATIONS.filter((edge) => ["blocks", "requires"].includes(edge.kind) && edge.target === item.id)) {
				const parent = byId.get(edge.source);
				if (parent) include(parent);
			}
		};
		include(card);
		if (questionsFor([...proposed.values()]).length <= budget) chosen.splice(0, chosen.length, ...proposed.values());
	}
	const ids = new Set(chosen.map((card) => card.id));
	for (const card of candidates) if (!ids.has(card.id)) local[card.id] = { state: "unknown", probabilities: {}, source: "deferred", evidence: ["Not assessed in this request's question budget; phase is a scheduling hint, not proof of inapplicability."] };
	return { local, phase, questions: questionsFor(chosen) };
}

export class GuidanceScheduler {
	private tick = 0;
	private revision = "";
	private last?: { intent: string; changes: string; reads: string; ids: string[]; skipped: number };
	private delivered = new Map<string, { tick: number; key: string; streak: number }>();
	private evaluated = new Map<string, number>();

	reset(): void {
		this.tick = 0;
		this.revision = "";
		this.last = undefined;
		this.delivered.clear();
		this.evaluated.clear();
	}

	observe(state: DecisionState, observations: readonly ToolObservation[], config: ProtocolConfig): { gate: boolean; cooling: Set<string>; reminders: { id: string; requestsAgo: number; streak: number }[] } {
		const revision = digest([state.evidenceRevision, state.ledger]);
		const fresh = revision !== this.revision;
		const intent = digest([state.intentRevision, state.request, state.requestIndex, state.earlierRequests, state.agentMessage, state.agentPlan, state.agentReasoning, state.projectRules]);
		const ids = observations.map((item) => item.id);
		const previous = this.last;
		const appended = previous && ids.length >= previous.ids.length && previous.ids.every((id, index) => ids[index] === id);
		if (previous && !appended) this.reset();
		if (fresh) { this.tick++; this.revision = revision; }
		const additions = appended ? observations.slice(previous.ids.length) : [];
		const safeReads = additions.length > 0 && additions.every((item) => item.kind === "read" && item.status === "ok");
		const unchanged = previous?.intent === intent && previous?.changes === state.ledger.changeRevision;
		const gate = Boolean(fresh && safeReads && unchanged && config.readOnlyGating !== "off" && config.maxReadSkips > 0
			&& previous!.skipped < config.maxReadSkips && state.ledger.pendingTools === 0
			&& (config.readOnlyGating === "bounded" || previous!.reads === state.ledger.readRevision));
		this.last = { intent, changes: state.ledger.changeRevision, reads: state.ledger.readRevision, ids, skipped: gate ? previous!.skipped + 1 : 0 };
		const cooling = new Set<string>();
		const reminders: { id: string; requestsAgo: number; streak: number }[] = [];
		for (const [id, entry] of this.delivered) {
			const age = this.tick - entry.tick;
			if (age <= config.cooldownSteps) reminders.push({ id, requestsAgo: age, streak: entry.streak });
			if (age > 0 && age <= config.cooldownSteps && entry.key === this.obligationKey(id, state) && !["halt", "trust_boundary", "no_cheat", "anti_reward_hacking"].includes(id)) cooling.add(id);
		}
		return { gate, cooling, reminders };
	}

	/** Called only once the result still owns the request and will actually be injected. */
	markInjected(ids: readonly string[], state: DecisionState): void {
		for (const id of ids) {
			const previous = this.delivered.get(id);
			const key = this.obligationKey(id, state);
			const streak = previous?.key === key && previous.tick >= this.tick - 1 ? previous.streak + (previous.tick === this.tick ? 0 : 1) : 1;
			this.delivered.set(id, { tick: this.tick, key, streak });
		}
	}
	ages(cards: readonly GuidanceCard[]): Map<string, number> {
		return new Map(cards.map((card) => [card.id, this.tick - (this.evaluated.get(card.id) ?? 0)]));
	}
	markEvaluated(ids: readonly string[]): void { for (const id of ids) this.evaluated.set(id, this.tick); }

	private obligationKey(id: string, state: DecisionState): string {
		const evidenceSensitive = ["context", "topology", "research", "evidence_provenance", "candor"].includes(id) || id.startsWith("project_");
		return digest([state.requestRevision, state.request, state.requestIndex, state.earlierRequests, state.agentPlan, state.ledger.changeRevision, evidenceSensitive ? state.ledger.readRevision : null]);
	}
}
