// Observations, not a proof that investigation or acceptance is complete.
import { createHash } from "node:crypto";
import type { TranscriptMessage } from "./guidance.ts";

export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const parts = (message: TranscriptMessage): Record<string, unknown>[] => Array.isArray(message.content) ? message.content.map(record) : [];

export interface ToolObservation {
	id: string;
	tool: string;
	start: number;
	end?: number;
	kind: "read" | "write" | "check" | "unknown";
	path?: string;
	status: "ok" | "error" | "pending" | "unknown";
	/** Full arguments and result content, excluding invocation IDs and timestamps. */
	fingerprint: string;
	/** Exact target/error identities; text matches are signals, not root-cause diagnoses. */
	failureFingerprint?: string;
	missingToolchainSignals?: string[];
}

// Shell is intentionally not classified as read-only. Aliases, scripts, flags and
// compound commands cannot be proven side-effect-free by their leading word.
const CHECK = /^(?:node\s+--test(?:\s+[\w./\\:@=-]+)*|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|lint)|(?:npx\s+)?(?:tsc|vitest|jest)(?:\s+[\w./\\:@=-]+)*)\s*$/;

export function observeTools(messages: readonly TranscriptMessage[]): ToolObservation[] {
	const results = new Map<string, { message: TranscriptMessage; index: number }>();
	for (const [index, message] of messages.entries()) {
		if (message.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, { message, index });
	}
	return messages.flatMap((message, start) => message.role !== "assistant" ? [] : parts(message).flatMap((call): ToolObservation[] => {
		if (call.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") return [];
		const args = record(call.arguments);
		const result = results.get(call.id);
		const details = record(result?.message.details);
		const structured = record(result?.message.structuredContent);
		const exit = structured.exit_code ?? details.exitCode ?? details.exit_code;
		const command = typeof args.command === "string" ? args.command : "";
		const kind = ["read", "grep", "find", "ls"].includes(call.name) ? "read"
			: ["edit", "write", "apply_patch"].includes(call.name) ? "write"
			: ["bash", "powershell"].includes(call.name) && CHECK.test(command) ? "check" : "unknown";
		const status = !result || result.index <= start ? "pending" : result.message.isError || (typeof exit === "number" && exit !== 0) ? "error"
			: kind === "check" ? (exit === 0 ? "ok" : "unknown") : "ok";
		const output = typeof result?.message.content === "string" ? result.message.content : (result ? parts(result.message) : []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
		const missingToolchainSignals = status === "error" && ["bash", "powershell"].includes(call.name) ? [
			[/command not found|is not recognized as (?:an internal|the name of a cmdlet)/i, "command-unavailable"],
			[/missing script:\s*["']?(?:test|build|lint|typecheck)/i, "script-unavailable"],
			[/cannot find (?:module|package)|modulenotfounderror: no module named/i, "module-unavailable"],
		].filter(([pattern]) => (pattern as RegExp).test(output)).map(([, label]) => label as string) : [];
		return [{ id: call.id, tool: call.name, start, end: result && result.index > start ? result.index : undefined, kind,
			path: typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined,
			failureFingerprint: status === "error" ? digest([call.name, args, output.trim(), exit]) : undefined, missingToolchainSignals,
			status, fingerprint: digest([call.name, args, result?.message.content, result?.message.isError, exit]) }];
	}));
}

export interface SessionLedger {
	source: "visible" | "branch";
	/** Absence of a record is never proof of no action outside this history. */
	coverage: "observed-history-only";
	readFiles: number;
	readSamples: string[];
	writtenFiles: number;
	writeSamples: string[];
	completedWrites: number;
	possibleMutations: number;
	pendingTools: number;
	lastWrite?: { id: string; position: number };
	lastCheck?: { id: string; start: number; end?: number; status: ToolObservation["status"] };
	lastError?: { id: string; position: number };
	validation: "check-after-write" | "check-predates-write" | "no-completed-check-after-write" | "unknown";
	consecutiveReads: number;
	consecutiveToolFailures: number;
	repeatedFailureCount: number;
	missingToolchainSignals: string[];
	changeRevision: string;
	readRevision: string;
}

export function buildLedger(messages: readonly TranscriptMessage[], source: SessionLedger["source"] = "visible", observations = observeTools(messages)): SessionLedger {
	const reads = observations.filter((item) => item.kind === "read" && item.status === "ok");
	const writes = observations.filter((item) => item.kind === "write" && item.status === "ok");
	// Even failed writes or test scripts can have effects. Do not turn them into a clean workspace.
	const possible = observations.filter((item) => item.kind === "unknown" || (item.kind === "write" && item.status !== "ok"));
	const lastWrite = writes.sort((a, b) => a.end! - b.end!).at(-1);
	const lastCheck = observations.filter((item) => item.kind === "check").at(-1);
	const lastError = observations.filter((item) => item.status === "error").sort((a, b) => a.end! - b.end!).at(-1);
	const completed = observations.slice().sort((a, b) => (a.end ?? Infinity) - (b.end ?? Infinity));
	const latest = completed.at(-1);
	let consecutiveToolFailures = 0;
	let repeatedFailureCount = 0;
	for (const item of completed.slice().reverse()) {
		if (item.status !== "error") break;
		consecutiveToolFailures++;
		if (item.failureFingerprint === latest?.failureFingerprint && repeatedFailureCount === consecutiveToolFailures - 1) repeatedFailureCount++;
	}
	const readPaths = [...new Set(reads.filter((item) => item.tool === "read" && item.path).map((item) => item.path!))];
	const writePaths = [...new Set(writes.flatMap((item) => item.path ? [item.path] : []))];
	let consecutiveReads = 0;
	for (const item of observations.slice().sort((a, b) => (a.end ?? Infinity) - (b.end ?? Infinity)).reverse()) {
		if (item.kind !== "read" || item.status !== "ok") break;
		consecutiveReads++;
	}
	let validation: SessionLedger["validation"] = "unknown";
	if (lastWrite && !possible.some((item) => (item.end ?? Infinity) >= lastWrite.end!)) {
		validation = !lastCheck?.end || lastCheck.status !== "ok" ? "no-completed-check-after-write"
			: lastCheck.start > lastWrite.end! ? "check-after-write" : "check-predates-write";
	}
	return {
		source, coverage: "observed-history-only", readFiles: readPaths.length, readSamples: readPaths.slice(-5).map((path) => path.slice(-160)),
		writtenFiles: writePaths.length, writeSamples: writePaths.slice(-5).map((path) => path.slice(-160)), completedWrites: writes.length,
		possibleMutations: possible.length, pendingTools: observations.filter((item) => item.status === "pending").length,
		lastWrite: lastWrite && { id: lastWrite.id, position: lastWrite.end! },
		lastCheck: lastCheck && { id: lastCheck.id, start: lastCheck.start, end: lastCheck.end, status: lastCheck.status },
		lastError: lastError && { id: lastError.id, position: lastError.end! }, validation, consecutiveReads,
		consecutiveToolFailures, repeatedFailureCount, missingToolchainSignals: latest?.status === "error" ? latest.missingToolchainSignals ?? [] : [],
		changeRevision: digest(observations.filter((item) => item.kind !== "read" || item.status !== "ok")),
		readRevision: digest([...new Set(reads.map((item) => item.fingerprint))].sort()),
	};
}

/** Reconstruct only the active branch, honoring edits/omissions before using old observations. */
export function branchMessages(entries: readonly { type: string; id: string; message?: unknown; targetId?: string; replacement?: { content: unknown } | null }[]): TranscriptMessage[] {
	const edits = new Map(entries.filter((entry) => entry.type === "context_edit").map((entry) => [entry.targetId, entry.replacement]));
	return entries.flatMap((entry): TranscriptMessage[] => {
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return [];
		const edit = edits.get(entry.id);
		if (edit === null) return [];
		const message = entry.message as TranscriptMessage;
		return [{ ...message, ...(edit ? { content: edit.content } : {}) }];
	});
}
