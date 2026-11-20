/**
 * Receipt ledger: append-only JSONL with a SHA-256 hash chain.
 *
 * Every line carries `prevHash` (the hash of the previous line) and `hash`
 * (SHA-256 of the canonical JSON of the line without its own `hash` field).
 * The genesis prevHash is 64 zeroes. Editing, deleting, or reordering any
 * line breaks the chain, which `check` detects. The ledger never stores
 * keys, secrets, or signatures - only the decision that was made.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Verdict } from "./money.js";

export interface LedgerEntry {
  seq: number;
  ts: string;
  date: string;
  verdict: Verdict;
  amountUsd: number;
  payee: string;
  vendor: string;
  tool: string;
  host: string;
  reasons: string[];
  /**
   * SHA-256 of the policy in force when the decision was recorded
   * (see hashPolicy in policy.ts). Optional: entries written before
   * this field existed have no hash, and they still verify - the field
   * only pins the policy version, it is not part of the chain itself.
   */
  policyHash?: string;
  prevHash: string;
  hash: string;
}

export const GENESIS_PREV_HASH = "0".repeat(64);

/** Canonical JSON: fixed key order, so the hash is reproducible. */
export function canonicalEntry(entry: Omit<LedgerEntry, "hash">): string {
  const ordered: Record<string, unknown> = {
    seq: entry.seq,
    ts: entry.ts,
    date: entry.date,
    verdict: entry.verdict,
    amountUsd: entry.amountUsd,
    payee: entry.payee,
    vendor: entry.vendor,
    tool: entry.tool,
    host: entry.host,
    reasons: entry.reasons,
  };
  // Only present when the entry was recorded with a policy hash, so
  // pre-policyHash entries keep their original hash and still verify.
  if (entry.policyHash !== undefined) {
    ordered.policyHash = entry.policyHash;
  }
  ordered.prevHash = entry.prevHash;
  return JSON.stringify(ordered);
}

export function hashEntry(entry: Omit<LedgerEntry, "hash">): string {
  return createHash("sha256").update(canonicalEntry(entry)).digest("hex");
}

/** Load a ledger file. A missing file is an error; an empty file is []. */
export function loadLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) {
    throw new Error(`cannot read ledger file "${path}"`);
  }
  const text = readFileSync(path, "utf8");
  const entries: LedgerEntry[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`ledger line ${index + 1} is not valid JSON`);
    }
    const e = parsed as Record<string, unknown>;
    if (
      typeof e.seq !== "number" ||
      typeof e.ts !== "string" ||
      typeof e.date !== "string" ||
      typeof e.verdict !== "string" ||
      typeof e.amountUsd !== "number" ||
      typeof e.payee !== "string" ||
      typeof e.vendor !== "string" ||
      typeof e.tool !== "string" ||
      typeof e.host !== "string" ||
      !Array.isArray(e.reasons) ||
      (e.policyHash !== undefined && typeof e.policyHash !== "string") ||
      typeof e.prevHash !== "string" ||
      typeof e.hash !== "string"
    ) {
      throw new Error(`ledger line ${index + 1} is missing required fields`);
    }
    entries.push(parsed as unknown as LedgerEntry);
  }
  return entries;
}

/**
 * Verify the hash chain. Returns a list of problems (empty = intact).
 * Checks: seq 1..n contiguous, prevHash links, and every hash recomputes.
 */
export function verifyChain(entries: LedgerEntry[]): string[] {
  const problems: string[] = [];
  let prev = GENESIS_PREV_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i + 1) {
      problems.push(
        `line ${i + 1}: seq is ${e.seq}, expected ${i + 1} (a line was deleted or reordered)`,
      );
    }
    if (e.prevHash !== prev) {
      problems.push(
        `line ${i + 1}: prevHash does not match the previous line's hash (chain broken)`,
      );
    }
    const recomputed = hashEntry(e);
    if (recomputed !== e.hash) {
      problems.push(`line ${i + 1}: hash mismatch - the line was edited after it was written`);
    }
    prev = e.hash;
  }
  return problems;
}

/** Append one decision to the ledger and return the finished entry. */
export function appendEntry(
  path: string,
  partial: Omit<LedgerEntry, "seq" | "prevHash" | "hash">,
): LedgerEntry {
  const existing = existsSync(path) ? loadLedger(path) : [];
  const prevHash = existing.length === 0 ? GENESIS_PREV_HASH : existing[existing.length - 1].hash;
  const withoutHash = {
    seq: existing.length + 1,
    ts: partial.ts,
    date: partial.date,
    verdict: partial.verdict,
    amountUsd: partial.amountUsd,
    payee: partial.payee,
    vendor: partial.vendor,
    tool: partial.tool,
    host: partial.host,
    reasons: partial.reasons,
    policyHash: partial.policyHash,
    prevHash,
  };
  const entry: LedgerEntry = { ...withoutHash, hash: hashEntry(withoutHash) };
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

/** Create an empty ledger file (used by `init`). */
export function createEmptyLedger(path: string): void {
  writeFileSync(path, "", "utf8");
}
