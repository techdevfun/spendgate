/**
 * Bench: time verdict evaluation + ledger appends over the demo workload.
 * 200 evaluate() calls on a 500-entry ledger, plus 200 appends to a temp
 * ledger. Prints median + p95. Target: p95 < 50 ms for a verdict.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEntry } from "../dist/ledger.js";
import { samplePolicy } from "../dist/policy.js";
import { evaluate } from "../dist/verdict.js";

const policy = samplePolicy();
policy.allowlist.payees = ["0xb1a9e00000000000000000000000000000000001"];
policy.denylist.payees = ["0xdead000000000000000000000000000000000001"];

const history = [];
for (let i = 1; i <= 500; i++) {
  history.push({
    seq: i,
    ts: "2026-11-14T12:00:00.000Z",
    date: "2026-11-14",
    verdict: "ALLOW",
    amountUsd: 0.005,
    payee: "0xb1a9e00000000000000000000000000000000001",
    vendor: "brave-search",
    tool: "search",
    host: "search.agent.s.brave.app",
    reasons: ["within per-call max $1.00"],
    prevHash: "0".repeat(64),
    hash: "a".repeat(64),
  });
}

const req = {
  amountMicro: 5000,
  amountUsd: 0.005,
  payee: "0xb1a9e00000000000000000000000000000000001",
  vendor: "brave-search",
  tool: "search",
  host: "search.agent.s.brave.app",
  date: "2026-11-14",
};

function quantile(sorted, q) {
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

const verdictSamples = [];
for (let i = 0; i < 200; i++) {
  const t0 = performance.now();
  evaluate(policy, req, history);
  verdictSamples.push(performance.now() - t0);
}
verdictSamples.sort((a, b) => a - b);
console.log(
  `evaluate() on a 500-entry ledger (200 runs): median ${quantile(verdictSamples, 0.5).toFixed(3)} ms, p95 ${quantile(verdictSamples, 0.95).toFixed(3)} ms, max ${verdictSamples[verdictSamples.length - 1].toFixed(3)} ms`,
);

const dir = mkdtempSync(join(tmpdir(), "sg-bench-"));
const ledgerPath = join(dir, "ledger.jsonl");
writeFileSync(ledgerPath, "", "utf8");
const appendSamples = [];
for (let i = 0; i < 200; i++) {
  const t0 = performance.now();
  appendEntry(ledgerPath, {
    ts: "2026-11-14T12:00:00.000Z",
    date: "2026-11-14",
    verdict: "ALLOW",
    amountUsd: 0.005,
    payee: "0xb1a9e00000000000000000000000000000000001",
    vendor: "brave-search",
    tool: "search",
    host: "search.agent.s.brave.app",
    reasons: ["within per-call max $1.00"],
  });
  appendSamples.push(performance.now() - t0);
}
appendSamples.sort((a, b) => a - b);
console.log(
  `appendEntry() growing ledger to 200 lines (200 runs): median ${quantile(appendSamples, 0.5).toFixed(3)} ms, p95 ${quantile(appendSamples, 0.95).toFixed(3)} ms, max ${appendSamples[appendSamples.length - 1].toFixed(3)} ms`,
);
