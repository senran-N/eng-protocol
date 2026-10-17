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
import { closeDecisionClient, evaluateDecision } from "./decision.ts";
import {
	buildDecisionState,
	CARDS,
	DEFAULT_CONFIG,
	type DecisionConfig,
	type DecisionSource,
	type DecisionState,
	type ProtocolConfig,
	type GuidanceSelection,
	parseConfig,
	parseConfigValueReference,
	parseProjectConfig,
	PLAN_INSTRUCTION,
	renderGuidance,
	selectGuidance,
	RULE_STATE_LABELS,
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
	} catch (error) {
		errors.push(`${path}: JSON 解析失败：${(error as Error).message}`);
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
		return stdout.trim() || { error: `命令没有输出：${reference.command}` };
	} catch (error) {
		return { error: `命令执行失败：${reference.command}（${(error as Error).message.split("\n")[0]}）` };
	}
}

async function resolveDecisionSource(decision: DecisionConfig): Promise<DecisionSource | { error: string }> {
	const apiKey = await resolveApiKey(decision.apiKey);
	if (typeof apiKey !== "string") return { error: `决策模型 API key 解析失败（decision.apiKey）：${apiKey.error}` };
	return { endpoint: decision.endpoint, model: decision.model, apiKey };
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

function getCardTitles(cardIds: readonly string[]): string {
	return cardIds.map((id) => CARDS.find((card) => card.id === id)?.title ?? id).join("·");
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
	let outcome: DecisionOutcome = { kind: "none" };
	let lastDecided: Decided | undefined;
	let lastGuidance: string | undefined;
	let decisionController = new AbortController();
	let activeDecision: AbortController | undefined;
	const notified = new Set<string>();

	const isEnabled = () => enabledOverride ?? settings?.config.enabled ?? DEFAULT_CONFIG.enabled;

	function resetDecision() {
		activeDecision?.abort();
		activeDecision = undefined;
		decisionController.abort();
		decisionController = new AbortController();
		outcome = { kind: "none" };
		lastDecided = undefined;
		lastGuidance = undefined;
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
		const focus = outcome.kind === "decided" && outcome.cardIds.length > 0 ? getCardTitles(outcome.cardIds) : "—";
		ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", `⚖ ${focus}`));
	}

	async function decide(source: DecisionSource, state: DecisionState, ctx: ExtensionContext, lifecycleSignal: AbortSignal, contextSignal: AbortSignal): Promise<Decided | undefined> {
		const stateKey = JSON.stringify(state);
		if (lastDecided?.stateKey === stateKey) {
			outcome = lastDecided;
			return lastDecided;
		}
		const config = settings?.config ?? DEFAULT_CONFIG;
		const signal = AbortSignal.any([lifecycleSignal, contextSignal, AbortSignal.timeout(config.decision.timeoutMs), ...(ctx.signal ? [ctx.signal] : [])]);
		const startedAt = performance.now();
		try {
			const { probabilities, batchCount, questionCount } = await evaluateDecision(source, state, signal);
			signal.throwIfAborted();
			const selection = selectGuidance(probabilities, config);
			lastDecided = { kind: "decided", stateKey, ...selection, batchCount, questionCount, latencyMs: Math.round(performance.now() - startedAt) };
			outcome = lastDecided;
			return lastDecided;
		} catch (error) {
			if (lifecycleSignal.aborted || contextSignal.aborted) return undefined;
			lastDecided = undefined;
			if (ctx.signal?.aborted) {
				outcome = { kind: "none" };
				return undefined;
			}
			const message = error instanceof Error ? error.message : String(error);
			outcome = { kind: "failed", error: message };
			notifyOnce(ctx, `决策模型调用失败，本次跳过动态提醒：${message}`);
			return undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await reloadSettings(ctx.cwd);
		for (const error of loaded.configErrors) notifyOnce(ctx, error);
		if ("error" in loaded.source) notifyOnce(ctx, `阶段引导停用：${loaded.source.error}`);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		resetDecision();
		closeDecisionClient();
	});

	pi.on("before_agent_start", async (event) => {
		if (!isEnabled() || !settings) return;
		const sections = event.systemPromptOptions.sections;
		sections.engineering_protocol = settings.protocolText;
		sections.engineering_plan = PLAN_INSTRUCTION;
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
		if (!isEnabled() || !settings || "error" in settings.source || ctx.signal?.aborted) return;
		const lifecycleSignal = decisionController.signal;
		const decided = await decide(settings.source, buildDecisionState(event.messages, { ...settings.config, projectRules: settings.projectRules }), ctx, lifecycleSignal, currentDecision.signal);
		if (lifecycleSignal.aborted || currentDecision.signal.aborted) return;
		updateStatus(ctx);
		if (!decided || ctx.signal?.aborted) return;
		const guidance = renderGuidance({
			cardIds: decided.cardIds,
			architectureDoc: settings.architectureDoc,
		});
		if (!guidance) return;
		lastGuidance = guidance;
		return { messages: appendGuidance(event.messages, guidance) };
	});

	const SUBCOMMANDS: Record<string, { description: string; run: (ctx: ExtensionContext) => Promise<string> | string }> = {
		status: {
			description: "显示当前状态",
			run: () => {
				const source = settings?.source;
				const sourceLine = !source || "error" in source ? `不可用（${source?.error ?? "会话未开始"}）` : `${source.model} @ ${new URL(source.endpoint).host}`;
				return [`eng-protocol：${isEnabled() ? "开" : "关"}`, `决策模型：${sourceLine}`, `最近一次引导：${getOutcomeLabel(outcome)}`].join("\n");
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
				const decided = lastDecided;
				const labels = { selected: "已选", state: "无需注入", covered: "被覆盖", blocked: "行动受阻", prerequisite: "前置条件未解决", limit: "超出注入上限" };
				const ranking = Object.entries(decided.assessments)
					.sort(([, a], [, b]) => b.probabilities.needed - a.probabilities.needed)
					.map(([id, assessment]) => {
						const reason = decided.reasons[id];
						return `${decided.cardIds.includes(id) ? "▶" : " "} ${assessment.probabilities.needed.toFixed(2)} ${getCardTitles([id])}：${RULE_STATE_LABELS[assessment.state]}；${labels[reason.kind]}${reason.by ? `（${getCardTitles([reason.by])}）` : ""}`;
					});
				return [`协议文本：${PROTOCOL_PATH}`, `决策耗时：${decided.latencyMs}ms；${decided.questionCount} 个问题 / ${decided.batchCount} 个请求`, "以下状态为本次证据快照的模型判断，分数为 P(需要处理)。", ...ranking, `关系条件成立：${decided.activeRelations.join("、") || "无"}`, "", lastGuidance ?? "（本次未注入）"].join("\n");
			},
		},
	};

	pi.registerCommand("protocol", {
		description: "工程协议引导：status | on | off | reload | show",
		getArgumentCompletions: (prefix) =>
			Object.entries(SUBCOMMANDS)
				.filter(([name]) => name.startsWith(prefix.trim()))
				.map(([name, sub]) => ({ value: name, label: name, description: sub.description })),
		handler: async (args, ctx) => {
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
