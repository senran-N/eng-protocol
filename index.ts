/**
 * eng-protocol — guides the agent to follow the Autonomous Engineering Agent Protocol (protocol.md)
 * before it acts. It never blocks or rewrites tool calls; the model keeps full autonomy.
 *
 * - before_agent_start:  protocol + project rules as system prompt sections (stable, cached)
 * - context_with_system: before every model request, the decision model (eng-protocol.json `decision`)
 *                        scores which protocol cards matter for the agent's next action; the selected
 *                        cards are appended to the tail of that request only
 * - /protocol:           status | on | off | reload | show
 */
import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closeDecisionClient, requestDecision } from "./decision.ts";
import {
	buildDecisionRequest,
	buildDecisionState,
	CARDS,
	DEFAULT_CONFIG,
	type DecisionConfig,
	type DecisionSource,
	type DecisionState,
	getRunAssumptions,
	type ProtocolConfig,
	parseConfig,
	parseConfigValueReference,
	parseDecisionResponse,
	parseProjectConfig,
	PLAN_INSTRUCTION,
	renderGuidance,
	selectCards,
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
	config: ProtocolConfig;
	configErrors: string[];
	source: DecisionSource | { error: string };
	projectRules: string | undefined;
	architectureDoc: string | undefined;
}

interface Decided {
	kind: "decided";
	request: string;
	stateKey: string;
	scores: Record<string, number>;
	cardIds: string[];
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

	const source = await resolveDecisionSource(config.decision);
	const projectRules = (await readOptionalFile(join(cwd, ".pi", "eng-protocol.md")))?.trim() || undefined;
	let architectureDoc: string | undefined;
	for (const candidate of ARCHITECTURE_CANDIDATES) {
		if (!(await fileExists(join(cwd, candidate)))) continue;
		architectureDoc = candidate;
		break;
	}
	return { config, configErrors, source, projectRules, architectureDoc };
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
	const protocolText = readFileSync(PROTOCOL_PATH, "utf8");
	let settings: SessionSettings | undefined;
	let enabledOverride: boolean | undefined;
	let outcome: DecisionOutcome = { kind: "none" };
	let lastDecided: Decided | undefined;
	const notified = new Set<string>();

	const isEnabled = () => enabledOverride ?? settings?.config.enabled ?? DEFAULT_CONFIG.enabled;

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

	async function decide(source: DecisionSource, state: DecisionState, ctx: ExtensionContext): Promise<Decided | undefined> {
		const stateKey = JSON.stringify(state);
		if (lastDecided?.stateKey === stateKey) return lastDecided;
		const timeoutMs = settings?.config.decision.timeoutMs ?? DEFAULT_CONFIG.decision.timeoutMs;
		const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(ctx.signal ? [ctx.signal] : [])]);
		const startedAt = performance.now();
		try {
			const body = await requestDecision(source, buildDecisionRequest(source.model, state, CARDS), signal);
			const scores = parseDecisionResponse(body, CARDS);
			const cardIds = selectCards(scores, settings?.config ?? DEFAULT_CONFIG);
			lastDecided = { kind: "decided", request: state.request, stateKey, scores, cardIds, latencyMs: Math.round(performance.now() - startedAt) };
			outcome = lastDecided;
			return lastDecided;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			outcome = { kind: "failed", error: message };
			notifyOnce(ctx, `决策模型调用失败，本步沿用上一次决策或不注入：${message}`);
			return lastDecided?.request === state.request ? lastDecided : undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		settings = await loadSessionSettings(ctx.cwd);
		outcome = { kind: "none" };
		lastDecided = undefined;
		for (const error of settings.configErrors) notifyOnce(ctx, error);
		if ("error" in settings.source) notifyOnce(ctx, `阶段引导停用：${settings.source.error}`);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		closeDecisionClient();
	});

	pi.on("before_agent_start", async (event) => {
		if (!isEnabled()) return;
		const sections = event.systemPromptOptions.sections;
		sections.engineering_protocol = protocolText;
		sections.engineering_plan = PLAN_INSTRUCTION;
		if (settings?.projectRules) sections.project_engineering_rules = settings.projectRules;
	});

	// context_with_system runs after every `context` handler, so transcript rebuilders such as
	// billion-context-pi cannot drop the guidance. appendGuidance never touches the leading system message.
	pi.on("context_with_system", async (event, ctx) => {
		if (!isEnabled() || !settings || "error" in settings.source) return;
		const decided = await decide(settings.source, buildDecisionState(event.messages, settings.config), ctx);
		updateStatus(ctx);
		if (!decided) return;
		const guidance = renderGuidance({
			cardIds: decided.cardIds,
			request: decided.request,
			assumptions: getRunAssumptions(event.messages),
			architectureDoc: settings.architectureDoc,
		});
		if (!guidance) return;
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
				return "eng-protocol 已停用（本会话）";
			},
		},
		reload: {
			description: "重新读取配置、决策源、项目规则与架构锚点",
			run: async (ctx) => {
				settings = await loadSessionSettings(ctx.cwd);
				const problems = [...settings.configErrors, ...("error" in settings.source ? [settings.source.error] : [])];
				return problems.length > 0 ? `已重载，存在问题：\n${problems.join("\n")}` : "已重载";
			},
		},
		show: {
			description: "显示最近一次决策的各卡片得分与注入内容",
			run: () => {
				if (!lastDecided) return "本会话还没有成功的决策。";
				const ranking = Object.entries(lastDecided.scores)
					.sort(([, a], [, b]) => b - a)
					.map(([id, yes]) => `${lastDecided?.cardIds.includes(id) ? "▶" : " "} ${yes.toFixed(2)}  ${getCardTitles([id])}`);
				const guidance = renderGuidance({ cardIds: lastDecided.cardIds, request: lastDecided.request, assumptions: [], architectureDoc: settings?.architectureDoc }) ?? "（未注入）";
				return [`协议文本：${PROTOCOL_PATH}`, `决策耗时：${lastDecided.latencyMs}ms`, ...ranking, "", guidance].join("\n");
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
