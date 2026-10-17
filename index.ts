/**
 * eng-protocol — guides the agent to follow the Autonomous Engineering Agent Protocol (protocol.md)
 * before it acts; the model keeps full autonomy over every tool call.
 *
 * - before_agent_start:  protocol + project rules as system prompt sections (stable, cached)
 * - context_with_system: before every model request, the decision model (eng-protocol.json `decision`)
 *                        scores which protocol cards matter for the agent's next action; the selected
 *                        cards are appended to the tail of that request only
 * - /protocol:           status | on | off | reload | show
 */
import { exec } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closeDecisionClient } from "./decision.ts";
import { branchMessages, buildLedger, observeTools, type ToolObservation } from "./ledger.ts";
import { GuidanceScheduler, planEvaluation } from "./scheduling.ts";
import { getDecisionProvider, localAssessments, LOCAL_CARDS, resolveProviderResult } from "./providers.ts";
import {
	buildDecisionState,
	CARDS,
	CARD_RELATIONS,
	DEFAULT_CONFIG,
	type DecisionConfig,
	type DecisionSource,
	type DecisionState,
	type ProtocolConfig,
	type GuidanceSelection,
	type GuidanceCard,
	parseConfig,
	parseConfigValueReference,
	parseProjectConfig,
	PLAN_INSTRUCTION,
	renderGuidance,
	selectAssessments,
	RULE_STATE_LABELS,
	agencyInstruction,
} from "./guidance.ts";

type AgentMessage = ContextEvent["messages"][number];

const STATUS_KEY = "eng-protocol";
const GUIDANCE_TYPE = "eng-protocol-guidance";
const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "eng-protocol.json");
const API_KEY_COMMAND_TIMEOUT_MS = 15_000;
const execAsync = promisify(exec);
const PROTOCOL_PATH = join(dirname(fileURLToPath(import.meta.url)), "protocol.md");
const ARCHITECTURE_CANDIDATES = ["ARCHITECTURE.md", "docs/ARCHITECTURE.md", "docs/architecture.md"];

interface SessionSettings {
	protocolText: string;
	config: ProtocolConfig;
	configErrors: string[];
	source: DecisionSource | { error: string };
	projectRules: string | undefined;
	architectureDoc: string | undefined;
}

interface Decided extends GuidanceSelection {
	kind: "decided";
	stateKey: string;
	batchCount: number;
	questionCount: number;
	latencyMs: number;
	mode: "remote" | "partial" | "local";
	errors: string[];
}

type DecisionOutcome = { kind: "none" } | Decided | { kind: "failed"; error: string };

async function readOptionalFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`eng-protocol: 读取 ${path} 失败：${(error as Error).message}`);
	}
}

async function readJson(path: string, errors: string[]): Promise<unknown> {
	const text = await readOptionalFile(path);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		errors.push(`${path}: JSON 解析失败，请检查文件格式`);
		return undefined;
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function resolveApiKey(value: string): Promise<string | { error: string }> {
	const reference = parseConfigValueReference(value);
	if (reference.kind === "literal") return reference.value;
	if (reference.kind === "env") return process.env[reference.name]?.trim() || { error: `环境变量 ${reference.name} 未设置` };
	try {
		const { stdout } = await execAsync(reference.command, { timeout: API_KEY_COMMAND_TIMEOUT_MS, windowsHide: true });
		return stdout.trim() || { error: "API key 命令没有输出" };
	} catch {
		return { error: "API key 命令执行失败，请检查全局配置" };
	}
}

export async function resolveDecisionSource(decision: DecisionConfig): Promise<DecisionSource | { error: string }> {
	if (decision.provider === "local") return { ...decision, apiKey: "" };
	if (decision.provider !== "subq" && (decision.endpoint === DEFAULT_CONFIG.decision.endpoint || decision.model === DEFAULT_CONFIG.decision.model)) return { error: "切换 provider 时须在全局 decision 中明确配置匹配的 endpoint、model 和 apiKey" };
	const apiKey = await resolveApiKey(decision.apiKey);
	if (typeof apiKey !== "string") return { error: `决策模型 API key 解析失败（decision.apiKey）：${apiKey.error}` };
	if (!apiKey && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(decision.endpoint).hostname)) return { error: "远端决策服务需要 API key；只有本机服务允许空 key" };
	return { ...decision, apiKey };
}

async function loadSessionSettings(cwd: string): Promise<SessionSettings> {
	let config = DEFAULT_CONFIG;
	const configErrors: string[] = [];
	const layers = [
		{ path: GLOBAL_CONFIG_PATH, parse: parseConfig },
		{ path: join(cwd, ".pi", "eng-protocol.json"), parse: parseProjectConfig },
	];
	for (const { path, parse } of layers) {
		const raw = await readJson(path, configErrors);
		if (raw === undefined) continue;
		const parsed = parse(raw, config, path);
		config = parsed.config;
		configErrors.push(...parsed.errors);
	}

	const protocolText = await readFile(PROTOCOL_PATH, "utf8");
	const source = await resolveDecisionSource(config.decision);
	const projectRules = (await readOptionalFile(join(cwd, ".pi", "eng-protocol.md")))?.trim() || undefined;
	let architectureDoc: string | undefined;
	for (const candidate of ARCHITECTURE_CANDIDATES) {
		if (!(await fileExists(join(cwd, candidate)))) continue;
		architectureDoc = candidate;
		break;
	}
	return { protocolText, config, configErrors, source, projectRules, architectureDoc };
}

/** Copy of `messages` whose last message carries the guidance; earlier messages stay identical for prompt caching. */
function appendGuidance(messages: AgentMessage[], guidance: string): AgentMessage[] {
	const last = messages.at(-1);
	const guidanceMessage = { role: "custom", customType: GUIDANCE_TYPE, content: guidance, display: false, timestamp: Date.now() } as AgentMessage;
	if (!last) return [guidanceMessage];

	const content = (last as { content?: unknown }).content;
	const canCarryText = last.role === "user" || last.role === "toolResult" || last.role === "custom";
	if (!canCarryText) return [...messages, guidanceMessage];
	if (typeof content === "string") return [...messages.slice(0, -1), { ...last, content: `${content}\n\n${guidance}` } as AgentMessage];
	if (Array.isArray(content)) return [...messages.slice(0, -1), { ...last, content: [...content, { type: "text", text: guidance }] } as AgentMessage];
	return [...messages, guidanceMessage];
}

function getCardTitles(cardIds: readonly string[], cards: readonly GuidanceCard[] = [...CARDS, ...LOCAL_CARDS]): string {
	return cardIds.map((id) => cards.find((card) => card.id === id)?.title ?? id).join("·");
}

const OUTCOME_LABELS: { [K in DecisionOutcome["kind"]]: (outcome: Extract<DecisionOutcome, { kind: K }>) => string } = {
	none: () => "尚未决策",
	decided: (outcome) => `${getCardTitles(outcome.cardIds) || "无"}（${outcome.latencyMs}ms）`,
	failed: (outcome) => `失败：${outcome.error}`,
};

function getOutcomeLabel(outcome: DecisionOutcome): string {
	return (OUTCOME_LABELS[outcome.kind] as (value: DecisionOutcome) => string)(outcome);
}

export default function engProtocol(pi: ExtensionAPI) {
	let settings: SessionSettings | undefined;
	let enabledOverride: boolean | undefined;
	let agencyOverride: ProtocolConfig["agencyLevel"] | undefined;
	let outcome: DecisionOutcome = { kind: "none" };
	let lastDecided: Decided | undefined;
	let lastGuidance: string | undefined;
	let decisionController = new AbortController();
	let activeDecision: AbortController | undefined;
	const notified = new Set<string>();
	const scheduler = new GuidanceScheduler();
	let remoteRetryAt = 0;
	let remoteError = "";
	let branchId: string | undefined;
	const metrics = { contexts: 0, cacheHits: 0, gated: 0, requests: 0, questions: 0, prefiltered: 0, deferred: 0, failures: 0, partial: 0, local: 0, injected: 0, cooled: 0, waitMs: 0 };
	const latencies: number[] = [];
	const metricsLine = () => {
		const sorted = [...latencies].sort((a, b) => a - b);
		return JSON.stringify({ ...metrics, latencySamples: sorted.length, p50Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)] ?? 0, p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0 });
	};
	const cards = () => [...CARDS, ...(settings?.config.customCards ?? []), ...LOCAL_CARDS];
	const currentConfig = (): ProtocolConfig => ({ ...(settings?.config ?? DEFAULT_CONFIG), agencyLevel: agencyOverride ?? settings?.config.agencyLevel ?? DEFAULT_CONFIG.agencyLevel });

	const isEnabled = () => enabledOverride ?? settings?.config.enabled ?? DEFAULT_CONFIG.enabled;

	function resetDecision() {
		activeDecision?.abort();
		activeDecision = undefined;
		decisionController.abort();
		decisionController = new AbortController();
		outcome = { kind: "none" };
		lastDecided = undefined;
		lastGuidance = undefined;
		scheduler.reset();
		remoteRetryAt = 0;
		remoteError = "";
	}

	async function reloadSettings(cwd: string) {
		resetDecision();
		const loaded = await loadSessionSettings(cwd);
		// Also invalidate requests that began while the settings were being read.
		resetDecision();
		settings = loaded;
		notified.clear();
		return loaded;
	}

	function notifyOnce(ctx: ExtensionContext, message: string) {
		if (notified.has(message)) return;
		notified.add(message);
		// Print and JSON modes have no UI; stderr keeps failures diagnosable without touching stdout.
		if (!ctx.hasUI) process.stderr.write(`eng-protocol：${message}
`);
		else ctx.ui.notify(`eng-protocol：${message}`, "warning");
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;
		if (!isEnabled()) {
			ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "⚖ 协议:关"));
			return;
		}
		if (outcome.kind === "failed") {
			ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", "⚖ 决策不可用"));
			return;
		}
		const focus = outcome.kind === "decided" && outcome.cardIds.length > 0 ? getCardTitles(outcome.cardIds, cards()) : "—";
		ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", `⚖ ${focus}`));
	}

	async function decide(source: SessionSettings["source"], state: DecisionState, observations: ToolObservation[], cooling: Set<string>, ctx: ExtensionContext, lifecycleSignal: AbortSignal, contextSignal: AbortSignal): Promise<Decided | undefined> {
		// Reminder delivery metadata must not invalidate an otherwise identical evidence snapshot.
		const stateKey = JSON.stringify({ ...state, recentReminders: undefined });
		const config = currentConfig();
		const allCards = cards();
		const select = (assessments: GuidanceSelection["assessments"], activeRelations: string[]) => selectAssessments(assessments, activeRelations, config, allCards, CARD_RELATIONS, cooling);
		if (lastDecided?.stateKey === stateKey && (lastDecided.mode === "remote" || Date.now() < remoteRetryAt || (!("error" in source) && source.provider === "local"))) {
			metrics.cacheHits++;
			outcome = { ...lastDecided, ...select(lastDecided.assessments, lastDecided.activeRelations) };
			return outcome;
		}
		const signal = AbortSignal.any([lifecycleSignal, contextSignal, AbortSignal.timeout(config.decision.timeoutMs), ...(ctx.signal ? [ctx.signal] : [])]);
		const startedAt = performance.now();
		let attemptedBatches = 0;
		let attemptedQuestions = 0;
		const recordLatency = () => {
			const latencyMs = Math.round(performance.now() - startedAt);
			metrics.waitMs += latencyMs;
			latencies.push(latencyMs);
			if (latencies.length > 256) latencies.shift();
			return latencyMs;
		};
		const isStale = () => lifecycleSignal.aborted || contextSignal.aborted || ctx.signal?.aborted;
		const finish = (selection: GuidanceSelection, mode: Decided["mode"], batchCount: number, questionCount: number, errors: string[]): Decided | undefined => {
			if (isStale()) return undefined;
			const latencyMs = recordLatency();
			metrics.cooled += Object.values(selection.reasons).filter((reason) => reason.kind === "cooldown").length;
			lastDecided = { kind: "decided", stateKey, ...selection, batchCount, questionCount, latencyMs, mode, errors };
			outcome = lastDecided;
			return lastDecided;
		};
		const fallback = (error?: string): Decided | undefined => {
			if (isStale()) return undefined;
			if (config.decision.fallback === "none" && ("error" in source || source.provider !== "local")) {
				recordLatency();
				lastDecided = undefined;
				outcome = { kind: "failed", error: error ?? "决策不可用" };
				return undefined;
			}
			metrics.local++;
			const assessments: GuidanceSelection["assessments"] = Object.fromEntries(allCards.map((card) => [card.id, { state: "unknown", probabilities: {}, source: "unavailable" }]));
			Object.assign(assessments, localAssessments(state, observations));
			return finish(select(assessments, []), "local", attemptedBatches, attemptedQuestions, error ? [error] : []);
		};
		if ("error" in source) return fallback(source.error);
		if (source.provider === "local") return fallback();
		if (Date.now() < remoteRetryAt) return fallback(remoteError);
		try {
			const remoteCards = allCards.filter((card) => !LOCAL_CARDS.some((local) => local.id === card.id));
			const plan = planEvaluation(state, remoteCards, observations, config.localPrefilter, config.maxQuestions, scheduler.ages(remoteCards));
			metrics.prefiltered += Object.values(plan.local).filter((item) => item.source === "local").length;
			metrics.deferred += Object.values(plan.local).filter((item) => item.source === "deferred").length;
			const result = await getDecisionProvider(source).evaluate(source, state, plan.questions, signal, (count) => { metrics.requests++; metrics.questions += count; attemptedBatches++; attemptedQuestions += count; });
			signal.throwIfAborted();
			const resolved = resolveProviderResult(result, remoteCards, config.minProbability, plan.local, config);
			scheduler.markEvaluated(Object.keys(resolved.assessments).filter((id) => ["subq", "structured"].includes(resolved.assessments[id].source ?? "")));
			for (const card of LOCAL_CARDS) resolved.assessments[card.id] = { state: "inapplicable", probabilities: {}, source: "local" };
			if (result.errors.length) { metrics.partial++; remoteRetryAt = Date.now() + config.decision.retryAfterMs; remoteError = result.errors.join("；"); }
			else { remoteRetryAt = 0; remoteError = ""; }
			return finish(select(resolved.assessments, resolved.activeRelations), result.errors.length ? "partial" : "remote", result.batchCount, result.questionCount, result.errors);
		} catch (error) {
			if (lifecycleSignal.aborted || contextSignal.aborted) return undefined;
			lastDecided = undefined;
			if (ctx.signal?.aborted) {
				outcome = { kind: "none" };
				return undefined;
			}
			const message = signal.aborted ? "决策请求超时" : error instanceof Error ? error.message : String(error);
			metrics.failures++;
			remoteRetryAt = Date.now() + config.decision.retryAfterMs;
			remoteError = message;
			notifyOnce(ctx, `决策模型调用失败，${config.decision.fallback === "local" ? "使用本地事实提醒" : "本次跳过动态提醒"}：${message}`);
			return fallback(message);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		branchId = undefined;
		latencies.length = 0;
		for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) metrics[key] = 0;
		const loaded = await reloadSettings(ctx.cwd);
		for (const error of loaded.configErrors) notifyOnce(ctx, error);
		if ("error" in loaded.source) notifyOnce(ctx, `远端决策不可用：${loaded.source.error}`);
		updateStatus(ctx);
	});
	pi.on("session_tree", () => { resetDecision(); branchId = undefined; });
	pi.on("session_before_switch", () => { resetDecision(); branchId = undefined; });
	pi.on("session_before_fork", () => { resetDecision(); branchId = undefined; });

	pi.on("session_shutdown", async () => {
		resetDecision();
		closeDecisionClient();
	});

	pi.on("before_agent_start", async (event) => {
		if (!isEnabled() || !settings) return;
		const sections = event.systemPromptOptions.sections;
		sections.engineering_protocol = settings.protocolText;
		sections.engineering_plan = PLAN_INSTRUCTION;
		sections.engineering_agency = agencyInstruction(currentConfig().agencyLevel);
		if (settings?.projectRules) sections.project_engineering_rules = settings.projectRules;
	});

	// context_with_system runs after every `context` handler, so transcript rebuilders such as
	// billion-context-pi cannot drop the guidance. appendGuidance never touches the leading system message.
	pi.on("context_with_system", async (event, ctx) => {
		// This request owns the result through injection, including the asynchronous cache-hit path.
		activeDecision?.abort();
		const currentDecision = new AbortController();
		activeDecision = currentDecision;
		lastGuidance = undefined;
		if (!isEnabled() || !settings || ctx.signal?.aborted) return;
		metrics.contexts++;
		const lifecycleSignal = decisionController.signal;
		let history = event.messages;
		let ledgerSource: "branch" | "visible" = "visible";
		if (ctx.sessionManager?.getBranch) {
			const entries = ctx.sessionManager.getBranch();
			const sessionId = ctx.sessionManager.getSessionId();
			if (branchId && branchId !== sessionId) { scheduler.reset(); lastDecided = undefined; }
			branchId = sessionId;
			const branch = branchMessages(entries);
			// Current context can contain fresher tool results than persisted branch entries.
			const branchCalls = new Map(observeTools(branch).map((item) => [item.id, item]));
			const visibleCalls = observeTools(event.messages);
			if (branch.length && visibleCalls.every((item) => branchCalls.get(item.id)?.fingerprint === item.fingerprint && branchCalls.get(item.id)?.status === item.status)) {
				history = branch as AgentMessage[];
				ledgerSource = "branch";
			}
		}
		const config = currentConfig();
		const observations = observeTools(history);
		const state = buildDecisionState(event.messages, { ...config, projectRules: settings.projectRules, ledger: buildLedger(history, ledgerSource, observations) });
		state.agencyLevel = config.agencyLevel;
		const schedule = scheduler.observe(state, observations, config);
		state.recentReminders = schedule.reminders;
		if (schedule.gate) { metrics.gated++; outcome = { kind: "none" }; updateStatus(ctx); return; }
		const decided = await decide(settings.source, state, observations, schedule.cooling, ctx, lifecycleSignal, currentDecision.signal);
		if (lifecycleSignal.aborted || currentDecision.signal.aborted) return;
		updateStatus(ctx);
		if (!decided || ctx.signal?.aborted) return;
		const guidance = renderGuidance({
			cardIds: decided.cardIds,
			architectureDoc: settings.architectureDoc,
			cards: cards(),
			groups: decided.groups,
			resolutions: decided.resolutions,
		});
		if (!guidance) return;
		lastGuidance = guidance;
		scheduler.markInjected(decided.cardIds, state);
		metrics.injected += decided.cardIds.length;
		return { messages: appendGuidance(event.messages, guidance) };
	});

	const SUBCOMMANDS: Record<string, { description: string; run: (ctx: ExtensionContext) => Promise<string> | string }> = {
		status: {
			description: "显示当前状态",
			run: () => {
				const source = settings?.source;
				const sourceLine = !source || "error" in source ? `不可用（${source?.error ?? "会话未开始"}）` : source.provider === "local" ? "local（离线）" : `${source.provider} / ${source.model} @ ${new URL(source.endpoint).host}`;
				return [`eng-protocol：${isEnabled() ? "开" : "关"}；mode=${currentConfig().agencyLevel}`, `决策模型：${sourceLine}`, `最近一次引导：${getOutcomeLabel(outcome)}`, `会话指标：${metricsLine()}`].join("\n");
			},
		},
		on: {
			description: "本会话启用",
			run: () => {
				enabledOverride = true;
				return "eng-protocol 已启用（本会话）";
			},
		},
		off: {
			description: "本会话停用",
			run: () => {
				enabledOverride = false;
				resetDecision();
				return "eng-protocol 已停用（本会话）";
			},
		},
		reload: {
			description: "重新读取规范、配置、决策源、项目规则与架构锚点",
			run: async (ctx) => {
				const loaded = await reloadSettings(ctx.cwd);
				const problems = [...loaded.configErrors, ...("error" in loaded.source ? [loaded.source.error] : [])];
				return problems.length > 0 ? `已重载，存在问题：\n${problems.join("\n")}` : "已重载";
			},
		},
		show: {
			description: "显示规则状态、关系裁决、请求数量与实际注入内容",
			run: () => {
				if (!lastDecided) return `最近一次决策：${getOutcomeLabel(outcome)}\n本次未注入动态提醒。`;
				const decided = outcome.kind === "decided" ? outcome : lastDecided;
				const labels = { selected: "已选", state: "无需注入", covered: "被覆盖", blocked: "行动受阻", prerequisite: "前置条件未解决", limit: "超出注入上限", cooldown: "提醒冷却", arbitrated: "方向仲裁" };
				const ranking = Object.entries(decided.assessments)
					.sort(([, a], [, b]) => (b.probabilities.needed ?? 0) - (a.probabilities.needed ?? 0))
					.map(([id, assessment]) => {
						const reason = decided.reasons[id];
						return `${decided.cardIds.includes(id) ? "▶" : " "} ${assessment.probabilities.needed?.toFixed(2) ?? "—"} ${getCardTitles([id], cards())}：${RULE_STATE_LABELS[assessment.state]}；${labels[reason.kind]}${reason.by ? `（${getCardTitles([reason.by], cards())}）` : ""} [${assessment.source ?? "subq"}]`;
					});
				return [`协议文本：${PROTOCOL_PATH}`, `决策来源：${decided.mode}${decided.errors.length ? `；${decided.errors.join("；")}` : ""}`, `决策耗时：${decided.latencyMs}ms；${decided.questionCount} 个问题 / ${decided.batchCount} 个请求`, `会话指标：${metricsLine()}`, "概率仅适用于 SubQ；结构化和本地状态不伪造概率。deferred 表示受预算限制未评估，不代表不适用。以下为最近决策，节流时未重新评估。", ...ranking, `关系条件成立：${decided.activeRelations.join("、") || "无"}`, "", lastGuidance ?? "（本次未注入）"].join("\n");
			},
		},
	};

	pi.registerCommand("protocol", {
		description: "工程协议引导：status | on | off | reload | show | mode passive/balanced/proactive",
		getArgumentCompletions: (prefix) => prefix.startsWith("mode ")
			? ["passive", "balanced", "proactive"].filter((mode) => `mode ${mode}`.startsWith(prefix)).map((mode) => ({ value: `mode ${mode}`, label: mode }))
			: Object.entries({ ...SUBCOMMANDS, mode: { description: "主动程度：passive | balanced | proactive" } })
				.filter(([name]) => name.startsWith(prefix.trim()))
				.map(([name, sub]) => ({ value: name, label: name, description: sub.description })),
		handler: async (args, ctx) => {
			if (args.trim().split(/\s+/)[0] === "mode") {
				const parts = args.trim().split(/\s+/);
				const mode = parts[1];
				if (parts.length !== 2 || !["passive", "balanced", "proactive"].includes(mode)) { ctx.ui.notify("用法：/protocol mode passive|balanced|proactive", "warning"); return; }
				agencyOverride = mode as ProtocolConfig["agencyLevel"];
				resetDecision();
				ctx.ui.notify(`主动模式：${mode}（本会话；下一次决策生效）`, "info");
				updateStatus(ctx);
				return;
			}
			const name = args.trim() || "status";
			const sub = SUBCOMMANDS[name];
			if (!sub) {
				ctx.ui.notify(`未知子命令 ${name}。可用：${Object.keys(SUBCOMMANDS).join(" | ")}`, "warning");
				return;
			}
			ctx.ui.notify(await sub.run(ctx), "info");
			updateStatus(ctx);
		},
	});
}
