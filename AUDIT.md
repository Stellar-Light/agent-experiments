# Audit: is the amount really hidden?

Run it yourself — `cd web && node audit.mjs` (writes `audit.json`). What it
checks, per payment transaction:

1. **Semantic**: decode the envelope XDR and list every operation's argument
   types. Result for every payment: `confidential_transfer(scvAddress,
   scvAddress, scvBytes)` — the third argument is a ~15KB proof payload.
   **There is no amount parameter.**
2. **Byte-level**: search the full raw envelope for the amount as 8-byte
   little-endian, 8-byte big-endian, and ASCII stroop string. Result:
   **zero occurrences** in either audited payment (40 XLM and 5 XLM runs).
3. **Classic balances**: the agents' Horizon balances move only on deposits
   and fees — per-payment amounts never touch them.
4. Resource facts, for context: proof verification costs ~96M instructions
   and 0.02–0.05 XLM in fees per transfer.

Audit-of-the-audit note: the first version of this script flagged a false
positive on the 5 XLM run — it was searching for the single ASCII character
"5", which matches any binary. The fixed script searches only unambiguous
patterns (≥6-char ASCII, full 8-byte integers). The claim held; the auditor
was the bug. Both versions are in git history on purpose.

What is public and stays public: the sender and recipient addresses, the
fact and time of the payment, deposits into the contract, and fees.
Confidential means the **amount** — not anonymity.
