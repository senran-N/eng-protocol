// HTTP client for a System One decision endpoint (choice questions -> per-option probabilities).
import http from "node:http";
import https from "node:https";
import type { DecisionSource } from "./guidance.ts";

const MAX_RESPONSE_BYTES = 1_048_576;

// A fresh TLS handshake costs ~2 s on the first decision (measured); keep-alive brings later ones under 1 s.
let agents: { https: https.Agent; http: http.Agent } | undefined;

function getAgents() {
	agents ??= { https: new https.Agent({ keepAlive: true, timeout: 110_000 }), http: new http.Agent({ keepAlive: true, timeout: 110_000 }) };
	return agents;
}

export function closeDecisionClient(): void {
	agents?.https.destroy();
	agents?.http.destroy();
	agents = undefined;
}

/** One POST, no retries (every request is billed). Non-2xx bodies are discarded unread. */
export function requestDecision(source: DecisionSource, payload: unknown, signal: AbortSignal): Promise<unknown> {
	const url = new URL(source.endpoint);
	const secure = url.protocol === "https:";
	return new Promise((resolve, reject) => {
		const fail = (error: unknown) => reject(signal.aborted ? new Error(`决策请求超时或被取消（${url.host}）`) : error);
		const request = (secure ? https : http).request(
			url,
			{
				method: "POST",
				signal,
				agent: secure ? getAgents().https : getAgents().http,
				headers: { Authorization: `Bearer ${source.apiKey}`, "Content-Type": "application/json" },
			},
			(response) => {
				const status = response.statusCode ?? 0;
				if (status < 200 || status >= 300) {
					response.destroy();
					reject(new Error(`决策 API 返回 HTTP ${status}（${url.host}, model=${source.model}）`));
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.byteLength;
					if (size > MAX_RESPONSE_BYTES) {
						response.destroy(new Error(`决策 API 响应超过 1 MiB（${url.host}）`));
						return;
					}
					chunks.push(chunk);
				});
				response.on("error", fail);
				response.on("end", () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch {
						reject(new Error(`决策 API 返回了无效 JSON（${url.host}）`));
					}
				});
			},
		);
		request.on("error", fail);
		request.end(JSON.stringify(payload));
	});
}
