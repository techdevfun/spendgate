/**
 * Unit tests for spendgate. Pure functions only - no CLI spawns here
 * (those live in e2e.test.js). Run with: npm test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  appendEntry,
  hashEntry,
  loadLedger,
  verifyChain,
  GENESIS_PREV_HASH,
} from "../dist/ledger.js";
import { findLookalike, levenshtein } from "../dist/lookalike.js";
import { formatUsd, formatUsdExact, isValidDate, usdToMicro } from "../dist/money.js";
import { parseBaseUnits, parsePaymentFile } from "../dist/parse402.js";
import { parsePolicy, samplePolicy, hashPolicy } from "../dist/policy.js";
import { buildReport } from "../dist/report.js";
import { evaluate } from "../dist/verdict.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE_PAYEE = "0xb1a9e00000000000000000000000000000000001";
const LOOKALIKE_PAYEE = "0xb1a9e00000000000000000000000000000000002";
const DENY_PAYEE = "0xdead000000000000000000000000000000000001";

function policyWith(overrides = {}) {
  const p = samplePolicy();
  p.allowlist.payees = [FIXTURE_PAYEE];
  p.denylist.payees = [DENY_PAYEE];
  return { ...p, ...overrides };
}

function req(overrides = {}) {
  return {
    amountMicro: 5000,
    amountUsd: 0.005,
    payee: FIXTURE_PAYEE,
    vendor: "brave-search",
    tool: "search",
    host: "search.agent.s.brave.app",
    date: "2026-11-14",
    ...overrides,
  };
}

function allowEntry(seq, amountUsd, date = "2026-11-14", vendor = "brave-search", tool = "search") {
  return {
    seq,
    ts: `${date}T12:00:00.000Z`,
    date,
    verdict: "ALLOW",
    amountUsd,
    payee: FIXTURE_PAYEE,
    vendor,
    tool,
    host: "search.agent.s.brave.app",
    reasons: ["within per-call max $1.00"],
    prevHash: GENESIS_PREV_HASH,
    hash: "x".repeat(64),
  };
}

describe("money", () => {
  it("500 x $0.005 is exactly $2.50 in micro-dollars (no float drift)", () => {
    assert.equal(usdToMicro(0.005) * 500, 2_500_000);
    assert.equal(usdToMicro(2.5), 2_500_000);
  });
  it("formats $0.005 as $0.01 (rounded) and $0.005 exact", () => {
    assert.equal(formatUsd(5000), "$0.01");
    assert.equal(formatUsdExact(5000), "$0.005");
    assert.equal(formatUsd(2_500_000), "$2.50");
  });
  it("rejects impossible dates", () => {
    assert.equal(isValidDate("2026-02-30"), false);
    assert.equal(isValidDate("2026-13-01"), false);
    assert.equal(isValidDate("2026-11-14"), true);
    assert.equal(isValidDate("14-11-2026"), false);
  });
});

describe("lookalike", () => {
  it("levenshtein distances are correct", () => {
    assert.equal(levenshtein("abc", "abc"), 0);
    assert.equal(levenshtein("abc", "abd"), 1);
    assert.equal(levenshtein("abc", "axd"), 2);
    assert.equal(levenshtein("", "ab"), 2);
  });
  it("distance 1 and 2 are lookalikes, distance 3 is not", () => {
    assert.equal(findLookalike(LOOKALIKE_PAYEE, [FIXTURE_PAYEE], 2)?.distance, 1);
    const twoAway = "0xb1a9e00000000000000000000000000000000013";
    assert.equal(findLookalike(twoAway, [FIXTURE_PAYEE], 2)?.distance, 2);
    const threeAway = "0xb1a9e00000000000000000000000000000000123";
    assert.equal(findLookalike(threeAway, [FIXTURE_PAYEE], 2), null);
  });
  it("an exact allowlist address is NOT a lookalike", () => {
    assert.equal(findLookalike(FIXTURE_PAYEE, [FIXTURE_PAYEE], 2), null);
  });
});

describe("verdict", () => {
  it("allows a $0.005 Brave payment inside every cap", () => {
    const ev = evaluate(policyWith(), req(), []);
    assert.equal(ev.verdict, "ALLOW");
    assert.equal(ev.reasons.length, 1);
  });
  it("per-call max: exactly $1.00 ALLOWs, $1.000001 DENYs", () => {
    // Raise the approval threshold for this test so only the per-call
    // rule is in play ($1.00 would otherwise REVIEW on approval).
    const p = policyWith();
    p.requireApprovalAboveUsd = 100;
    const at = evaluate(p, req({ amountMicro: 1_000_000, amountUsd: 1 }), []);
    assert.equal(at.verdict, "ALLOW");
    const over = evaluate(p, req({ amountMicro: 1_000_001, amountUsd: 1.000001 }), []);
    assert.equal(over.verdict, "DENY");
    assert.match(over.reasons.join(" "), /per-call max/);
  });
  it("500 x $0.005 ALLOW, the 501st DENYs on the per-day cap", () => {
    const history = [];
    for (let i = 0; i < 500; i++) {
      history.push(allowEntry(i + 1, 0.005));
    }
    const ev = evaluate(policyWith(), req(), history);
    assert.equal(ev.verdict, "DENY");
    assert.match(ev.reasons.join(" "), /per-day cap/);
    // And 499 prior payments still leave room for one more.
    const room = evaluate(policyWith(), req(), history.slice(0, 499));
    assert.equal(room.verdict, "ALLOW");
  });
  it("per-vendor cap DENYs when only that vendor is over", () => {
    const p = policyWith();
    p.limits.perVendorMaxUsd = { "brave-search": 1.0 };
    p.limits.perDayMaxUsd = 100;
    const history = [];
    for (let i = 0; i < 200; i++) history.push(allowEntry(i + 1, 0.005));
    const ev = evaluate(p, req(), history);
    assert.equal(ev.verdict, "DENY");
    assert.match(ev.reasons.join(" "), /per-vendor cap/);
  });
  it("per-tool cap DENYs when only that tool is over", () => {
    const p = policyWith();
    p.limits.perToolMaxUsd = { search: 1.0 };
    p.limits.perDayMaxUsd = 100;
    p.limits.perVendorMaxUsd = {};
    const history = [];
    for (let i = 0; i < 200; i++) history.push(allowEntry(i + 1, 0.005));
    const ev = evaluate(p, req(), history);
    assert.equal(ev.verdict, "DENY");
    assert.match(ev.reasons.join(" "), /per-tool cap/);
  });
  it("denylist payee and denylist host both DENY", () => {
    assert.equal(evaluate(policyWith(), req({ payee: DENY_PAYEE }), []).verdict, "DENY");
    const p = policyWith();
    p.denylist.hosts = ["search.agent.s.brave.app"];
    assert.equal(evaluate(p, req(), []).verdict, "DENY");
  });
  it("lookalike payee REVIEWs (distance 1)", () => {
    const ev = evaluate(policyWith(), req({ payee: LOOKALIKE_PAYEE }), []);
    assert.equal(ev.verdict, "REVIEW");
    assert.match(ev.reasons.join(" "), /looks like allowlisted/);
  });
  it("unknown payee REVIEWs when the allowlist is non-empty", () => {
    const ev = evaluate(
      policyWith(),
      req({
        payee: "0x2222222222222222222222222222222222222222",
        host: "unknown.example.com",
      }),
      [],
    );
    assert.equal(ev.verdict, "REVIEW");
    assert.match(ev.reasons.join(" "), /not on the allowlist/);
  });
  it("empty allowlist does not REVIEW unknown payees", () => {
    const p = policyWith();
    p.allowlist.payees = [];
    const ev = evaluate(p, req({ payee: "0x2222222222222222222222222222222222222222" }), []);
    assert.equal(ev.verdict, "ALLOW");
  });
  it("require-approval: at the threshold ALLOWs, above it REVIEWs", () => {
    const at = evaluate(policyWith(), req({ amountMicro: 250_000, amountUsd: 0.25 }), []);
    assert.equal(at.verdict, "ALLOW");
    const over = evaluate(policyWith(), req({ amountMicro: 500_000, amountUsd: 0.5 }), []);
    assert.equal(over.verdict, "REVIEW");
    assert.match(over.reasons.join(" "), /require-approval threshold/);
  });
  it("a higher per-day cap changes the 501st verdict (threshold override)", () => {
    const p = policyWith();
    p.limits.perDayMaxUsd = 100;
    p.limits.perVendorMaxUsd = {};
    p.limits.perToolMaxUsd = {};
    const history = [];
    for (let i = 0; i < 500; i++) history.push(allowEntry(i + 1, 0.005));
    assert.equal(evaluate(p, req(), history).verdict, "ALLOW");
  });
  it("spend on another day does not count toward today", () => {
    const history = [];
    for (let i = 0; i < 500; i++) {
      history.push(allowEntry(i + 1, 0.005, "2026-11-13"));
    }
    assert.equal(evaluate(policyWith(), req(), history).verdict, "ALLOW");
  });
});

describe("ledger hash chain", () => {
  function chainedLedger() {
    const dir = mkdtempSync(join(tmpdir(), "sg-ledger-"));
    const path = join(dir, "ledger.jsonl");
    writeFileSync(path, "", "utf8");
    const a = appendEntry(path, {
      ts: "2026-11-14T12:00:00.000Z",
      date: "2026-11-14",
      verdict: "ALLOW",
      amountUsd: 0.005,
      payee: FIXTURE_PAYEE,
      vendor: "brave-search",
      tool: "search",
      host: "search.agent.s.brave.app",
      reasons: ["within per-call max $1.00"],
    });
    const b = appendEntry(path, {
      ts: "2026-11-14T12:00:01.000Z",
      date: "2026-11-14",
      verdict: "DENY",
      amountUsd: 5,
      payee: DENY_PAYEE,
      vendor: "brave-search",
      tool: "search",
      host: "search.agent.s.brave.app",
      reasons: ["payee is on the denylist"],
    });
    return { path, a, b };
  }

  it("a ledger written by appendEntry verifies clean", () => {
    const { path } = chainedLedger();
    assert.deepEqual(verifyChain(loadLedger(path)), []);
  });
  it("appended entries link seq and prevHash", () => {
    const { a, b } = chainedLedger();
    assert.equal(a.seq, 1);
    assert.equal(a.prevHash, GENESIS_PREV_HASH);
    assert.equal(b.seq, 2);
    assert.equal(b.prevHash, a.hash);
    assert.equal(b.hash, hashEntry(b));
  });
  it("editing an amount breaks the chain", () => {
    const { path } = chainedLedger();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const edited = JSON.parse(lines[0]);
    edited.amountUsd = 999;
    lines[0] = JSON.stringify(edited);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    assert.ok(verifyChain(loadLedger(path)).length > 0);
  });
  it("deleting a middle line breaks the chain", () => {
    const { path } = chainedLedger();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${lines[1]}\n`, "utf8");
    const problems = verifyChain(loadLedger(path));
    assert.ok(problems.some((p) => /seq is 2, expected 1/.test(p)));
  });
});

describe("policy hash", () => {
  it("is stable for the same rules and changes when a cap changes", () => {
    const a = hashPolicy(parsePolicy(samplePolicy()));
    const b = hashPolicy(parsePolicy(samplePolicy()));
    assert.equal(a, b);
    assert.equal(a.length, 64);
    const changed = samplePolicy();
    changed.limits.perDayMaxUsd = 100;
    assert.notEqual(hashPolicy(parsePolicy(changed)), a);
  });
  it("appendEntry records the policy hash and the chain still verifies", () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-hash-"));
    const path = join(dir, "ledger.jsonl");
    writeFileSync(path, "", "utf8");
    const policyHash = hashPolicy(parsePolicy(samplePolicy()));
    const entry = appendEntry(path, {
      ts: "2026-11-14T12:00:00.000Z",
      date: "2026-11-14",
      verdict: "ALLOW",
      amountUsd: 0.005,
      payee: FIXTURE_PAYEE,
      vendor: "brave-search",
      tool: "search",
      host: "search.agent.s.brave.app",
      reasons: ["within per-call max $1.00"],
      policyHash,
    });
    assert.equal(entry.policyHash, policyHash);
    assert.equal(entry.hash, hashEntry(entry));
    assert.deepEqual(verifyChain(loadLedger(path)), []);
  });
  it("entries written before policyHash existed still load and verify", () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-hash-"));
    const path = join(dir, "ledger.jsonl");
    writeFileSync(path, "", "utf8");
    const entry = appendEntry(path, {
      ts: "2026-11-14T12:00:00.000Z",
      date: "2026-11-14",
      verdict: "ALLOW",
      amountUsd: 0.005,
      payee: FIXTURE_PAYEE,
      vendor: "brave-search",
      tool: "search",
      host: "search.agent.s.brave.app",
      reasons: ["within per-call max $1.00"],
    });
    assert.equal(entry.policyHash, undefined);
    const loaded = loadLedger(path);
    assert.equal(loaded[0].policyHash, undefined);
    assert.deepEqual(verifyChain(loaded), []);
  });
});

describe("parse402", () => {
  const fixture = new URL("../examples/brave-402.json", import.meta.url).pathname;
  it("parses the Brave v2 fixture: $0.005, eip155:8453, fixture payee", () => {
    const parsed = parsePaymentFile(fixture, { date: "2026-11-14" });
    assert.equal(parsed.request.amountMicro, 5000);
    assert.equal(parsed.request.amountUsd, 0.005);
    assert.equal(parsed.request.payee, FIXTURE_PAYEE);
    assert.equal(parsed.network, "eip155:8453");
    assert.equal(parsed.baseUnits, "5000");
    assert.equal(parsed.request.vendor, "brave-search");
    assert.equal(parsed.request.tool, "search");
  });
  it("converts base units with decimals (5000 units, 6 decimals = $0.005)", () => {
    assert.deepEqual(parseBaseUnits("5000", 6), { amountMicro: 5000, amountUsd: 0.005 });
    assert.deepEqual(parseBaseUnits("1000000", 6), { amountMicro: 1_000_000, amountUsd: 1 });
  });
  it("rejects a flat payment with a negative amount", () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-402-"));
    const path = join(dir, "bad.json");
    writeFileSync(
      path,
      JSON.stringify({ amountUsd: -1, payee: FIXTURE_PAYEE, vendor: "v", tool: "t" }),
      "utf8",
    );
    assert.throws(() => parsePaymentFile(path, { date: "2026-11-14" }), /non-negative/);
  });
  it("rejects a file with no amount at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-402-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ vendor: "v" }), "utf8");
    assert.throws(() => parsePaymentFile(path, { date: "2026-11-14" }), /no accepts/);
  });
});

describe("policy", () => {
  it("rejects version 2 and bad addresses and negative caps", () => {
    assert.throws(() => parsePolicy({ ...samplePolicy(), version: 2 }), /version/);
    assert.throws(
      () =>
        parsePolicy({
          ...samplePolicy(),
          allowlist: { payees: ["not-an-address"], hosts: [] },
        }),
      /not a 0x address/,
    );
    const bad = samplePolicy();
    bad.limits.perDayMaxUsd = -1;
    assert.throws(() => parsePolicy(bad), /non-negative/);
  });
  it("sample policy has the documented caps", () => {
    const p = samplePolicy();
    assert.equal(p.version, 1);
    assert.equal(p.network, "eip155:8453");
    assert.equal(p.limits.perCallMaxUsd, 1);
    assert.equal(p.limits.perDayMaxUsd, 2.5);
    assert.equal(p.requireApprovalAboveUsd, 0.25);
  });
});

describe("report", () => {
  it("totals by vendor/tool/day count ALLOW only", () => {
    const entries = [
      allowEntry(1, 0.005, "2026-11-14", "brave-search", "search"),
      allowEntry(2, 1, "2026-11-14", "other-vendor", "fetch"),
      { ...allowEntry(3, 5, "2026-11-13"), verdict: "DENY" },
    ];
    const r = buildReport(entries);
    assert.equal(r.totalMicro, 1_005_000);
    assert.equal(r.payments, 2);
    assert.equal(r.byVendor["brave-search"], 5000);
    assert.equal(r.byVendor["other-vendor"], 1_000_000);
    assert.equal(r.byTool.search, 5000);
    assert.equal(r.byDay["2026-11-14"], 1_005_000);
    assert.deepEqual(r.counts, { ALLOW: 2, DENY: 1, REVIEW: 0 });
  });
});
