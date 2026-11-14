# Contributing to spendgate

## Ground rules

- spendgate judges payment requests only. No wallet access, no signing,
  no on-chain verification, no billing API calls, no sanctions/KYC
  screening. If a feature touches those, it belongs in a different tool.
- No invented numbers. Verdicts in fixtures and docs are the
  fixture's own, labeled as such. No savings claims.
- Never read, print or store secret values, keys, or wallet credentials.
  The ledger stores decisions only: amounts, payees, vendors, verdicts.
- All public content is ASCII English only. No em dash - use `-`
  (hyphen). Run `npm run preflight` before opening a PR.
- TypeScript strict, zero runtime dependencies, Node 20+.

## Workflow

```sh
npm install
npm run build     # tsc strict, must be clean
npm run lint      # eslint + prettier, must be clean
npm test          # unit + e2e (40 tests)
npm run preflight # ASCII-only + no-internal-names scan
npm run bench     # verdict + ledger-append timing
```

## Adding a verdict rule

1. Add the rule to `src/verdict.ts` (one reason per firing rule, in the
   documented order). Keep evaluation a pure function of policy +
   request + ledger history.
2. Add unit tests in `test/unit.test.js` (boundary cases) and an e2e
   case in `test/e2e.test.js` if the rule changes CLI output or exits.
3. Update the rules list in the README and the help text in `src/cli.ts`
   if the surface changed.

## Adding a fixture

1. Keep it synthetic: invented payee addresses, invented vendors,
   invented dates. Never copy a real wallet address or a real payment.
2. Pin fixture dates against the day the fixture was written and note
   the date in `examples/README.md`; the test suite pins "today"
   with SPENDGATE_NOW so results stay deterministic.
3. Lock the expected verdict and totals into `test/e2e.test.js`.
