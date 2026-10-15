// Read-only observer for the plugin arm: logs injected card titles and the extracted plan per request.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildDecisionState } from "file:///C:/Users/21143/.pi/agent/extensions/eng-protocol/guidance.ts";

export default function (pi: ExtensionAPI) {
	let plan = "";
	pi.on("context_with_system", async (event) => {
		plan = buildDecisionState(event.messages as never, { sendReasoning: true }).agentPlan;
	});
	pi.on("before_provider_request", async (event) => {
		const titles = [...JSON.stringify(event.payload).matchAll(/【([^】]+)】/g)].map((m) => m[1]);
		appendFileSync("guidance.log", `${JSON.stringify({ titles, plan: plan.slice(0, 200) })}\n`);
	});
}
