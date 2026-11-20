# spendgate

A local pre-execution spend gate for paying agents. Before your agent signs
any x402 payment, spendgate judges the request against a policy file you
wrote: per-call, per-day, per-vendor and per-tool caps, a payee
allowlist/denylist, and lookalike-address detection. Every decision lands
in an append-only, hash-chained receipt ledger, so you can prove later what
your agent paid, to whom, and under which rule.

Zero runtime dependencies. Node 20+. No network, no wallet, no signing,
no on-chain verification, no billing API.

## Why this exists

On 12/11/2026 Brave made its Search API payable over x402: $0.005 per
search, USDC on Base, no account or API key
([Brave blog, 12/11/2026](https://brave.com/blog/search-api-agentic-payments/)).
That is cheap per call - and that is the trap. The x402 client default cap
is **$1 per payment** (set 18/08/2026 after a V12 audit published
22/10/2026 found the default client had no spending limit at all).
A $1 per-call cap does not stop an agent loop that makes 500 valid $0.005
payments. That loop costs $2.50 and nothing in the default stack objects.
That loop is a constructed illustration, not a reported incident: the $1
cap and the audit finding behind it are real, and the 500-payment
arithmetic uses Brave's published $0.005/search price to show why a
per-call cap cannot bound cumulative spend.
A survey of 12 agent frameworks (09/10/2026) found **0 of 12** can cap what
an agent spends in dollars on tool calls.

spendgate closes that hole with a cumulative budget, not a per-call cap.

## How it compares

| Tool | What it does | What spendgate adds (or does differently) |
|---|---|---|
| x402 default client (Coinbase) | $1 per-payment cap, USD stablecoins only (since 18/08/2026) | Cumulative caps: per-day, per-vendor, per-tool. Plus payee allowlist/denylist, lookalike detection, a hash-chained receipt ledger, and a CI gate. The default client has none of these. |
| Stripe `purl` | `curl` for paid endpoints; `--max-amount` caps one call | One-call cap only. No cumulative budget, no policy file, no decision log, no lookalike blocking. |
| agent402-mcp | `AGENT402_MAX_PER_CALL` (default $4) + opt-in session budget | Tied to their MCP server. No per-vendor/per-day caps, no payee allowlist, no ledger, no CI gate, no report. |
| **sra-riskgate 0.10.1** (PyPI) | Python SDK: `check_payment()` verdict before paying; per-payment cap (default 100 USDC), session budget, blocklist, new-payee hold, OFAC SDN snapshot, depeg hold, lookalike detection, x402 hooks, LangChain/CrewAI/AgentKit integrations ([PyPI](https://pypi.org/project/sra-riskgate/0.10.1/), [dev.to 14/11/2026](https://dev.to/sriram1983007/grok-as-a-paying-agent-it-refused-two-attacks-itself-and-a-gate-caught-the-rest-46gf)) | The closest rival. spendgate differs in four ways: (1) zero-dependency CLI, framework-agnostic - no Python, no LangChain, no AgentKit; (2) a declarative policy file with per-vendor/per-tool/per-day caps, not config in code; (3) a hash-chained receipt ledger + `check` CI gate + `report`, which sra-riskgate does not have; (4) a `simulate` dry-run that never touches a wallet. sra-riskgate's strongest features depend on an optional 4B model and a peg feed; spendgate needs neither. |
| LangChain / CrewAI / OpenAI Agents SDK | Human-in-the-loop, max steps, rate limits, some LLM token budgets | 0/12 frameworks in the 09/10/2026 survey have a currency budget for tool calls. A token budget caps model cost, not money the agent pays out. |
| agentbudget, TokenFence, Till, Alpi | Cap LLM token spend in USD/session | Cap **LLM token** money only, not **x402 payment** money to outside vendors. |
| aibill (our own CLI, 02/11) | Measures token/USD attribution per MCP tool/model call **after** spending | Attribution after the fact. spendgate blocks **before** signing, and only for real x402/USDC payments to outside vendors. Different axis, different input (transcript vs 402 request). |

## Where rivals beat us

Honest accounting, because the comparison table above is only half the story:

- **sra-riskgate does more kinds of checking.** It screens OFAC sanctions
  lists, holds on stablecoin depegs, and holds first payments to new payees.
  spendgate does none of that: no sanctions screening, no KYC, no peg
  monitoring. If you need OFAC screening, use sra-riskgate (or both).
- **sra-riskgate integrates inside your framework.** If your agent already
  runs on LangChain or CrewAI, its SDK hooks are less plumbing than shelling
  out to a CLI. spendgate is deliberately framework-agnostic, which means
  you wire it in yourself.
- **The x402 default client and `purl` need no policy file at all.** For a
  single agent making a handful of payments a day, their per-call cap may
  genuinely be enough. spendgate earns its keep when payments are numerous,
  repeated, or unattended.
- **spendgate verifies nothing on-chain.** It trusts the 402 JSON you hand
  it and the ledger on your disk. A payment that settles differently from
  the request is outside its view.

## Quick start (install from source)

spendgate is not published to npm. Install from source:

```sh
git clone https://github.com/techdevfun/spendgate.git
cd spendgate
npm ci
npm run build
npm test
```

Then use it from the repo root (`node dist/cli.js ...`) or link it:

```sh
npm link   # makes `spendgate` available on your PATH
```

## Usage

```sh
# 1. Scaffold a policy + an empty ledger (refuses to overwrite existing files)
spendgate init

# 2. Dry-run one payment (the Brave 402 fixture: $0.005, USDC on Base)
spendgate simulate --file examples/brave-402.json

# 3. Judge it and append the decision to the ledger
spendgate record --file examples/brave-402.json

# 4. Gate CI on the ledger
spendgate check

# 5. Totals by vendor / tool / day (local ledger only, no billing API)
spendgate report
```

A payment can also be given by flags instead of a file:

```sh
spendgate simulate --amount-usd 0.005 \
  --payee 0xb1a9e00000000000000000000000000000000001 \
  --vendor brave-search --tool search --host search.agent.s.brave.app
```

Or in base units, as x402 serves them (5000 base units, 6 decimals = $0.005):

```sh
spendgate simulate --amount-base-units 5000 --decimals 6 \
  --payee 0xb1a9e00000000000000000000000000000000001 \
  --vendor brave-search --tool search
```

### Verdicts and exit codes

| Command | Exit 0 | Exit 1 | Exit 2 | Exit 3 |
|---|---|---|---|---|
| `simulate` / `record` | ALLOW | DENY | input error | REVIEW |
| `check` | OK | violation | input error | - |
| `init` / `report` | ok | - | input error | - |

Rules, in order (every firing rule is listed in the output):

1. Payee or host on the denylist -> DENY.
2. Amount over the per-call max -> DENY.
3. Per-day cumulative (ALLOWed ledger entries for that date) + amount over
   the per-day cap -> DENY.
4. Per-vendor cumulative over the per-vendor cap -> DENY.
5. Per-tool cumulative over the per-tool cap -> DENY.
6. Payee is a lookalike of an allowlist address (1-2 characters different)
   -> REVIEW.
7. Allowlist non-empty and neither payee nor host is on it -> REVIEW.
8. Amount over the require-approval threshold -> REVIEW.
9. Otherwise ALLOW.

Amounts are compared in integer micro-dollars, so 500 x $0.005 is exactly
$2.50 with no float drift.

### The 500-payment demo

The sample policy caps a day at $2.50. One Brave search is $0.005, well
under the $1 per-call cap - and 500 of them still fit under it too:

```sh
for i in $(seq 1 500); do
  spendgate record --file examples/brave-402.json > /dev/null
done
spendgate simulate --file examples/brave-402.json
# verdict: DENY - per-day cap $2.50 would be exceeded
spendgate report
# total spent (ALLOW only): $2.50 across 500 payments
```

That is the whole point: a per-call cap cannot see a loop. A cumulative
cap can. (The demo transcript and GIF in `demo/` show this run for real.)

### The policy file (`spendgate.json`)

```json
{
  "version": 1,
  "currency": "USDC",
  "network": "eip155:8453",
  "limits": {
    "perCallMaxUsd": 1.0,
    "perDayMaxUsd": 2.5,
    "perVendorMaxUsd": { "brave-search": 2.5 },
    "perToolMaxUsd": { "search": 2.5 }
  },
  "allowlist": {
    "payees": ["0x0000000000000000000000000000000000000000"],
    "hosts": ["search.agent.s.brave.app"]
  },
  "denylist": {
    "payees": ["0x1111111111111111111111111111111111111111"],
    "hosts": ["evil.example.com"]
  },
  "requireApprovalAboveUsd": 0.25,
  "lookalike": { "enabled": true, "maxDistance": 2 }
}
```

`init` writes this sample with placeholder payees (all-zero / all-one
addresses, not real wallets). Replace them with your real vendor addresses.
Caps are dollars; `perVendorMaxUsd` / `perToolMaxUsd` are name-to-dollars
maps (a vendor or tool with no entry has no cap of that kind).

### The receipt ledger (`spendgate-ledger.jsonl`)

One JSON object per line, append-only. Each line carries `seq`, `ts`,
`date`, `verdict`, `amountUsd`, `payee`, `vendor`, `tool`, `host`,
`reasons`, `policyHash`, `prevHash`, and `hash` (SHA-256 of the canonical JSON of the
line without its own `hash`). `policyHash` is the SHA-256 of the policy
in force when the decision was recorded, so an auditor can tell which
rules applied; entries written before this field existed have no hash
and still verify. The genesis `prevHash` is 64 zeroes.
Editing, deleting, or reordering a line breaks the chain, and `check`
reports it:

```sh
spendgate check
# check OK: 500 ledger entries, hash chain intact, no policy violations
```

`check` also replays every ALLOW entry against the current policy, in
order: an ALLOW that would now be DENY or REVIEW (cap exceeded, denylisted
or unknown payee) is a violation, exit 1. DENY and REVIEW lines are not
violations - they are the gate working.

Set `SPENDGATE_NOW=YYYY-MM-DD` to pin "today" (tests and demos use this;
otherwise the current UTC date is used).

## Honest limits

Read this before trusting spendgate with real money:

- **A local gate only enforces payments routed through it.** An agent that
  calls a payment client directly bypasses spendgate entirely. There is no
  way for a local CLI to prevent that. Enforce it operationally: make
  spendgate the single choke point (a wrapper script or SOP the agent must
  use), and reconcile the ledger against wallet activity to catch off-gate
  payments. spendgate never claims to be unbypassable.
- **It holds no keys and signs nothing.** It cannot pay on your behalf and
  cannot stop a payment that never passes through it.
- **It verifies nothing on-chain.** It judges the 402 JSON you hand it.
  Settlement, expiry, and facilitator behaviour are outside its view.
- **It does no sanctions or KYC screening.** The allowlist/denylist is
  yours to declare; spendgate does not check any sanctions list.
- **It promises no savings.** It caps spend; it does not promise a
  percentage saved. Any such number would be invented.
- **It is not a wallet, custodian, or payment processor.** It reads a
  payment request and writes a receipt. That is all.

## Open design questions

Three questions the first real discussion on this repo raised
(issue #1), written up in `docs/open-design-questions.md`:

- **Chain anchoring is unsolved.** A hash chain only proves
  "not rewritten" against a chain head the verifier trusts, and
  spendgate does not anchor the head anywhere yet.
- **Policy versioning is now pinned.** Each ledger entry carries the
  hash of the policy in force when it was recorded, and `check` notes
  entries recorded under a different policy.
- **Crash consistency under simultaneous approvals is not solved.**
  Two concurrent `record` calls can append conflicting lines, and a
  crash mid-append can leave a torn last line. Sequential use is
  unaffected; concurrent use needs a locking design first.

## Examples

- `examples/brave-402.json` - a 402 response in the public Brave shape:
  amount `5000` base units USDC ($0.005), chain `eip155:8453`, EIP-3009,
  one payment option, expiry 300s. The payee address is synthetic; the
  asset address is the public USDC contract on Base. No real wallet, no
  real key, no real payment.
- `examples/ledger-sample.jsonl` - a small hash-chained ledger generated
  by the real CLI, for trying `check` and `report` without recording
  anything yourself (`spendgate check --config examples/demo-policy.json
  --ledger examples/ledger-sample.jsonl`).
- `demo/transcript.txt` - the full demo transcript (real CLI output).
  `demo/spendgate-demo.gif` renders it.

## Development

```sh
npm run build      # tsc, strict
npm test           # build + unit + e2e (node --test)
npm run lint       # eslint + prettier check
node scripts/preflight.js   # Rule 7: ASCII-only, no internal names
node scripts/bench.js       # verdict + ledger timings
```

## License

MIT. See `LICENSE`.
