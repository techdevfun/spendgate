#!/usr/bin/env bash
# Capture the demo transcript from the REAL CLI (no hand-edited output).
# Runs in a scratch dir so nothing pollutes the repo. The transcript is
# rendered to demo/spendgate-demo.gif by scripts/make-gif.py.
#
# The fixture payee is SYNTHETIC (an invented address); the demo policy
# is the `init` sample with that payee swapped into the allowlist and a
# denylist payee added. "Today" is pinned to 2026-11-14 (the day the
# fixtures were written) so the cap accounting scores the same way every
# time this script runs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH=/tmp/spendgate-demo
BIN="$SCRATCH/bin"
rm -rf "$SCRATCH"
mkdir -p "$BIN" "$ROOT/demo"
ln -sf "$ROOT/dist/cli.js" "$BIN/spendgate"
chmod +x "$ROOT/dist/cli.js"
export PATH="$BIN:$PATH"
export SPENDGATE_NOW=2026-11-14

WORK="$SCRATCH/work"
mkdir -p "$WORK"
# The demo runs from a neutral copy of the fixtures, never from the
# build dir, so no internal workspace path can appear in the
# transcript or the GIF. The CLI prints paths as given.
cp "$ROOT/examples/brave-402.json" "$SCRATCH/brave-402.json"
cd "$WORK"

OUT="$ROOT/demo/transcript.txt"
{
  echo "# spendgate demo - real CLI output on the SYNTHETIC Brave fixture"
  echo "# (payee 0xb1a9e... is invented; amount 5000 base units USDC ="
  echo "#  \$0.005 on eip155:8453; per-day cap \$2.50. Today is pinned to"
  echo "#  2026-11-14 so the cap accounting is reproducible.)"
  echo ""
  echo "\$ spendgate init"
  spendgate init
  echo ""
  echo "# the demo policy is the init sample with the fixture payee"
  echo "# swapped into the allowlist and a denylist payee added:"
  python3 - "$WORK/spendgate.json" <<'PYEOF'
import json, sys
p = json.load(open(sys.argv[1]))
p["allowlist"]["payees"] = ["0xb1a9e00000000000000000000000000000000001"]
p["denylist"]["payees"] = ["0xdead000000000000000000000000000000000001"]
json.dump(p, open(sys.argv[1], "w"), indent=2)
print("policy: allowlist payee set to the fixture payee")
print("policy: denylist payee set to 0xdead...0001")
PYEOF
  echo ""
  echo "\$ spendgate simulate --file ../brave-402.json"
  spendgate simulate --file ../brave-402.json
  echo ""
  echo "\$ spendgate simulate --file ../brave-402.json --payee 0xb1a9e00000000000000000000000000000000002   # lookalike"
  spendgate simulate --file ../brave-402.json --payee 0xb1a9e00000000000000000000000000000000002 || echo "exit: $?"
  echo ""
  echo "\$ spendgate simulate --file ../brave-402.json --payee 0xdead000000000000000000000000000000000001   # denylist"
  spendgate simulate --file ../brave-402.json --payee 0xdead000000000000000000000000000000000001 || echo "exit: $?"
  echo ""
  echo "\$ for i in \$(seq 1 500); do spendgate record --file ../brave-402.json > /dev/null; done"
  for i in $(seq 1 500); do spendgate record --file ../brave-402.json > /dev/null; done
  echo "500 payments recorded (each \$0.005, ledger total \$2.50)"
  echo ""
  echo "\$ spendgate simulate --file ../brave-402.json   # the 501st identical payment"
  spendgate simulate --file ../brave-402.json || echo "exit: $?"
  echo ""
  echo "\$ spendgate report"
  spendgate report
  echo ""
  echo "\$ spendgate check"
  spendgate check || echo "exit: $?"
} > "$OUT" 2>&1
echo "transcript written: $OUT ($(wc -l < "$OUT") lines)"
