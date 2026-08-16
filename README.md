# Confidential Agent Commerce

Two autonomous agents transact on Stellar testnet. The amount settles
**encrypted on-chain** — the seller confirms payment by decrypting it, a
registered auditor can always read it, and everyone else sees nothing.

**Live: https://confidential-agent-commerce.vercel.app** — press the button
and a brand-new payment is negotiated, proven (zero-knowledge, in your
browser), and settled on testnet while you watch. Every run is a real
transaction with a random price that never appears on-chain.

## What actually happens

1. **VEGA** (seller) quotes a price for a data product.
2. **NOVA** (buyer) generates an UltraHonk zero-knowledge proof and submits a
   `confidential_transfer` to OpenZeppelin's Confidential Token contract.
   Open the transaction on any explorer: there is no amount — only
   elliptic-curve commitments.
3. VEGA rebuilds its balance from public chain events and **decrypts** its
   receiving balance with a key derived from one signature. If the decrypted
   delta matches the invoice, it ships the goods, signed.
4. NOVA verifies the signature, and its own reconstructed state is checked
   **byte-for-byte against the commitments the chain holds** — an RPC or
   archive can lie; the chain's own points cannot.

One payment, four views:

| observer | sees |
|---|---|
| anyone (explorer, rival agent) | that a transfer happened, between which addresses — never the amount |
| seller | the exact amount, decrypted with its own derived key |
| buyer | its change, chain-verified |
| the registered auditor | the amount — the proof refuses to verify without the auditor's ciphertext |

Full mechanics (commitments, key derivation, what the proof proves, why the
auditor is not optional): **https://confidential-agent-commerce.vercel.app/how/**

## Repository layout

```
agents/   the two-agent commerce run as a Node script + receipts
          (receipt.json includes every tx hash and archived envelope XDRs)
web/      the site: one page that runs a real payment from the browser,
          plus /how — the documentation
```

## Run it yourself

The agents, headless:

```sh
cd agents
npm install
node agents-commerce.mjs      # fresh keypairs, friendbot-funded, ~60s
```

The site, locally:

```sh
cd web
npm install
npm run dev
```

## Built on

- [OpenZeppelin Confidential Tokens](https://github.com/OpenZeppelin/stellar-contracts) —
  the contracts (confidential balances, UltraHonk verifier, auditor registry),
  deployed on Stellar testnet.
- [`stellar-confidential-token-sdk`](https://github.com/aguilar1x/stellar-confidential-token-sdk)
  by aguilar1x — the conformant TypeScript client (key derivation, witness
  building, proving, state replay, chain verification).

## Caveats

Testnet only. The client SDK is v0.1.x and unaudited — do not hold value with
it. Confidential means the **amount** is hidden; addresses and the existence
of payments are public. The session keys in `web/src/session.json` are
published deliberately: testnet accounts holding nothing, so the page can run
the real client in your browser.

---

Part of an ongoing series of receipted experiments into what autonomous
agents can do on Stellar. An AI copilot was used during the build and its
knowledge gaps were logged as data (`agents/raven-e6-buildlog.json`).
