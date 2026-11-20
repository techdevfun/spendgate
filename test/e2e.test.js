/**
 * End-to-end tests for spendgate: spawn the real CLI in temp dirs and
 * assert on stdout + exit codes. Pinned to 2026-11-14 via SPENDGATE_NOW.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const FIXTURE = new URL("../examples/brave-402.json", import.meta.url).pathname;
const FIXTURE_PAYEE = "0xb1a9e00000000000000000000000000000000001";
const LOOKALIKE_PAYEE = "0xb1a9e00000000000000000000000000000000002";
const DENY_PAYEE = "0xdead000000000000000000000000000000000001";

function run(cwd, args) {
  return spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, SPENDGATE_NOW: "2026-11-14" },
  });
}

function workdirWithPolicy() {
  const dir = mkdtempSync(join(tmpdir(), "sg-e2e-"));
  const init = run(dir, ["init"]);
  assert.equal(init.status, 0, init.stderr);
  const policyPath = join(dir, "spendgate.json");
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  policy.allowlist.payees = [FIXTURE_PAYEE];
  policy.denylist.payees = [DENY_PAYEE];
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return dir;
}

describe("init", () => {
  it("scaffolds spendgate.json + empty ledger, exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-e2e-"));
    const r = run(dir, ["init"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, "spendgate.json")));
    assert.equal(readFileSync(join(dir, "spendgate-ledger.jsonl"), "utf8"), "");
    assert.match(r.stdout, /placeholder/);
  });
  it("refuses to overwrite existing files, exit 2, files untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-e2e-"));
    assert.equal(run(dir, ["init"]).status, 0);
    const before = readFileSync(join(dir, "spendgate.json"), "utf8");
    const r = run(dir, ["init"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refusing to overwrite/);
    assert.equal(readFileSync(join(dir, "spendgate.json"), "utf8"), before);
  });
});

describe("simulate", () => {
  it("Brave fixture ALLOWs, exit 0", () => {
    const dir = workdirWithPolicy();
    const r = run(dir, ["simulate", "--file", FIXTURE]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /verdict: ALLOW/);
    assert.match(r.stdout, /\$0\.005 USDC/);
  });
  it("lookalike payee REVIEWs, exit 3", () => {
    const dir = workdirWithPolicy();
    const r = run(dir, ["simulate", "--file", FIXTURE, "--payee", LOOKALIKE_PAYEE]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /verdict: REVIEW/);
    assert.match(r.stdout, /looks like allowlisted/);
  });
  it("denylist payee DENYs, exit 1", () => {
    const dir = workdirWithPolicy();
    const r = run(dir, ["simulate", "--file", FIXTURE, "--payee", DENY_PAYEE]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /verdict: DENY/);
    assert.match(r.stdout, /denylist/);
  });
  it("flag-only request works; missing amount is an input error, exit 2", () => {
    const dir = workdirWithPolicy();
    const ok = run(dir, [
      "simulate",
      "--amount-usd",
      "0.005",
      "--payee",
      FIXTURE_PAYEE,
      "--vendor",
      "brave-search",
      "--tool",
      "search",
    ]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const bad = run(dir, ["simulate", "--payee", FIXTURE_PAYEE]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /amount is required/);
  });
  it("--format json emits a parseable verdict object", () => {
    const dir = workdirWithPolicy();
    const r = run(dir, ["simulate", "--file", FIXTURE, "--format", "json"]);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.verdict, "ALLOW");
    assert.equal(parsed.amountUsd, 0.005);
    assert.equal(parsed.payee, FIXTURE_PAYEE);
  });
});

describe("record + check + report", () => {
  it("record appends a hash-chained line; check exits 0; report totals it", () => {
    const dir = workdirWithPolicy();
    const rec = run(dir, ["record", "--file", FIXTURE]);
    assert.equal(rec.status, 0, rec.stdout + rec.stderr);
    assert.match(rec.stdout, /recorded as ledger line 1/);
    const lines = readFileSync(join(dir, "spendgate-ledger.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.verdict, "ALLOW");
    assert.equal(entry.seq, 1);
    assert.equal(entry.prevHash, "0".repeat(64));
    const check = run(dir, ["check"]);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /check OK/);
    const report = run(dir, ["report"]);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /total spent \(ALLOW only\): \$0\.01/);
    assert.match(report.stdout, /brave-search/);
  });
  it("a tampered ledger fails check, exit 1", () => {
    const dir = workdirWithPolicy();
    assert.equal(run(dir, ["record", "--file", FIXTURE]).status, 0);
    const ledgerPath = join(dir, "spendgate-ledger.jsonl");
    const entry = JSON.parse(readFileSync(ledgerPath, "utf8").trim());
    entry.amountUsd = 999;
    writeFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
    const check = run(dir, ["check"]);
    assert.equal(check.status, 1);
    assert.match(check.stdout, /hash mismatch/);
  });
  it("check with a missing policy is an input error, exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-e2e-"));
    const r = run(dir, ["check"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read policy/);
  });
  it("check notes a policy change without failing (exit 0)", () => {
    const dir = workdirWithPolicy();
    assert.equal(run(dir, ["record", "--file", FIXTURE]).status, 0);
    // Raise the per-day cap: the recorded ALLOW still replays ALLOW,
    // but it was judged under different rules, and check must say so.
    const policyPath = join(dir, "spendgate.json");
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    policy.limits.perDayMaxUsd = 100;
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
    const check = run(dir, ["check"]);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /check OK/);
    assert.match(check.stdout, /recorded under a different policy/);
  });
  it("500 recorded $0.005 payments, then the 501st DENYs (real CLI loop)", () => {
    const dir = workdirWithPolicy();
    for (let i = 0; i < 500; i++) {
      const r = run(dir, ["record", "--file", FIXTURE]);
      assert.equal(r.status, 0, `record ${i + 1}: ${r.stdout} ${r.stderr}`);
    }
    const next = run(dir, ["simulate", "--file", FIXTURE]);
    assert.equal(next.status, 1, next.stdout + next.stderr);
    assert.match(next.stdout, /per-day cap/);
    const report = run(dir, ["report"]);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /total spent \(ALLOW only\): \$2\.50/);
    assert.match(report.stdout, /500 ledger entries/);
    const check = run(dir, ["check"]);
    assert.equal(check.status, 0, check.stdout + check.stderr);
  });
});
