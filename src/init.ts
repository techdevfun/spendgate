/**
 * `init`: scaffold spendgate.json (sample policy) + an empty ledger.
 * Refuses to overwrite either file when it already exists, unless --force.
 * The sample policy ships placeholder payees (all-zero / all-one addresses)
 * and the output says so plainly - replace them with real vendor addresses.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEmptyLedger } from "./ledger.js";
import { SAMPLE_ALLOW_PAYEE, SAMPLE_DENY_PAYEE, samplePolicy } from "./policy.js";

export const INIT_NEXT_STEPS = [
  "1. Edit spendgate.json: replace the placeholder allowlist payee with",
  "   your real vendor wallet address(es), and set caps for your budget.",
  "2. Dry-run a payment: spendgate simulate --file examples/brave-402.json",
  "3. Record real decisions: spendgate record --file examples/brave-402.json",
  "4. Gate CI on it: spendgate check  (exit 1 on any violation)",
];

export function runInit(dir: string, force: boolean): { policyPath: string; ledgerPath: string } {
  const policyPath = join(dir, "spendgate.json");
  const ledgerPath = join(dir, "spendgate-ledger.jsonl");
  if (!force) {
    if (existsSync(policyPath)) {
      throw new Error(
        `spendgate.json already exists in "${dir}" - refusing to overwrite (use --force to replace it)`,
      );
    }
    if (existsSync(ledgerPath)) {
      throw new Error(
        `spendgate-ledger.jsonl already exists in "${dir}" - refusing to overwrite (use --force to replace it)`,
      );
    }
  }
  writeFileSync(policyPath, `${JSON.stringify(samplePolicy(), null, 2)}\n`, "utf8");
  createEmptyLedger(ledgerPath);
  return { policyPath, ledgerPath };
}

export function initOutput(policyPath: string, ledgerPath: string): string {
  return [
    `created ${policyPath}`,
    `created ${ledgerPath} (empty)`,
    "",
    "Sample policy: per-call max $1.00, per-day cap $2.50, require-approval",
    "above $0.25. The allowlist payee is a placeholder",
    `(${SAMPLE_ALLOW_PAYEE}) and the denylist payee is a placeholder`,
    `(${SAMPLE_DENY_PAYEE}) - replace both with real vendor addresses.`,
    "",
    "Next steps:",
    ...INIT_NEXT_STEPS,
  ].join("\n");
}
