import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agencyInstruction, DEFAULT_CONFIG, parseConfig, parseProjectConfig, PLAN_INSTRUCTION } from "../guidance.ts";

/** Same prompt sections as the plugin arm; only dynamic decisions are absent. */
export default function (pi: ExtensionAPI) {
	const protocol = readFileSync(new URL("../protocol.md", import.meta.url), "utf8");
	pi.on("before_agent_start", (event, ctx) => {
		let config = DEFAULT_CONFIG;
		for (const [path, parse] of [[join(homedir(), ".pi", "agent", "eng-protocol.json"), parseConfig], [join(ctx.cwd, ".pi", "eng-protocol.json"), parseProjectConfig]] as const) {
			try { config = parse(JSON.parse(readFileSync(path, "utf8")), config, path).config; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		event.systemPromptOptions.sections.engineering_protocol = protocol;
		event.systemPromptOptions.sections.engineering_plan = PLAN_INSTRUCTION;
		event.systemPromptOptions.sections.engineering_agency = agencyInstruction(config.agencyLevel);
		try { event.systemPromptOptions.sections.project_engineering_rules = readFileSync(join(ctx.cwd, ".pi", "eng-protocol.md"), "utf8").trim(); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	});
}
