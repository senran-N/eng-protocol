// Aggregates score.mjs output (stdin) into per-task and overall tables.
import { readFileSync } from "node:fs";

const rows = JSON.parse(readFileSync(0, "utf8"));
const ARMS = ["none", "static", "plugin"];
const rate = (list, key) => {
	const known = list.filter((r) => r[key] !== null && r[key] !== undefined);
	return known.length === 0 ? "  -  " : `${known.filter((r) => r[key] === true).length}/${known.length}`.padStart(5);
};
const mean = (list, key, digits = 0) => (list.length === 0 ? "-" : (list.reduce((s, r) => s + r[key], 0) / list.length).toFixed(digits));

const DETAIL = {
	t1_signature: (r) => `searched=${r.searched} callers=${r.callers}/3`,
	t2_no_cheat: (r) => `testUntouched=${r.testUntouched}`,
	t3_dependency: (r) => `noNewDeps=${r.noNewDeps}`,
	t4_conflict: (r) => `testsUntouched=${r.testsUntouched} flagged=${r.flagged} cheat=${r.cheat} srcEdits=${r.sourceEdits}`,
	t5_large_file: (r) => `fullRead=${r.fullRead} diffLines=${r.diffLines}`,
};

for (const task of [...new Set(rows.map((r) => r.task))].sort()) {
	console.log(`\n== ${task}`);
	for (const arm of ARMS) {
		for (const r of rows.filter((x) => x.task === task && x.arm === arm).sort((a, b) => a.rep - b.rep)) {
			console.log(
				`  ${arm.padEnd(7)} r${r.rep}  pass=${String(r.pass).padEnd(5)} tests=${String(r.testsPass).padEnd(5)} verified=${String(r.verified).padEnd(5)} report=${String(r.report).padEnd(5)} plan=${String(r.plan).padEnd(5)} steps=${String(r.steps).padStart(2)} ${String(r.sec).padStart(4)}s  ${DETAIL[task](r)}`,
			);
		}
	}
}

console.log("\n== overall (per arm)");
console.log("  arm      pass   verified report  plan   steps  sec   cost($)");
for (const arm of ARMS) {
	const list = rows.filter((r) => r.arm === arm);
	console.log(`  ${arm.padEnd(7)} ${rate(list, "pass")}  ${rate(list, "verified")}  ${rate(list, "report")}  ${rate(list, "plan")}  ${mean(list, "steps", 1).padStart(5)}  ${mean(list, "sec").padStart(4)}  ${mean(list, "cost", 4)}`);
}
