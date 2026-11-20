# Open design questions

Three questions raised by the first real discussion on this repo
(issue #1, follow-ups from @tempometer, 19/11/2026). They are written
down here instead of answered with a shrug, because each one marks a
place where the current design stops and a judgement call starts.
Status is as of 20/11/2026.

## 1. Chain anchoring: who trusts the chain head?

A hash chain proves "not rewritten" only against a chain head the third
party trusts. If the operator holds the only copy of the ledger, they
can rewrite the whole chain from genesis and hand over a clean-looking
record. spendgate today does nothing about this: no network, no
signing, no on-chain verification, by design (see "Honest limits" in
the README).

Options on the table:

- **Export-and-sign.** The operator periodically signs the current
  chain head and publishes the signature somewhere the verifier can
  find later (a gist, a release asset, an email). Cheap, no chain
  needed, but the verifier must trust that the published head is the
  real one, and there is no proof about *when* it was published.
- **Periodic notarization.** Publish the chain head to a timestamping
  service or a public log at fixed intervals. Stronger on "when", but
  it adds a dependency and a recurring step the operator must not skip.
- **Self-contained signed verdicts.** Instead of anchoring the chain,
  sign each verdict at decision time (the approach @tempometer's team
  landed on for their competition use-case). This moves trust from the
  chain head to the signing key, which is a different problem, not a
  smaller one - key management replaces anchoring.

Status: **open, no choice made.** What would decide it is the first
real third party who has to verify a ledger - an auditor, a judge, a
competition - and what evidence they will accept. Until that verifier
exists, the third-party case itself is design-forward: no auditor,
competition, or client is lined up yet. Our bet is that auditors
arrive via operators (an operator adopts the gate, then their auditor
asks for the record), not directly from readers of the write-up.

## 2. Policy versioning: which rules were in force?

The ledger records each decision "under which rule", but until
20/11/2026 it did not record *which version* of the policy file was in
force. Edit the policy today and yesterday's entries silently change
meaning: an ALLOW that was correct under the old caps is replayed
against the new ones, and `check` cannot tell a rule change apart
from a bad record.

Fixed in this round: `record` now stamps every ledger entry with
`policyHash`, the SHA-256 of the parsed policy in force at the time.
`check` notes entries recorded under a different policy without
failing - editing the policy is legitimate, and the replay already
judges old ALLOWs against the current rules. The note only lets an
auditor trace a replay violation back to a rule change instead of
mistaking it for a tampered record.

What the fix does **not** do:

- It does not sign the policy or prove who approved it. The hash is a
  fingerprint, not a signature.
- It does not stop policy edits or freeze a policy version. A frozen,
  referenceable policy (publish the policy file, pin it by hash, make
  the ledger point at it) is still an open step.
- Entries written before this feature have no hash. They still load
  and verify; `check` simply has nothing to compare for them.

## 3. Crash consistency under simultaneous approvals

This is where the local gate's simplicity gets tested first, and it is
**not solved yet**. Findings below come from reading the code, not
from a failure report - nobody has hit this in production, because
nobody is running spendgate in production yet.

How `record` works today: load the whole ledger, compute the next
`seq` and `prevHash` from its tail, then append one line. There is no
lock, no atomic write, and no fsync.

- **Two concurrent `record` calls** can both read the same tail and
  both append a line with the same `seq` and the same `prevHash`.
  The chain then fails `check` (duplicate seq, broken link), and the
  only repair is manual: drop one of the two lines and re-record it.
- **A crash mid-append** can leave a torn last line (partial JSON).
  `check` then exits 2 ("ledger line N is not valid JSON") until the
  torn line is removed. Nothing is silently lost - the torn line is
  visible - but recovery is manual.
- **Sequential use is unaffected.** The 500-payment demo records one
  payment at a time in a single process, so none of this applies to
  it.

What a fix would look like: an exclusive lock file around the
read-append step, or append-to-temp plus atomic rename, plus a
documented recovery for a torn tail. That is real work with real
failure modes of its own (stale locks, lock files on shared drives),
so it waits for a decision - and for a first user who actually runs
concurrent approvals - before we claim concurrent safety.

## How to use this file

If you are evaluating spendgate, these three questions are the honest
boundary of what it guarantees today. If you have a fourth, open an
issue: the thread on #1 shaped this roadmap more than the stars did.
