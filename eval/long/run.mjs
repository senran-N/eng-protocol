// Drives one Pi RPC session per (arm, rep) through every turn of scenario.mjs.
// Usage: node run.mjs <reps> <concurrency>      (optional env ARMS=static,plugin)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { FIXTURE, TURNS } from "./scenario.mjs";

const HERE = import.meta.dirname;
const CLI = "C:/Users/21143/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const PLUGIN_DIR = join(HERE, "..", "..");
const PROTOCOL = readFileSync(join(PLUGIN_DIR, "protocol.md"), "utf8");
const STATIC_PROTOCOL = PROTOCOL.slice(0, PROTOCOL.indexOf("## 7.")).trimEnd() + "\n";
const MODEL = "srapi/gpt-6-luna";
const TURN_TIMEOUT_MS = 15 * 60_000;

const ISOLATION = ["--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates"];
const ARMS = {
	static: { args: ISOLATION, agentsMd: STATIC_PROTOCOL },
	plugin: { args: [...ISOLATION, "--no-context-files", "--extension", join(PLUGIN_DIR, "index.ts"), "--extension", join(HERE, "..", "guidance-log.ts")], agentsMd: undefined },
};

function writeFiles(dir, files) {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
}

function snapshot(dir, tag) {
	const git = (...args) => execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@local", ...args], { cwd: dir, stdio: "pipe" });
	git("add", "-A");
	git("commit", "-q", "--allow-empty", "-m", tag);
	git("tag", tag);
}

function countLines(path) {
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
}

async function runSession(arm, rep) {
	const dir = join(HERE, "runs", `${arm}__r${rep}`);
	if (existsSync(join(dir, "meta.json"))) return;
	rmSync(dir, { recursive: true, force: true });
	writeFiles(dir, { ...FIXTURE, ...(ARMS[arm].agentsMd ? { "AGENTS.md": ARMS[arm].agentsMd } : {}) });
	execFileSync("git", ["init", "-q"], { cwd: dir });
	snapshot(dir, "fixture");

	const args = [CLI, "--mode", "rpc", "--no-session", "--model", MODEL, "--thinking", "medium", ...ARMS[arm].args];
	const child = spawn(process.execPath, args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	child.stderr.on("data", (chunk) => writeFileSync(join(dir, "stderr.log"), chunk, { flag: "a" }));
	const lines = createInterface({ input: child.stdout });
	let onLine = () => {};
	lines.on("line", (line) => onLine(line));

	const turns = [];
	const turnsToRun = TURNS.slice(0, Number(process.env.MAX_TURNS ?? TURNS.length));
	for (const [index, turn] of turnsToRun.entries()) {
		const n = index + 1;
		if (turn.setup) writeFiles(dir, turn.setup);
		snapshot(dir, `t${n}-start`);
		const eventsPath = join(dir, `turn-${n}.jsonl`);
		const startedAt = Date.now();
		const outcome = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve("timeout"), TURN_TIMEOUT_MS);
			onLine = (line) => {
				writeFileSync(eventsPath, line + "\n", { flag: "a" });
				let record;
				try {
					record = JSON.parse(line);
				} catch {
					return;
				}
				const notStarted = record.type === "response" && record.command === "prompt" && (!record.success || record.data?.disposition !== "started");
				if (record.type === "agent_settled" || notStarted) {
					clearTimeout(timer);
					resolve(notStarted ? `not-started:${JSON.stringify(record.data ?? record.error)}` : "settled");
				}
			};
			child.stdin.write(JSON.stringify({ id: `turn-${n}`, type: "prompt", message: turn.prompt }) + "\n");
		});
		snapshot(dir, `t${n}-end`);
		const testsPass = spawnSync(process.execPath, ["--test"], { cwd: dir, stdio: "ignore", timeout: 120_000 }).status === 0;
		turns.push({ n, id: turn.id, outcome, sec: Math.round((Date.now() - startedAt) / 1000), testsPass, guidanceLines: countLines(join(dir, "guidance.log")) });
		console.log(`${new Date().toISOString().slice(11, 19)} ${arm} r${rep} turn ${n} ${turn.id} ${outcome} ${turns.at(-1).sec}s tests=${testsPass}`);
		if (outcome === "timeout") break;
	}
	child.stdin.end();
	child.kill();
	writeFileSync(join(dir, "meta.json"), JSON.stringify({ arm, rep, turns }, null, 2));
}

const [reps = 3, concurrency = 3] = process.argv.slice(2).map(Number);
const armFilter = process.env.ARMS?.split(",") ?? Object.keys(ARMS);
const jobs = [];
for (let rep = 1; rep <= reps; rep++) for (const arm of armFilter) jobs.push([arm, rep]);
let next = 0;
await Promise.all(
	Array.from({ length: concurrency }, async () => {
		while (next < jobs.length) await runSession(...jobs[next++]);
	}),
);
console.log("all done");
