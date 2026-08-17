# Confidential Agent Commerce

Two autonomous agents transact on Stellar testnet. The amount settles
**encrypted on-chain** — the seller confirms payment by decrypting it, a
registered auditor can always read it, and everyone else sees nothing.

**Live: https://confidential-agent-commerce.vercel.app** · [60-second recording of a real run](./demo.webm) (survives testnet resets) — press the button
and a brand-new payment is negotiated, proven (zero-knowledge, in your
browser), and settled on testnet while you watch. Every run is a real
transaction with a random price that never appears on-chain.

## What actually happens

1. **MOMO** (seller) quotes a price for a data product.
2. **PIP** (buyer) generates an UltraHonk zero-knowledge proof and submits a
   `confidential_transfer` to OpenZeppelin's Confidential Token contract.
   Open the transaction on any explorer: there is no amount — only
   elliptic-curve commitments.
3. MOMO rebuilds its balance from public chain events and **decrypts** its
   receiving balance with a key derived from one signature. If the decrypted
   delta matches the invoice, it ships the goods, signed.
4. PIP verifies the signature, and its own reconstructed state is checked
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

## The market: two merchants, a buyer that shops

Momo and Kiki are two merchant agents running as live services with their own
keys, price profiles, and policies (same till software, different shops):

| merchant | list | floor (private) | pricing | min ticket | velocity |
|---|---|---|---|---|---|
| Momo | 5 XLM | 2 XLM | surge: +0.3 XLM per payment in the last hour, capped | 0.5 XLM | 6 / customer / hour |
| Kiki | 4 XLM | 3.5 XLM | flat, no surge | 1 XLM | 3 / customer / hour |

`GET /api/market` returns every merchant's live quote and track record (from
the chain, decrypted by each merchant's own key). Pip reads it and chooses by
a shopping policy: cheapest quote, most track record, or a named merchant. Then
it fetches that merchant's signed terms, negotiates within its private budget,
pays confidentially, attests the invoice, and the merchant decrypt-verifies
before delivering. Every merchant endpoint takes `?merchant=momo|kiki`.

What you see is a market: a busy Momo surges above a quiet Kiki; Kiki refuses
lowballs its firm floor won't take; a cheap-and-unproven shop competes with an
expensive-and-established one, and the buyer decides.

## The 402-gated API (confidential x402)

`GET /api/brief` answers **HTTP 402 Payment Required** with a Stellar
confidential-transfer scheme. Pay the seller confidentially, retry with
`?tx=<hash>`, and the server verifies the payment **from the transaction
envelope alone**: it checks the invocation is a `confidential_transfer` to the
seller on the OpenZeppelin contract, is successful, and is recent. It cannot
read the amount; that is the point. On success it serves the product,
Ed25519-signed by the seller.

```sh
curl https://confidential-agent-commerce.vercel.app/api/brief
# 402 {"scheme":"stellar-confidential-transfer","payTo":"G...","contract":"C...","how":"..."}
curl "https://confidential-agent-commerce.vercel.app/api/brief?tx=<your confidential_transfer hash>"
# 200 {"paid":true,"brief":{...},"sha256":"...","signature":"...","signer":"G..."}
```

An agent that pays a metered API without the amount ever appearing on-chain.
Source: [`web/api/brief.ts`](web/api/brief.ts). Production would bind an
invoice nonce into the transfer so a payment cannot be replayed across
requests; here a 10-minute freshness window stands in for that.

## Add confidential payments to your own agent

The whole client side is one call to the SDK plus a contract invocation:

```js
import { deriveSk, deriveKeys, skSigningMessage, addressToField } from "stellar-confidential-token-sdk";
import { proveTransfer } from "stellar-confidential-token-sdk/node";
import { ChainClient, keypairSigner } from "stellar-confidential-token-sdk/chain";

const root = new Uint8Array(kp.signMessage(Buffer.from(skSigningMessage(TOKEN, kp.publicKey()))));
const { sk, addrF } = deriveSk(root, TOKEN, kp.publicKey());
const keys = deriveKeys(sk, addrF, addressToField(kp.publicKey()));      // nothing stored, ever

const { payload } = await proveTransfer({ keys, v, r, amount, pvkB: sellerViewingKey, kAudR: kAud, kAudS: kAud });
await client.invoke(TOKEN, "confidential_transfer", [addr(me), addr(seller), bytesVal(payload)], signer);
```

`agents/join.mjs` is the complete, runnable version (fund, register,
deposit, pay, ~80 lines).

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
