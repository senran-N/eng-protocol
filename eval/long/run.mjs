// Drives one Pi RPC session per (arm, rep) through every turn of scenario.mjs.
// Usage: node run.mjs <reps> <concurrency>      (optional env ARMS=static,plugin)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { FIXTURE, TURNS } from "./scenario.mjs";
import { ARMS, CLI, MODEL, experimentMetadata } from "../experiment.mjs";
import { checkAcceptance } from "../checks.mjs";

const HERE = import.meta.dirname;
const TURN_TIMEOUT_MS = 15 * 60_000;
const experiment = experimentMetadata();

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
	const dir = join(HERE, process.env.RUNS_DIR ?? "runs", `${arm}__r${rep}`);
	if (existsSync(dir)) throw new Error(`Use a fresh RUNS_DIR; refusing to mix experiments in ${dir}`);
	writeFiles(dir, { ...FIXTURE, ".pi/eng-protocol.json": JSON.stringify({ enabled: true }) });
	execFileSync("git", ["init", "-q"], { cwd: dir });
	snapshot(dir, "fixture");

	const args = [CLI, "--mode", "rpc", "--no-session", "--model", MODEL, "--thinking", "medium", ...ARMS[arm]];
	const logDirectory = join(HERE, process.env.RUNS_DIR ?? "runs", "logs");
	mkdirSync(logDirectory, { recursive: true });
	const guidancePath = join(logDirectory, `${arm}__r${rep}.jsonl`);
	const child = spawn(process.execPath, args, { cwd: dir, env: { ...process.env, ENG_PROTOCOL_GUIDANCE_LOG: guidancePath }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	child.stderr.on("data", (chunk) => writeFileSync(join(dir, "stderr.log"), chunk, { flag: "a" }));
	const lines = createInterface({ input: child.stdout });
	let onLine = () => {};
	let onStopped = () => {};
	const stopped = new Promise((resolve) => {
		child.once("error", () => { onStopped(); resolve(); });
		child.once("close", () => { onStopped(); resolve(); });
	});
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
			onStopped = () => { clearTimeout(timer); resolve("process-stopped"); };
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
		if (outcome !== "settled") {
			child.kill();
			await stopped;
		}
		snapshot(dir, `t${n}-end`);
		const testsPass = spawnSync(process.execPath, ["--test"], { cwd: dir, stdio: "ignore", timeout: 120_000 }).status === 0;
		const acceptance = checkAcceptance(turn.id, dir);
		turns.push({ n, id: turn.id, outcome, sec: Math.round((Date.now() - startedAt) / 1000), testsPass, acceptancePass: acceptance?.pass ?? null, acceptanceError: acceptance?.error, guidanceLines: countLines(guidancePath) });
		console.log(`${new Date().toISOString().slice(11, 19)} ${arm} r${rep} turn ${n} ${turn.id} ${outcome} ${turns.at(-1).sec}s tests=${testsPass}`);
		if (outcome !== "settled") break;
	}
	child.stdin.end();
	child.kill();
	await stopped;
	writeFileSync(join(dir, "meta.json"), JSON.stringify({ arm, rep, turns, experiment }, null, 2));
}

const [reps = 3, concurrency = 3] = process.argv.slice(2).map(Number);
const armFilter = process.env.ARMS?.split(",") ?? ["static", "plugin"];
if (![reps, concurrency].every((value) => Number.isInteger(value) && value > 0) || armFilter.some((arm) => !Object.hasOwn(ARMS, arm))) throw new Error("Invalid repetitions, concurrency or ARMS");
const jobs = [];
for (let rep = 1; rep <= reps; rep++) for (const arm of armFilter) jobs.push([arm, rep]);
let next = 0;
await Promise.all(
	Array.from({ length: concurrency }, async () => {
		while (next < jobs.length) await runSession(...jobs[next++]);
	}),
);
console.log("all done");
