import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PLAN_INSTRUCTION } from "../guidance.ts";

/** Same prompt sections as the plugin arm; only dynamic decisions are absent. */
export default function (pi: ExtensionAPI) {
	const protocol = readFileSync(new URL("../protocol.md", import.meta.url), "utf8");
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.engineering_protocol = protocol;
		event.systemPromptOptions.sections.engineering_plan = PLAN_INSTRUCTION;
	});
}
