/**
 * Parse a payment request: either an x402 402-response JSON file or flags.
 *
 * Supported file shapes:
 *  - x402 v2 (the shape Brave serves publicly): an object with an `accepts`
 *    array; the first option is used. Fields: `amount` (base units, string),
 *    `payTo`, `network`, `asset`, `extra` (EIP-3009 name/version).
 *  - Flat shape: `amountUsd` (dollars) or `amount` + `decimals`, `payee`,
 *    plus optional `vendor`, `tool`, `host`.
 *
 * Flags override file fields. No network call is made, nothing is verified
 * on-chain, no wallet is touched - parsing only.
 */
import { readFileSync } from "node:fs";
import {
  isAddress,
  microToUsd,
  normaliseAddress,
  usdToMicro,
  type PaymentRequest,
} from "./money.js";

export interface ParsedPayment {
  /** Amount in base units as written in the 402 file (if any). */
  baseUnits: string | null;
  decimals: number;
  network: string;
  asset: string | null;
  request: PaymentRequest;
}

function fail(msg: string): never {
  throw new Error(`invalid payment request: ${msg}`);
}

export function parseBaseUnits(
  amount: string,
  decimals: number,
): { amountMicro: number; amountUsd: number } {
  if (!/^\d+$/.test(amount)) fail(`amount "${amount}" is not an integer`);
  const base = Number(amount);
  if (!Number.isSafeInteger(base) || base < 0) {
    fail(`amount "${amount}" is out of range`);
  }
  const amountMicro = Math.round((base * 1_000_000) / 10 ** decimals);
  return { amountMicro, amountUsd: microToUsd(amountMicro) };
}

/**
 * Build a PaymentRequest from a parsed 402 file plus flag overrides.
 * `overrides` may supply amountUsd / amountBaseUnits / payee / vendor /
 * tool / host / date. When the file carries vendor/tool/host and no flag
 * overrides them, the file values are used.
 */
export function parsePaymentFile(
  path: string,
  overrides: {
    amountUsd?: number;
    amountBaseUnits?: string;
    decimals?: number;
    payee?: string;
    vendor?: string;
    tool?: string;
    host?: string;
    date: string;
  },
): ParsedPayment {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read payment file "${path}"`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`payment file "${path}" is not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("top level must be an object");
  }
  const obj = raw as Record<string, unknown>;

  let baseUnits: string | null = null;
  let decimals = overrides.decimals ?? 6;
  let network = "";
  let asset: string | null = null;
  let filePayee = "";
  let fileAmountMicro: number | null = null;

  if (Array.isArray(obj.accepts) && obj.accepts.length > 0) {
    // x402 v2 shape (Brave public shape).
    const opt = obj.accepts[0] as Record<string, unknown>;
    if (typeof opt.amount !== "string") fail("accepts[0].amount must be a string");
    baseUnits = opt.amount;
    if (typeof opt.network !== "string" || opt.network === "") {
      fail("accepts[0].network must be a string");
    }
    network = opt.network;
    if (typeof opt.payTo !== "string" || !isAddress(opt.payTo)) {
      fail("accepts[0].payTo must be a 0x address");
    }
    filePayee = normaliseAddress(opt.payTo);
    if (typeof opt.asset === "string") asset = opt.asset;
    if (typeof opt.decimals === "number") decimals = opt.decimals;
    fileAmountMicro = parseBaseUnits(baseUnits, decimals).amountMicro;
  } else if (obj.amountUsd !== undefined || obj.amount !== undefined) {
    // Flat shape.
    if (typeof obj.amountUsd === "number") {
      if (obj.amountUsd < 0) fail("amountUsd must be non-negative");
      fileAmountMicro = usdToMicro(obj.amountUsd);
    } else if (typeof obj.amount === "string") {
      if (typeof obj.decimals === "number") decimals = obj.decimals;
      baseUnits = obj.amount;
      fileAmountMicro = parseBaseUnits(baseUnits, decimals).amountMicro;
    } else {
      fail("flat payment needs amountUsd (number) or amount (string)");
    }
    if (typeof obj.payee === "string" && isAddress(obj.payee)) {
      filePayee = normaliseAddress(obj.payee);
    }
    if (typeof obj.network === "string") network = obj.network;
    if (typeof obj.asset === "string") asset = obj.asset;
  } else {
    fail("no accepts[] array and no amount/amountUsd field found");
  }

  // Amount: explicit flags win over the file.
  let amountMicro = fileAmountMicro;
  if (overrides.amountUsd !== undefined) {
    if (overrides.amountUsd < 0) fail("amount must be non-negative");
    amountMicro = usdToMicro(overrides.amountUsd);
    baseUnits = null;
  } else if (overrides.amountBaseUnits !== undefined) {
    const parsed = parseBaseUnits(overrides.amountBaseUnits, decimals);
    amountMicro = parsed.amountMicro;
    baseUnits = overrides.amountBaseUnits;
  }
  if (amountMicro === null) fail("no amount found");

  const payee = overrides.payee ?? filePayee;
  if (payee === "" || !isAddress(payee)) {
    fail("payee must be a 0x address (flag --payee or accepts[0].payTo)");
  }
  const vendor = overrides.vendor ?? (typeof obj.vendor === "string" ? obj.vendor : "") ?? "";
  const tool = overrides.tool ?? (typeof obj.tool === "string" ? obj.tool : "") ?? "";
  const host = overrides.host ?? (typeof obj.host === "string" ? obj.host : "") ?? "";
  if (vendor.trim() === "") fail("vendor is required (flag --vendor or file field)");
  if (tool.trim() === "") fail("tool is required (flag --tool or file field)");

  return {
    baseUnits,
    decimals,
    network,
    asset,
    request: {
      amountMicro,
      amountUsd: microToUsd(amountMicro),
      payee: normaliseAddress(payee),
      vendor: vendor.trim(),
      tool: tool.trim(),
      host: host.trim().toLowerCase(),
      date: overrides.date,
    },
  };
}

/** Build a PaymentRequest purely from flags (no file). */
export function buildRequestFromFlags(flags: {
  amountUsd?: number;
  amountBaseUnits?: string;
  decimals?: number;
  payee: string;
  vendor: string;
  tool: string;
  host: string;
  date: string;
}): ParsedPayment {
  let amountMicro: number;
  let baseUnits: string | null = null;
  const decimals = flags.decimals ?? 6;
  if (flags.amountUsd !== undefined) {
    if (flags.amountUsd < 0) fail("amount must be non-negative");
    amountMicro = usdToMicro(flags.amountUsd);
  } else if (flags.amountBaseUnits !== undefined) {
    const parsed = parseBaseUnits(flags.amountBaseUnits, decimals);
    amountMicro = parsed.amountMicro;
    baseUnits = flags.amountBaseUnits;
  } else {
    fail("amount is required (--amount-usd or --amount-base-units)");
  }
  if (!isAddress(flags.payee)) fail("payee must be a 0x address");
  if (flags.vendor.trim() === "") fail("vendor is required (--vendor)");
  if (flags.tool.trim() === "") fail("tool is required (--tool)");
  return {
    baseUnits,
    decimals,
    network: "",
    asset: null,
    request: {
      amountMicro,
      amountUsd: microToUsd(amountMicro),
      payee: normaliseAddress(flags.payee),
      vendor: flags.vendor.trim(),
      tool: flags.tool.trim(),
      host: flags.host.trim().toLowerCase(),
      date: flags.date,
    },
  };
}
