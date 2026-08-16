# e6 · Confidential agent commerce

Two autonomous agents complete a real purchase on Stellar testnet where **the
price paid is hidden on-chain**:

- **VEGA** (seller) — a data vendor. Quotes 40 XLM for a signed market brief.
- **NOVA** (buyer) — pays the invoice **confidentially** via OpenZeppelin
  Confidential Tokens; the amount appears nowhere on-chain.
- VEGA detects the credit by **decrypting its own receiving balance** from
  public chain events, verifies it matches the invoice, and delivers the
  Ed25519-signed goods. NOVA verifies the signature. Done.

To our knowledge this is the first agent-to-agent commerce transaction on
Stellar settled confidentially. End to end: **5 transactions, ledgers
4175079→4175083, ~20 seconds, proofs ≤1.8s each.**

## The payment

[`91a79853c7dd…`](https://stellar.expert/explorer/testnet/tx/91a79853c7dd945948a1780c9133149776dc3a4a5fe8381c7f0f9888dffa9f89)
— open it: there is no amount. The chain holds elliptic-curve commitments.

One payment, four views (full details in [`receipt.json`](./receipt.json), rendered in [`receipt.html`](./receipt.html)):

| view | sees |
|---|---|
| public chain | 🔒 commitments only — no amount |
| recipient (VEGA) | 40 XLM, decrypted with its own derived key |
| sender (NOVA) | 60 XLM change, verified byte-for-byte against chain commitments |
| auditor #0 | can decrypt — the proof refuses to verify without the auditor ciphertext (selective disclosure is protocol-level, not voluntary) |

## Reproduce

```sh
npm install
node agents-commerce.mjs
```

Fresh keypairs are generated and friendbot-funded at runtime; nothing is stored.
Expect ~1–2s per UltraHonk proof and a few RPC round-trips.

## Built with Raven as copilot

Each build step's "what would a cold builder ask?" question went to
[Raven](https://agents.stellar.buzz) first — logged with verdicts in
[`raven-e6-buildlog.json`](./raven-e6-buildlog.json). Score: **2 helped, 3
missed.** Raven routed general Soroban questions sharply; all three
confidential-stack questions missed at the *index* level — no source it holds
knows this layer exists yet. That gap is a data problem, and closing it is the
point of the ecosystem corpus work this experiment feeds.

## Credits & caveats

- Contracts: [OpenZeppelin `stellar-contracts`](https://github.com/OpenZeppelin/stellar-contracts)
  confidential package — testnet deployment
  (`CBFOJTALVTO3LPZZHEXDD44K7RQKQJGAASF6XOKP5FWZD6WYKV4WN7HF`, verifier, auditor registry).
- Client SDK: [`stellar-confidential-token-sdk`](https://github.com/aguilar1x/stellar-confidential-token-sdk)
  v0.1.9 by aguilar1x — **testnet only, not audited, do not hold value with it.**
- Flow adapted from the SDK's `examples/live-payment.mjs` into a two-agent
  commerce protocol (quote → confidential payment → decryption-verified delivery).
- Testnet throughout. Nothing here implies mainnet readiness or regulatory approval.
