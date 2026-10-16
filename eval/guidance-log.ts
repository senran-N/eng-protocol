// Read-only observer for the plugin arm: logs injected card titles and the extracted plan per request.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildDecisionState } from "../guidance.ts";

export default function (pi: ExtensionAPI) {
	let plan = "";
	pi.on("context_with_system", async (event) => {
		plan = buildDecisionState(event.messages as never, { sendReasoning: true }).agentPlan?.text ?? "";
	});
	pi.on("before_provider_request", async (event) => {
		const titles = [...JSON.stringify(event.payload).matchAll(/【([^】]+)】/g)].map((m) => m[1]);
		const path = process.env.ENG_PROTOCOL_GUIDANCE_LOG;
		if (path) appendFileSync(path, `${JSON.stringify({ titles, plan: plan.slice(0, 200) })}\n`);
	});
}
