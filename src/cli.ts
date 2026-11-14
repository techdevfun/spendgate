#!/usr/bin/env node
/**
 * spendgate 0.1.0 - a local pre-execution spend gate for paying agents.
 *
 * Five commands: init, simulate, record, check, report. Local only:
 * no network, no wallet, no signing, no on-chain verification, no billing
 * API. A payment request is judged from a 402 JSON file or from flags.
 *
 * Exit codes:
 *   simulate / record: 0 ALLOW, 1 DENY, 3 REVIEW, 2 input error
 *   check:             0 OK, 1 violation, 2 input error
 *   init / report:     0 ok, 2 input error (init also exits 2 when it
 *                      refuses to overwrite existing files)
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { initOutput, runInit } from "./init.js";
import { appendEntry, loadLedger, verifyChain, type LedgerEntry } from "./ledger.js";
import {
  formatUsdExact,
  isValidDate,
  nowIso,
  todayUtc,
  type Evaluation,
  type PaymentRequest,
} from "./money.js";
import { buildRequestFromFlags, parsePaymentFile } from "./parse402.js";
import { loadPolicy, type Policy } from "./policy.js";
import { buildReport, renderReport } from "./report.js";
import { evaluate } from "./verdict.js";

export const VERSION = "0.1.0";

const HELP = `spendgate ${VERSION} - a local pre-execution spend gate for paying agents.

Usage:
  spendgate init [--dir <dir>] [--force]
      Scaffold spendgate.json (sample policy) + empty spendgate-ledger.jsonl.
      Refuses to overwrite existing files unless --force.
  spendgate simulate [--config <file>] [--ledger <file>] [--file <402.json>]
                     [--amount-usd N | --amount-base-units N [--decimals N]]
                     [--payee 0x...] [--vendor NAME] [--tool NAME]
                     [--host HOST] [--date YYYY-MM-DD] [--format table|json]
      Judge one payment request against the policy. Touches no wallet,
      signs nothing. Exit 0 ALLOW, 1 DENY, 3 REVIEW, 2 input error.
  spendgate record   (same request flags as simulate)
      Judge the request, then append the decision to the ledger JSONL
      (append-only, SHA-256 hash-chained). Same exit codes as simulate.
  spendgate check [--config <file>] [--ledger <file>]
      CI gate: verify the ledger hash chain, then replay every ALLOW entry
      against the current policy. Exit 0 OK, 1 violation, 2 input error.
  spendgate report [--ledger <file>] [--format table|json]
      Totals by vendor / tool / day from the local ledger only (ALLOW
      entries). No billing API call. Exit 0, 2 input error.

Defaults: --config spendgate.json, --ledger spendgate-ledger.jsonl (in the
current directory). Set SPENDGATE_NOW=YYYY-MM-DD to pin "today" (tests,
demos). Amounts are USDC dollars; --amount-base-units converts with
--decimals (default 6, USDC).

Honest limits: this gate only enforces payments routed through it. An
agent that calls a payment client directly bypasses it - put spendgate
in the path (wrapper script / SOP) and reconcile the ledger to catch
off-gate payments. It holds no keys, signs nothing, verifies nothing
on-chain, and does no sanctions/KYC screening.
`;

function fail(msg: string): never {
  console.error(`spendgate: ${msg}`);
  process.exit(2);
}

interface Flags {
  values: Record<string, string>;
  bools: Set<string>;
}

function parseFlags(args: string[]): Flags {
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) fail(`unexpected argument "${a}"`);
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (key === "") fail(`bad flag "${a}"`);
    if (eq !== -1) {
      values[key] = a.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (key === "force" || key === "help") {
      bools.add(key);
      continue;
    }
    if (next === undefined || next.startsWith("--")) {
      fail(`flag --${key} needs a value`);
    }
    values[key] = next;
    i++;
  }
  return { values, bools };
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      out.push(a);
      continue;
    }
    // A flag: skip its value too (unless --key=value or a boolean flag).
    if (a.includes("=")) continue;
    const key = a.slice(2);
    if (key === "force" || key === "help") continue;
    i++; // skip the flag's value
  }
  return out;
}

function flagNumber(flags: Flags, key: string): number | undefined {
  const raw = flags.values[key];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`--${key} must be a number, got "${raw}"`);
  return n;
}

function flagInt(flags: Flags, key: string): number | undefined {
  const n = flagNumber(flags, key);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < 0) fail(`--${key} must be a non-negative integer`);
  return n;
}

function requestDate(flags: Flags): string {
  const date = flags.values.date;
  if (date === undefined) return todayUtc();
  if (!isValidDate(date)) fail(`--date must be a valid YYYY-MM-DD date, got "${date}"`);
  return date;
}

/** Load the ledger for cumulative sums: a missing default file means []. */
function loadLedgerOptional(path: string, explicit: boolean): LedgerEntry[] {
  if (!existsSync(path)) {
    if (explicit) fail(`cannot read ledger file "${path}"`);
    return [];
  }
  try {
    return loadLedger(path);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function buildRequest(
  flags: Flags,
  date: string,
): {
  request: PaymentRequest;
  baseUnits: string | null;
  network: string;
} {
  const amountUsd = flagNumber(flags, "amount-usd");
  const amountBaseUnits = flags.values["amount-base-units"];
  const decimals = flagInt(flags, "decimals");
  const file = flags.values.file;
  if (amountUsd !== undefined && amountBaseUnits !== undefined) {
    fail("use only one of --amount-usd and --amount-base-units");
  }
  const common = {
    amountUsd,
    amountBaseUnits,
    decimals,
    payee: flags.values.payee,
    vendor: flags.values.vendor,
    tool: flags.values.tool,
    host: flags.values.host,
    date,
  };
  if (file !== undefined) {
    const parsed = parsePaymentFile(file, common);
    return { request: parsed.request, baseUnits: parsed.baseUnits, network: parsed.network };
  }
  if (flags.values.payee === undefined) fail("--payee is required (or use --file)");
  const parsed = buildRequestFromFlags({
    ...common,
    payee: flags.values.payee,
    vendor: flags.values.vendor ?? "",
    tool: flags.values.tool ?? "",
    host: flags.values.host ?? "",
  });
  return { request: parsed.request, baseUnits: parsed.baseUnits, network: parsed.network };
}

function renderVerdict(
  ev: Evaluation,
  req: PaymentRequest,
  format: string,
  extra?: { baseUnits: string | null; network: string },
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        verdict: ev.verdict,
        amountUsd: req.amountUsd,
        payee: req.payee,
        vendor: req.vendor,
        tool: req.tool,
        host: req.host,
        date: req.date,
        reasons: ev.reasons,
        dayTotalUsd: ev.dayTotalMicro / 1_000_000,
        vendorTotalUsd: ev.vendorTotalMicro / 1_000_000,
        toolTotalUsd: ev.toolTotalMicro / 1_000_000,
      },
      null,
      2,
    );
  }
  if (format !== "table") fail(`--format must be table or json, got "${format}"`);
  const lines = [
    `verdict: ${ev.verdict}`,
    `amount: ${formatUsdExact(req.amountMicro)} USDC` +
      (extra?.baseUnits !== null && extra?.baseUnits !== undefined
        ? ` (${extra.baseUnits} base units${extra.network ? `, ${extra.network}` : ""})`
        : ""),
    `payee: ${req.payee}`,
    `vendor: ${req.vendor}`,
    `tool: ${req.tool}`,
    `host: ${req.host === "" ? "(none)" : req.host}`,
    `date: ${req.date}`,
    "reasons:",
    ...ev.reasons.map((r) => `  - ${r}`),
  ];
  return lines.join("\n");
}

function exitForVerdict(verdict: string): number {
  if (verdict === "ALLOW") return 0;
  if (verdict === "DENY") return 1;
  return 3; // REVIEW
}

function cmdInit(flags: Flags, positionals: string[]): void {
  if (positionals.length > 0) fail("init takes no positional arguments");
  const dir = flags.values.dir ?? ".";
  const resolved = resolve(dir);
  try {
    mkdirSync(resolved, { recursive: true });
    const { policyPath, ledgerPath } = runInit(resolved, flags.bools.has("force"));
    console.log(initOutput(policyPath, ledgerPath));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function cmdSimulate(flags: Flags, positionals: string[], recordIt: boolean): void {
  if (positionals.length > 0) {
    fail(`${recordIt ? "record" : "simulate"} takes no positional arguments`);
  }
  const configPath = flags.values.config ?? "spendgate.json";
  const ledgerPath = flags.values.ledger ?? "spendgate-ledger.jsonl";
  const format = flags.values.format ?? "table";
  let policy: Policy;
  try {
    policy = loadPolicy(configPath);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const date = requestDate(flags);
  let built: { request: PaymentRequest; baseUnits: string | null; network: string };
  try {
    built = buildRequest(flags, date);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  if (built.network !== "" && built.network !== policy.network) {
    fail(`payment network "${built.network}" is not the policy network "${policy.network}"`);
  }
  const entries = loadLedgerOptional(ledgerPath, flags.values.ledger !== undefined);
  const ev = evaluate(policy, built.request, entries);
  if (recordIt) {
    const entry = appendEntry(ledgerPath, {
      ts: nowIso(built.request.date),
      date: built.request.date,
      verdict: ev.verdict,
      amountUsd: built.request.amountUsd,
      payee: built.request.payee,
      vendor: built.request.vendor,
      tool: built.request.tool,
      host: built.request.host,
      reasons: ev.reasons,
    });
    console.log(renderVerdict(ev, built.request, format, built));
    console.log(`recorded as ledger line ${entry.seq} (hash ${entry.hash.slice(0, 12)}...)`);
  } else {
    console.log(renderVerdict(ev, built.request, format, built));
  }
  process.exit(exitForVerdict(ev.verdict));
}

function cmdCheck(flags: Flags, positionals: string[]): void {
  if (positionals.length > 0) fail("check takes no positional arguments");
  const configPath = flags.values.config ?? "spendgate.json";
  const ledgerPath = flags.values.ledger ?? "spendgate-ledger.jsonl";
  let policy: Policy;
  try {
    policy = loadPolicy(configPath);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  let entries: LedgerEntry[];
  try {
    entries = loadLedger(ledgerPath);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const violations: string[] = [...verifyChain(entries)];
  // Replay every ALLOW entry against the policy, using only the entries
  // recorded before it (cumulative caps are order-dependent).
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.verdict !== "ALLOW") continue;
    const req: PaymentRequest = {
      amountMicro: Math.round(entry.amountUsd * 1_000_000),
      amountUsd: entry.amountUsd,
      payee: entry.payee,
      vendor: entry.vendor,
      tool: entry.tool,
      host: entry.host,
      date: entry.date,
    };
    const ev = evaluate(policy, req, entries.slice(0, i));
    if (ev.verdict !== "ALLOW") {
      violations.push(
        `line ${entry.seq}: ALLOW entry would now be ${ev.verdict} - ${ev.reasons.join("; ")}`,
      );
    }
  }
  if (violations.length === 0) {
    console.log(
      `check OK: ${entries.length} ledger ${entries.length === 1 ? "entry" : "entries"}, ` +
        `hash chain intact, no policy violations`,
    );
    process.exit(0);
  }
  console.log(`check FAILED: ${violations.length} violation(s) in ${ledgerPath}`);
  for (const v of violations) console.log(`  - ${v}`);
  process.exit(1);
}

function cmdReport(flags: Flags, positionals: string[]): void {
  if (positionals.length > 0) fail("report takes no positional arguments");
  const ledgerPath = flags.values.ledger ?? "spendgate-ledger.jsonl";
  const format = flags.values.format ?? "table";
  let entries: LedgerEntry[];
  try {
    entries = loadLedger(ledgerPath);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const totals = buildReport(entries);
  if (format === "json") {
    const out = {
      entries: entries.length,
      totalUsd: totals.totalMicro / 1_000_000,
      payments: totals.payments,
      counts: totals.counts,
      byVendorUsd: Object.fromEntries(
        Object.entries(totals.byVendor).map(([k, v]) => [k, v / 1_000_000]),
      ),
      byToolUsd: Object.fromEntries(
        Object.entries(totals.byTool).map(([k, v]) => [k, v / 1_000_000]),
      ),
      byDayUsd: Object.fromEntries(
        Object.entries(totals.byDay).map(([k, v]) => [k, v / 1_000_000]),
      ),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (format !== "table") fail(`--format must be table or json, got "${format}"`);
  console.log(renderReport(totals, entries.length));
}

export function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(`spendgate ${VERSION}`);
    return;
  }
  const parsed = parseFlags(rest);
  const positionals = positionalArgs(rest);
  switch (cmd) {
    case "init":
      cmdInit(parsed, positionals);
      break;
    case "simulate":
      cmdSimulate(parsed, positionals, false);
      break;
    case "record":
      cmdSimulate(parsed, positionals, true);
      break;
    case "check":
      cmdCheck(parsed, positionals);
      break;
    case "report":
      cmdReport(parsed, positionals);
      break;
    default:
      fail(`unknown command "${cmd}" (try --help)`);
  }
}

main(process.argv.slice(2));
