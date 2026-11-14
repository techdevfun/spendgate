/**
 * Report: totals from the local ledger only. No billing API, no network.
 * Spend is summed over ALLOWed entries only - a DENY or REVIEW never paid
 * anything, so it must not appear in a spend total.
 */
import { formatUsd, usdToMicro } from "./money.js";
import type { LedgerEntry } from "./ledger.js";

export interface ReportTotals {
  totalMicro: number;
  payments: number;
  byVendor: Record<string, number>;
  byTool: Record<string, number>;
  byDay: Record<string, number>;
  counts: { ALLOW: number; DENY: number; REVIEW: number };
}

export function buildReport(entries: LedgerEntry[]): ReportTotals {
  const totals: ReportTotals = {
    totalMicro: 0,
    payments: 0,
    byVendor: {},
    byTool: {},
    byDay: {},
    counts: { ALLOW: 0, DENY: 0, REVIEW: 0 },
  };
  for (const e of entries) {
    if (e.verdict === "ALLOW") totals.counts.ALLOW++;
    else if (e.verdict === "DENY") totals.counts.DENY++;
    else if (e.verdict === "REVIEW") totals.counts.REVIEW++;
    else continue;
    if (e.verdict !== "ALLOW") continue;
    const micro = usdToMicro(e.amountUsd);
    totals.totalMicro += micro;
    totals.payments++;
    totals.byVendor[e.vendor] = (totals.byVendor[e.vendor] ?? 0) + micro;
    totals.byTool[e.tool] = (totals.byTool[e.tool] ?? 0) + micro;
    totals.byDay[e.date] = (totals.byDay[e.date] ?? 0) + micro;
  }
  return totals;
}

function tableRows(title: string, map: Record<string, number>): string[] {
  const keys = Object.keys(map).sort();
  if (keys.length === 0) return [`${title}: (none)`];
  const width = Math.max(...keys.map((k) => k.length), title.length);
  const lines = [`${title}:`];
  for (const k of keys) {
    lines.push(`  ${k.padEnd(width)}  ${formatUsd(map[k])}`);
  }
  return lines;
}

export function renderReport(totals: ReportTotals, entryCount: number): string {
  const lines: string[] = [
    `spend report (${entryCount} ledger ${entryCount === 1 ? "entry" : "entries"}; ` +
      `${totals.counts.ALLOW} ALLOW, ${totals.counts.DENY} DENY, ${totals.counts.REVIEW} REVIEW)`,
    `total spent (ALLOW only): ${formatUsd(totals.totalMicro)} across ${totals.payments} payments`,
    "",
    ...tableRows("by vendor", totals.byVendor),
    "",
    ...tableRows("by tool", totals.byTool),
    "",
    ...tableRows("by day", totals.byDay),
  ];
  return lines.join("\n");
}
