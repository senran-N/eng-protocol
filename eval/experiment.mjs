import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, parseConfig } from "../guidance.ts";

export const ROOT = resolve(import.meta.dirname, "..");
export const CLI = process.env.PI_CLI ?? join(process.env.APPDATA ?? join(homedir(), ".local", "lib"), "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
export const MODEL = process.env.EVAL_MODEL ?? "srapi/gpt-6-luna";
const ISOLATION = ["--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files"];
export const ARMS = {
	none: ISOLATION,
	static: [...ISOLATION, "--extension", join(import.meta.dirname, "static.ts")],
	plugin: [...ISOLATION, "--extension", join(ROOT, "index.ts"), "--extension", join(import.meta.dirname, "guidance-log.ts")],
};

export function experimentMetadata() {
	const files = ["protocol.md", "guidance.ts", "index.ts", "decision.ts", "ledger.ts", "scheduling.ts", "providers.ts", "agent-cards.ts", "eval/static.ts", "eval/guidance-log.ts", "eval/checks.mjs", "eval/fixtures.mjs", "eval/run.mjs", "eval/score.mjs", "eval/experiment.mjs", "eval/routing.mjs", "eval/long/scenario.mjs", "eval/long/run.mjs", "eval/long/score.mjs"];
	files.push("research/model-failures-2026.json", "eval/model-failures-cases.mjs");
	files.push("research/coverage-matrix.json", "eval/agent-cases.mjs", "eval/agent-routing.mjs");
	const hashes = Object.fromEntries(files.map((file) => [file, createHash("sha256").update(readFileSync(join(ROOT, file))).digest("hex")]));
	const configPath = join(homedir(), ".pi", "agent", "eng-protocol.json");
	const parsed = parseConfig(existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}, DEFAULT_CONFIG, configPath);
	if (parsed.errors.length) throw new Error("Invalid eng-protocol evaluation configuration; inspect /protocol status");
	const { enabled: _enabled, decision, ...selection } = parsed.config;
	return {
		model: MODEL, thinking: "medium", node: process.version,
		commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
		hashes,
		config: { ...selection, enabled: true, decision: { provider: decision.provider, endpoint: decision.endpoint, model: decision.model, timeoutMs: decision.timeoutMs, fallback: decision.fallback, retryAfterMs: decision.retryAfterMs, structuredOutput: decision.structuredOutput, maxOutputTokens: decision.maxOutputTokens } },
	};
}
