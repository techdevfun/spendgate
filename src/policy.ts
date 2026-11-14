/**
 * Policy file: load, validate, and the sample policy `init` writes.
 *
 * A policy is plain JSON, versioned, readable by eye. Unknown extra fields
 * are ignored so a future version can add fields without breaking old
 * readers; missing fields fall back to the documented defaults only where
 * the field is optional (caps and lists are required - a silent default
 * cap would be worse than an error).
 */
import { readFileSync } from "node:fs";
import { isAddress, normaliseAddress, usdToMicro } from "./money.js";

export interface PolicyLimits {
  perCallMaxUsd: number;
  perDayMaxUsd: number;
  perVendorMaxUsd: Record<string, number>;
  perToolMaxUsd: Record<string, number>;
}

export interface Policy {
  version: number;
  currency: string;
  network: string;
  limits: PolicyLimits;
  allowlist: { payees: string[]; hosts: string[] };
  denylist: { payees: string[]; hosts: string[] };
  requireApprovalAboveUsd: number;
  lookalike: { enabled: boolean; maxDistance: number };
}

/** Placeholder payees shipped by `init`. They are not real wallets. */
export const SAMPLE_ALLOW_PAYEE = "0x0000000000000000000000000000000000000000";
export const SAMPLE_DENY_PAYEE = "0x1111111111111111111111111111111111111111";

export function samplePolicy(): Policy {
  return {
    version: 1,
    currency: "USDC",
    network: "eip155:8453",
    limits: {
      perCallMaxUsd: 1.0,
      perDayMaxUsd: 2.5,
      perVendorMaxUsd: { "brave-search": 2.5 },
      perToolMaxUsd: { search: 2.5 },
    },
    allowlist: {
      payees: [SAMPLE_ALLOW_PAYEE],
      hosts: ["search.agent.s.brave.app"],
    },
    denylist: {
      payees: [SAMPLE_DENY_PAYEE],
      hosts: ["evil.example.com"],
    },
    requireApprovalAboveUsd: 0.25,
    lookalike: { enabled: true, maxDistance: 2 },
  };
}

function fail(msg: string): never {
  throw new Error(`invalid policy: ${msg}`);
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`"${field}" must be a non-negative number`);
  }
  return value;
}

function asCapMap(value: unknown, field: string): Record<string, number> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`"${field}" must be an object of name -> dollars`);
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = asNumber(v, `${field}.${k}`);
  }
  return out;
}

function asAddressList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`"${field}" must be an array`);
  return value.map((entry) => {
    if (typeof entry !== "string" || !isAddress(entry)) {
      fail(`"${field}" entry "${String(entry)}" is not a 0x address`);
    }
    return normaliseAddress(entry);
  });
}

function asHostList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`"${field}" must be an array`);
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "" || /\s/.test(entry)) {
      fail(`"${field}" entry "${String(entry)}" is not a host`);
    }
    return entry.trim().toLowerCase();
  });
}

/** Validate raw parsed JSON into a Policy. Throws on any problem. */
export function parsePolicy(raw: unknown): Policy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("top level must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) fail(`"version" must be 1, got ${JSON.stringify(obj.version)}`);
  if (typeof obj.currency !== "string" || obj.currency.trim() === "") {
    fail(`"currency" must be a non-empty string`);
  }
  if (typeof obj.network !== "string" || obj.network.trim() === "") {
    fail(`"network" must be a non-empty string`);
  }
  const limitsRaw = obj.limits;
  if (typeof limitsRaw !== "object" || limitsRaw === null || Array.isArray(limitsRaw)) {
    fail(`"limits" must be an object`);
  }
  const limits = limitsRaw as Record<string, unknown>;
  const allowRaw = obj.allowlist;
  const denyRaw = obj.denylist;
  const lookRaw = obj.lookalike;
  const lookalike =
    lookRaw === undefined
      ? { enabled: true, maxDistance: 2 }
      : typeof lookRaw === "object" && lookRaw !== null && !Array.isArray(lookRaw)
        ? {
            enabled: (lookRaw as Record<string, unknown>).enabled !== false,
            maxDistance: asNumber(
              (lookRaw as Record<string, unknown>).maxDistance ?? 2,
              "lookalike.maxDistance",
            ),
          }
        : fail(`"lookalike" must be an object`);
  return {
    version: 1,
    currency: (obj.currency as string).trim(),
    network: (obj.network as string).trim(),
    limits: {
      perCallMaxUsd: asNumber(limits.perCallMaxUsd, "limits.perCallMaxUsd"),
      perDayMaxUsd: asNumber(limits.perDayMaxUsd, "limits.perDayMaxUsd"),
      perVendorMaxUsd: asCapMap(limits.perVendorMaxUsd, "limits.perVendorMaxUsd"),
      perToolMaxUsd: asCapMap(limits.perToolMaxUsd, "limits.perToolMaxUsd"),
    },
    allowlist: {
      payees: asAddressList(
        (allowRaw as Record<string, unknown> | undefined)?.payees,
        "allowlist.payees",
      ),
      hosts: asHostList(
        (allowRaw as Record<string, unknown> | undefined)?.hosts,
        "allowlist.hosts",
      ),
    },
    denylist: {
      payees: asAddressList(
        (denyRaw as Record<string, unknown> | undefined)?.payees,
        "denylist.payees",
      ),
      hosts: asHostList((denyRaw as Record<string, unknown> | undefined)?.hosts, "denylist.hosts"),
    },
    requireApprovalAboveUsd:
      obj.requireApprovalAboveUsd === undefined
        ? Number.POSITIVE_INFINITY
        : asNumber(obj.requireApprovalAboveUsd, "requireApprovalAboveUsd"),
    lookalike,
  };
}

/** Load and validate a policy file. Throws on missing file or bad JSON. */
export function loadPolicy(path: string): Policy {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read policy file "${path}"`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`policy file "${path}" is not valid JSON`);
  }
  return parsePolicy(raw);
}

/** Per-call / per-day / per-vendor / per-tool caps in micro-dollars. */
export function policyCapsMicro(policy: Policy): {
  perCallMicro: number;
  perDayMicro: number;
  perVendorMicro: Record<string, number>;
  perToolMicro: Record<string, number>;
  approvalMicro: number;
} {
  const vendor: Record<string, number> = {};
  for (const [k, v] of Object.entries(policy.limits.perVendorMaxUsd)) {
    vendor[k] = usdToMicro(v);
  }
  const tool: Record<string, number> = {};
  for (const [k, v] of Object.entries(policy.limits.perToolMaxUsd)) {
    tool[k] = usdToMicro(v);
  }
  return {
    perCallMicro: usdToMicro(policy.limits.perCallMaxUsd),
    perDayMicro: usdToMicro(policy.limits.perDayMaxUsd),
    perVendorMicro: vendor,
    perToolMicro: tool,
    approvalMicro:
      policy.requireApprovalAboveUsd === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : usdToMicro(policy.requireApprovalAboveUsd),
  };
}
