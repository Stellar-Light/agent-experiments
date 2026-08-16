# agent-experiments

Receipted experiments pushing what AI agents can do on Stellar. **Testnet only.**

Every experiment here follows one rule: it is the smallest run that produces a
frontier receipt you can read in 30 seconds. The receipt — transaction hashes,
timings, verified effects — is the deliverable; the code exists so you can
reproduce it.

| # | experiment | one line | status |
|---|---|---|---|
| e6 | [confidential-commerce](./e6-confidential-commerce/) | Two agents complete a purchase whose price settles encrypted on-chain — quote → confidential payment → decryption-verified delivery, ~20s end to end. | ✅ settled 2026-08-16 |

## Ground rules

- **Testnet only.** Keys are generated at runtime and never stored. Nothing here
  is audited; do not adapt for value.
- **Receipts first.** Every on-chain claim links a transaction hash, and full
  envelope XDRs are archived alongside (testnet resets erase explorers, not
  archives).
- **Credits stay attached.** Each experiment's README names the contracts,
  SDKs, and prior art it stands on.
