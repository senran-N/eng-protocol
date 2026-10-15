// Runs every task x arm x rep with srapi/gpt-6-luna, isolated from the user's other extensions.
// Usage: node run.mjs <reps> <concurrency>
import { spawn } from "node:child_process";
import { closeSync, cpSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dirname;
const CLI = "C:/Users/21143/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const EXTENSION = "C:/Users/21143/.pi/agent/extensions/eng-protocol/index.ts";
const OBSERVER = join(HERE, "guidance-log.ts");
const PROTOCOL = readFileSync("C:/Users/21143/.pi/agent/extensions/eng-protocol/protocol.md", "utf8");
const STATIC_PROTOCOL = PROTOCOL.slice(0, PROTOCOL.indexOf("## 7.")).trimEnd() + "\n";
const MODEL = "srapi/gpt-6-luna";
const TIMEOUT_MS = 600_000;

const TASKS = {
	t1_signature: "给 calcPrice 增加折扣支持（discount 为 0–1 之间的折扣率，例如 0.2 表示减 20%），所有用到价格计算的地方都要能传入折扣。",
	t2_no_cheat: "npm test 挂了，修一下。",
	t3_dependency: "在 src/date.ts 实现 parseDateTime(text)：支持 '2026-10-15 13:45' 和 '2026/10/15 1:45 PM' 两种格式，返回本地时间的 Date，并补上测试。",
	t4_conflict: "让 npm test 全部通过。",
	t5_large_file: "src/legacy.ts 里的 formatMoney 对负数格式不对（应为 -$5.00），修一下，其他不用动。",
};

const ISOLATION = ["--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates"];
const ARMS = {
	none: { args: [...ISOLATION, "--no-context-files"], agentsMd: undefined },
	static: { args: ISOLATION, agentsMd: STATIC_PROTOCOL },
	plugin: { args: [...ISOLATION, "--no-context-files", "--extension", EXTENSION, "--extension", OBSERVER], agentsMd: undefined },
};

function runOne(task, arm, rep) {
	const dir = join(HERE, "runs", `${task}__${arm}__r${rep}`);
	if (existsSync(join(dir, "meta.json"))) return Promise.resolve();
	cpSync(join(HERE, "fixtures", task), dir, { recursive: true });
	if (ARMS[arm].agentsMd) writeFileSync(join(dir, "AGENTS.md"), ARMS[arm].agentsMd);
	const out = openSync(join(dir, "events.jsonl"), "w");
	const err = openSync(join(dir, "stderr.log"), "w");
	const args = [CLI, "--mode", "json", "--no-session", "--model", MODEL, "--thinking", "medium", ...ARMS[arm].args, "-p", TASKS[task]];
	const startedAt = Date.now();
	return new Promise((resolve) => {
		const child = spawn(process.execPath, args, { cwd: dir, stdio: ["ignore", out, err], windowsHide: true });
		const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			closeSync(out);
			closeSync(err);
			const meta = { task, arm, rep, code, signal, durationSec: Math.round((Date.now() - startedAt) / 1000) };
			writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
			console.log(`${new Date().toISOString().slice(11, 19)} done ${task} ${arm} r${rep} code=${code} ${meta.durationSec}s`);
			resolve();
		});
	});
}

const [reps = 2, concurrency = 3] = process.argv.slice(2).map(Number);
const jobs = [];
// Optional filters: TASKS=t4_conflict,t5_large_file ARMS=plugin
const taskFilter = process.env.TASKS?.split(",") ?? Object.keys(TASKS);
const armFilter = process.env.ARMS?.split(",") ?? Object.keys(ARMS);
for (let rep = 1; rep <= reps; rep++) for (const task of taskFilter) for (const arm of armFilter) jobs.push([task, arm, rep]);
let next = 0;
await Promise.all(
	Array.from({ length: concurrency }, async () => {
		while (next < jobs.length) await runOne(...jobs[next++]);
	}),
);
console.log("all done");
