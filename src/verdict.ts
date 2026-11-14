/**
 * Verdict engine: one payment request against a policy, given the ledger
 * history so far. Pure function - no I/O, no wallet, no network.
 *
 * Rule order (first DENY wins the verdict, but every firing rule is listed
 * so the operator sees all of them; REVIEW reasons accumulate too):
 *  1. denylist payee or host -> DENY
 *  2. amount over the per-call max -> DENY
 *  3. per-day cumulative over the cap -> DENY
 *  4. per-vendor cumulative over the cap -> DENY
 *  5. per-tool cumulative over the cap -> DENY
 *  6. payee lookalike of an allowlist address -> REVIEW
 *  7. allowlist non-empty and payee unknown -> REVIEW
 *  8. amount over the require-approval threshold -> REVIEW
 *  9. otherwise ALLOW
 */
import { findLookalike } from "./lookalike.js";
import { formatUsd, formatUsdExact, type Evaluation, type PaymentRequest } from "./money.js";
import { policyCapsMicro, type Policy } from "./policy.js";
import type { LedgerEntry } from "./ledger.js";

export interface SpendSoFar {
  dayMicro: number;
  vendorMicro: number;
  toolMicro: number;
}

/** Sum ALLOWed ledger entries for a request's date / vendor / tool. */
export function spendSoFar(entries: LedgerEntry[], req: PaymentRequest): SpendSoFar {
  let dayMicro = 0;
  let vendorMicro = 0;
  let toolMicro = 0;
  for (const e of entries) {
    if (e.verdict !== "ALLOW") continue;
    if (e.date !== req.date) continue;
    const micro = Math.round(e.amountUsd * 1_000_000);
    dayMicro += micro;
    if (e.vendor === req.vendor) vendorMicro += micro;
    if (e.tool === req.tool) toolMicro += micro;
  }
  return { dayMicro, vendorMicro, toolMicro };
}

export function evaluate(policy: Policy, req: PaymentRequest, entries: LedgerEntry[]): Evaluation {
  const caps = policyCapsMicro(policy);
  const spent = spendSoFar(entries, req);
  const reasons: string[] = [];
  let verdict: "ALLOW" | "DENY" | "REVIEW" = "ALLOW";

  const deny = (reason: string): void => {
    verdict = "DENY";
    reasons.push(reason);
  };
  const review = (reason: string): void => {
    if (verdict === "ALLOW") verdict = "REVIEW";
    reasons.push(reason);
  };

  // 1. Denylist.
  if (policy.denylist.payees.includes(req.payee)) {
    deny(`payee ${req.payee} is on the denylist`);
  }
  if (req.host !== "" && policy.denylist.hosts.includes(req.host)) {
    deny(`host ${req.host} is on the denylist`);
  }

  // 2. Per-call max.
  if (req.amountMicro > caps.perCallMicro) {
    deny(
      `amount ${formatUsdExact(req.amountMicro)} exceeds per-call max ${formatUsd(caps.perCallMicro)}`,
    );
  }

  // 3-5. Cumulative caps (only checked when the payment itself is not
  // already denied for a bigger reason - the reasons still all show).
  const dayAfter = spent.dayMicro + req.amountMicro;
  if (dayAfter > caps.perDayMicro) {
    deny(
      `per-day cap ${formatUsd(caps.perDayMicro)} would be exceeded ` +
        `(${formatUsd(spent.dayMicro)} spent + ${formatUsdExact(req.amountMicro)} = ${formatUsd(dayAfter)})`,
    );
  }
  const vendorCap = caps.perVendorMicro[req.vendor];
  const vendorAfter = spent.vendorMicro + req.amountMicro;
  if (vendorCap !== undefined && vendorAfter > vendorCap) {
    deny(
      `per-vendor cap for ${req.vendor} (${formatUsd(vendorCap)}) would be exceeded ` +
        `(${formatUsd(spent.vendorMicro)} spent + ${formatUsdExact(req.amountMicro)} = ${formatUsd(vendorAfter)})`,
    );
  }
  const toolCap = caps.perToolMicro[req.tool];
  const toolAfter = spent.toolMicro + req.amountMicro;
  if (toolCap !== undefined && toolAfter > toolCap) {
    deny(
      `per-tool cap for ${req.tool} (${formatUsd(toolCap)}) would be exceeded ` +
        `(${formatUsd(spent.toolMicro)} spent + ${formatUsdExact(req.amountMicro)} = ${formatUsd(toolAfter)})`,
    );
  }

  // 6. Lookalike payee.
  if (policy.lookalike.enabled && policy.allowlist.payees.length > 0) {
    const hit = findLookalike(req.payee, policy.allowlist.payees, policy.lookalike.maxDistance);
    if (hit !== null) {
      review(
        `payee ${req.payee} looks like allowlisted ${hit.address} ` +
          `(edit distance ${hit.distance}) - confirm the address before paying`,
      );
    }
  }

  // 7. Unknown payee (allowlist non-empty, payee and host both unknown).
  const payeeKnown = policy.allowlist.payees.includes(req.payee);
  const hostKnown = req.host !== "" && policy.allowlist.hosts.includes(req.host);
  if (policy.allowlist.payees.length > 0 && !payeeKnown && !hostKnown) {
    review(`payee ${req.payee} is not on the allowlist (unknown payee)`);
  }

  // 8. Require-approval threshold.
  if (req.amountMicro > caps.approvalMicro) {
    review(
      `amount ${formatUsdExact(req.amountMicro)} exceeds require-approval threshold ` +
        `${formatUsd(caps.approvalMicro)}`,
    );
  }

  if (verdict === "ALLOW") {
    reasons.push(
      `within per-call max ${formatUsd(caps.perCallMicro)}; ` +
        `day total after payment ${formatUsd(dayAfter)} / ${formatUsd(caps.perDayMicro)}`,
    );
  }

  return {
    verdict,
    reasons,
    dayTotalMicro: dayAfter,
    vendorTotalMicro: vendorAfter,
    toolTotalMicro: toolAfter,
  };
}
