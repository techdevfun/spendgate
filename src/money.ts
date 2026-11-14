/**
 * spendgate 0.1.0 - a local pre-execution spend gate for paying agents.
 *
 * Money is compared in integer micro-dollars (1 USD = 1,000,000 micro)
 * so 500 x $0.005 adds up to exactly $2.50 with no float drift.
 * This module only defines the money helpers and the shared types.
 */

export type Verdict = "ALLOW" | "DENY" | "REVIEW";

export interface PaymentRequest {
  /** Amount in integer micro-dollars. */
  amountMicro: number;
  /** Amount in dollars, for display (derived from amountMicro). */
  amountUsd: number;
  /** Recipient wallet address (0x...), lowercased by the parser. */
  payee: string;
  vendor: string;
  tool: string;
  host: string;
  /** UTC date the payment is accounted on (YYYY-MM-DD). */
  date: string;
}

export interface Evaluation {
  verdict: Verdict;
  reasons: string[];
  /** Cumulative spend that would result, in micro-dollars. */
  dayTotalMicro: number;
  vendorTotalMicro: number;
  toolTotalMicro: number;
}

export const MICRO_PER_DOLLAR = 1_000_000;

export function usdToMicro(usd: number): number {
  return Math.round(usd * MICRO_PER_DOLLAR);
}

export function microToUsd(micro: number): number {
  return micro / MICRO_PER_DOLLAR;
}

/** Format micro-dollars as $X.XX, rounded to the nearest cent. */
export function formatUsd(micro: number): string {
  const sign = micro < 0 ? "-" : "";
  const abs = Math.abs(micro);
  const totalCents = Math.round(abs / 10_000);
  const dollars = Math.floor(totalCents / 100);
  const cents = totalCents % 100;
  return `${sign}$${dollars}.${String(cents).padStart(2, "0")}`;
}

/** Format a dollar amount with up to 6 decimals, trailing zeros trimmed. */
export function formatUsdExact(micro: number): string {
  const raw = (micro / MICRO_PER_DOLLAR).toFixed(6);
  const trimmed = raw.replace(/0+$/, "").replace(/\.$/, "");
  return `$${trimmed}`;
}

/** Strict YYYY-MM-DD check: rejects 2026-02-30 and other impossible dates. */
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Today in UTC, or the pinned date from SPENDGATE_NOW (tests and demos). */
export function todayUtc(): string {
  const pinned = process.env.SPENDGATE_NOW;
  if (pinned !== undefined) {
    if (!isValidDate(pinned)) {
      throw new Error(`SPENDGATE_NOW must be YYYY-MM-DD, got "${pinned}"`);
    }
    return pinned;
  }
  return new Date().toISOString().slice(0, 10);
}

/** Timestamp for a ledger line: pinned noon UTC when SPENDGATE_NOW is set. */
export function nowIso(date: string): string {
  if (process.env.SPENDGATE_NOW !== undefined) return `${date}T12:00:00.000Z`;
  return new Date().toISOString();
}

/** Normalise a wallet address for comparison (lowercase, keep 0x prefix). */
export function normaliseAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function isAddress(value: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(value.trim().toLowerCase());
}
