/**
 * E6 — Confidential agent commerce on Stellar testnet.
 *
 * Two autonomous agents complete a real purchase where the PRICE PAID IS
 * HIDDEN ON-CHAIN:
 *
 *   VEGA (seller) — a data vendor. Builds a signed market report from live
 *   StellarLight data and sells it for 40 XLM.
 *   NOVA (buyer)  — wants the report. Pays the invoice CONFIDENTIALLY via
 *   OpenZeppelin Confidential Tokens (testnet deployment), then receives the
 *   signed goods after Vega verifies the credit by decrypting it.
 *
 * Everything is receipted: registration/deposit/merge/transfer tx hashes,
 * proof timings, the on-chain encrypted commitments (what the public sees),
 * Vega's decrypted credit (what the recipient sees), Nova's decrypted change
 * (what the sender sees), and the auditor-encryption facts (what auditor #0
 * could see). Output: receipt.json + envelope XDRs archived per tx.
 *
 * Adapted from stellar-confidential-token-sdk examples/live-payment.mjs
 * (Soneso-unrelated; SDK by aguilar1x, contracts by OpenZeppelin). Testnet only.
 */

import { Keypair, Networks, Address, nativeToScVal, xdr, hash } from "@stellar/stellar-sdk";
import {
  deriveSk, deriveKeys, skSigningMessage, pointToBytes, StateEngine, addressToField,
} from "stellar-confidential-token-sdk";
import { proveRegister, proveTransfer } from "stellar-confidential-token-sdk/node";
import { ChainClient, keypairSigner, hybridFetchEvents } from "stellar-confidential-token-sdk/chain";
import { writeFileSync } from "node:fs";

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK = Networks.TESTNET;
const CONTRACTS = {
  token: "CBFOJTALVTO3LPZZHEXDD44K7RQKQJGAASF6XOKP5FWZD6WYKV4WN7HF",
  verifier: "CBXEPTSEC3433EH3TKUZSSZCIWIDMGZDY2FB7BN5IJ76A2JISQF4YTN6",
  auditor: "CDCPR4AURWJQRY4KXSRU7H7ABKIHTDORSQABIOUH37DU3IGYV5LRCHEK",
};
const AUDITOR_ID = 0;
const STROOP = 10_000_000n;
const DEPOSIT = 100n * STROOP;   // Nova's public deposit into the confidential contract
const PRICE = 40n * STROOP;      // Vega's invoice — this number never appears on-chain

const addr = (a) => new Address(a).toScVal();
const u32 = (n) => xdr.ScVal.scvU32(n);
const i128Val = (v) => nativeToScVal(v, { type: "i128" });
const bytesVal = (b) => xdr.ScVal.scvBytes(Buffer.from(b));
const hex = (b) => Buffer.from(b).toString("hex");
const now = () => new Date().toISOString();

const receipt = {
  experiment: "confidential-agent-commerce",
  network: "stellar:testnet",
  contracts: CONTRACTS,
  auditorId: AUDITOR_ID,
  startedAt: now(),
  agents: {},
  commerce: [],   // the agent-to-agent message log
  chain: [],      // every on-chain action: {step, tx, ledger, at, note}
  proofs: [],     // {step, seconds}
  views: {},      // the four views, filled at the end
  product: null,
};
const say = (who, msg, extra = {}) => {
  const m = { at: now(), from: who, msg, ...extra };
  receipt.commerce.push(m);
  console.log(`  [${who}] ${msg}`);
};
const chainLog = (step, res, note) => {
  const entry = { step, tx: res.hash, ledger: res.ledger ?? null, at: now(), note };
  receipt.chain.push(entry);
  console.log(`    ⛓ ${step}: tx ${res.hash}`);
};

function eventsFor(address, events) {
  return events.filter((ev) => {
    switch (ev.type) {
      case "register": case "merge": return ev.account === address;
      case "deposit": case "withdraw": case "transfer": return ev.from === address || ev.to === address;
      default: return false;
    }
  });
}
async function rebuildState(client, address, keys) {
  const engine = new StateEngine({ address, keys });
  const { events } = await hybridFetchEvents(client, undefined, { fromLedger: 0 });
  engine.ingestEvents(eventsFor(address, events));
  return engine;
}
async function fundAccount(pk) {
  const res = await fetch(`https://friendbot.stellar.org?addr=${pk}`);
  if (!res.ok && res.status !== 400) throw new Error(`friendbot failed for ${pk}: ${res.status}`);
}
function confidentialIdentity(kp) {
  const message = skSigningMessage(CONTRACTS.token, kp.publicKey());
  const root = new Uint8Array(kp.signMessage(Buffer.from(message)));
  const { sk, addrF } = deriveSk(root, CONTRACTS.token, kp.publicKey());
  return { keys: deriveKeys(sk, addrF, addressToField(kp.publicKey())), address: kp.publicKey() };
}

/** VEGA's product: a small market report built from live StellarLight data, signed. */
async function buildProduct(vegaKp) {
  let facts;
  try {
    const r = await fetch("https://stellarlight.xyz/api/stablecoins?limit=3", { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const rows = (j.stablecoins ?? j.data ?? []).slice(0, 3);
    facts = rows.map((s) => ({ ticker: s.ticker, marketCapUSD: s.marketCapUSD, holders: s.holders }));
  } catch {
    facts = [{ note: "live fetch unavailable at runtime; static fallback", ticker: "USDC" }];
  }
  const body = { title: "Stellar Settlement-Currency Brief", asOf: now(), source: "stellarlight.xyz/api/stablecoins", facts };
  const payload = Buffer.from(JSON.stringify(body));
  const signature = vegaKp.sign(hash(payload)).toString("base64");
  return { body, sha256: hash(payload).toString("hex"), signature, signer: vegaKp.publicKey() };
}

async function main() {
  const client = new ChainClient({ rpcUrl: RPC_URL, networkPassphrase: NETWORK, contracts: CONTRACTS });

  // ── 0 · two fresh agents, funded
  const nova = Keypair.random();  // buyer
  const vega = Keypair.random();  // seller
  // PUBLISH_SESSION=1: persist the session (secrets included, DELIBERATELY —
  // testnet accounts holding nothing, published so a frontend can run the real
  // client per the SDK web demo's own precedent).
  const publishSession = process.env.PUBLISH_SESSION === "1";
  const novaSigner = keypairSigner(nova.secret(), NETWORK);
  const vegaSigner = keypairSigner(vega.secret(), NETWORK);
  receipt.agents = {
    nova: { role: "buyer", address: nova.publicKey() },
    vega: { role: "seller (data vendor)", address: vega.publicKey() },
  };
  console.log(`\n[0] NOVA (buyer)  ${nova.publicKey()}\n    VEGA (seller) ${vega.publicKey()}`);
  await Promise.all([fundAccount(nova.publicKey()), fundAccount(vega.publicKey())]);
  console.log("    both funded via friendbot");

  // ── 1 · confidential identities derived, nothing stored
  const novaId = confidentialIdentity(nova);
  const vegaId = confidentialIdentity(vega);
  console.log("\n[1] confidential identities derived per SDK.md §5.1 (deterministic, nothing persisted)");

  // ── 2 · auditor key read from the registry — selective disclosure is part of the protocol
  const kAud = await client.auditorKey(AUDITOR_ID);
  console.log(`\n[2] auditor #${AUDITOR_ID} key read from registry ${CONTRACTS.auditor.slice(0, 8)}…`);

  // ── 3 · both agents register on the confidential token contract
  console.log("\n[3] registering both agents on the live contract (UltraHonk proofs)…");
  for (const [name, id, signer] of [["nova", novaId, novaSigner], ["vega", vegaId, vegaSigner]]) {
    if (await client.isRegistered(id.address)) { console.log(`    ${name} already registered`); continue; }
    const t0 = Date.now();
    const { payload } = await proveRegister(id.keys);
    receipt.proofs.push({ step: `register-${name}`, seconds: +((Date.now() - t0) / 1000).toFixed(1) });
    const res = await client.invoke(CONTRACTS.token, "register", [addr(id.address), u32(AUDITOR_ID), bytesVal(payload)], signer);
    chainLog(`register-${name}`, res, `${name} joins the confidential token, auditor #${AUDITOR_ID} attached`);
  }

  // ── 4 · THE COMMERCE — quote → invoice → confidential payment → delivery
  console.log("\n[4] agent commerce begins");
  say("nova", "Requesting product: latest settlement-currency brief. What's your price?");
  say("vega", `Quote: 40 XLM, payable confidentially to ${vega.publicKey().slice(0, 8)}… — amount will not appear on-chain.`, { priceStroops: PRICE.toString() });

  // Nova provisions confidential funds: public deposit (by design), then merge
  console.log("\n[5] nova provisions confidential balance…");
  const dep = await client.invoke(CONTRACTS.token, "deposit", [addr(nova.publicKey()), addr(nova.publicKey()), i128Val(DEPOSIT)], novaSigner);
  chainLog("deposit-nova", dep, "public 100 XLM enters the confidential contract (deposits are public by design)");
  const mrg = await client.invoke(CONTRACTS.token, "merge", [addr(nova.publicKey())], novaSigner);
  chainLog("merge-nova", mrg, "receiving → spendable");

  const novaState = await rebuildState(client, nova.publicKey(), novaId.keys);
  const spendable = novaState.state().spendable;
  console.log(`    nova spendable = ${spendable.v / STROOP} XLM (decrypted locally)`);

  // The confidential payment itself
  say("nova", "Paying the invoice confidentially now.");
  const t0 = Date.now();
  const transfer = await proveTransfer({
    keys: novaId.keys, v: spendable.v, r: spendable.r, amount: PRICE,
    pvkB: vegaId.keys.PVK, kAudR: kAud, kAudS: kAud,
  });
  receipt.proofs.push({ step: "confidential-transfer", seconds: +((Date.now() - t0) / 1000).toFixed(1) });
  const pay = await client.invoke(
    CONTRACTS.token, "confidential_transfer",
    [addr(nova.publicKey()), addr(vega.publicKey()), bytesVal(transfer.payload)], novaSigner,
  );
  chainLog("confidential-transfer", pay, "THE PAYMENT — amount encrypted on-chain; auditor ciphertext embedded in the proof payload");
  say("nova", `Payment sent. tx ${pay.hash.slice(0, 12)}… — check your receiving balance.`);

  // ── 6 · vega verifies the credit by DECRYPTING it, then delivers
  console.log("\n[6] vega verifies payment by rebuilding + decrypting its own state…");
  const vegaEngine = await rebuildState(client, vega.publicKey(), vegaId.keys);
  const credited = vegaEngine.receiving();
  console.log(`    vega decrypted receiving = ${credited.v / STROOP} XLM`);
  if (credited.v !== PRICE) throw new Error(`vega expected ${PRICE}, decrypted ${credited.v}`);
  say("vega", `Payment verified: decrypted exactly 40 XLM received. Delivering goods.`);
  receipt.product = await buildProduct(vega);
  say("vega", `Delivered: "${receipt.product.body.title}" — sha256 ${receipt.product.sha256.slice(0, 16)}…, signed.`);
  const sigOk = vega.verify(hash(Buffer.from(JSON.stringify(receipt.product.body))), Buffer.from(receipt.product.signature, "base64"));
  say("nova", `Goods received; signature ${sigOk ? "verified" : "FAILED"}. Transaction complete.`);
  if (!sigOk) throw new Error("product signature failed verification");

  // ── 7 · the four views
  console.log("\n[7] assembling the four views…");
  const vegaOnchain = await client.confidentialBalance(vega.publicKey());
  const novaOnchain = await client.confidentialBalance(nova.publicKey());
  const novaAfter = await rebuildState(client, nova.publicKey(), novaId.keys);
  const novaCheck = novaAfter.verifyAgainstChain({
    spendableC: pointToBytes(novaOnchain.spendableBalance),
    receivingC: pointToBytes(novaOnchain.receivingBalance),
  });
  receipt.views = {
    public_chain: {
      what: "what any explorer or observer sees",
      vega_receiving_commitment: hex(pointToBytes(vegaOnchain.receivingBalance)),
      nova_spendable_commitment: hex(pointToBytes(novaOnchain.spendableBalance)),
      amount_visible: false,
      note: "elliptic-curve commitments only; the 40 XLM figure appears nowhere on-chain",
    },
    recipient_vega: {
      what: "what the seller decrypts with its own derived key",
      decrypted_receiving_stroops: credited.v.toString(),
      decrypted_receiving_xlm: (credited.v / STROOP).toString(),
    },
    sender_nova: {
      what: "what the buyer decrypts as remaining change",
      decrypted_spendable_stroops: novaAfter.state().spendable.v.toString(),
      decrypted_spendable_xlm: (novaAfter.state().spendable.v / STROOP).toString(),
      verified_against_chain: novaCheck.ok === true,
    },
    auditor: {
      what: "what auditor #0 (from the on-chain registry) can decrypt",
      auditor_registry: CONTRACTS.auditor,
      auditor_id: AUDITOR_ID,
      mechanism: "kAudR/kAudS ciphertexts are constrained into the transfer proof itself — disclosure is protocol-level, not voluntary",
      we_hold_this_key: false,
      note: "we are not auditor #0, so we cannot show the decryption — the point is that the registered auditor can, and the proof will not verify without that ciphertext",
    },
  };
  receipt.finishedAt = now();

  // ── 8 · archive envelope XDRs (testnet resets erase hash lookups; XDRs survive)
  console.log("\n[8] archiving envelope XDRs…");
  for (const c of receipt.chain) {
    try {
      const r = await fetch(RPC_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash: c.tx } }),
      });
      const j = await r.json();
      c.envelopeXdr = j.result?.envelopeXdr ?? null;
      c.ledger = j.result?.ledger ?? c.ledger;
      c.closedAt = j.result?.createdAt ? new Date(j.result.createdAt * 1000).toISOString() : null;
    } catch { c.envelopeXdr = null; }
  }

  writeFileSync(new URL("./receipt.json", import.meta.url).pathname, JSON.stringify(receipt, null, 1));
  const firstLed = Math.min(...receipt.chain.map((x) => x.ledger).filter(Boolean));
  writeFileSync(new URL(`./receipt-${firstLed}.json`, import.meta.url).pathname, JSON.stringify(receipt, null, 1));
  if (publishSession) {
    const firstLedger = Math.min(...receipt.chain.map((c) => c.ledger).filter(Boolean));
    writeFileSync(new URL("./session.json", import.meta.url).pathname, JSON.stringify({
      publishedOnPurpose: "testnet accounts holding nothing; secrets published so the frontend can run the real client (decrypt + verify) in the browser",
      network: "stellar:testnet", contracts: CONTRACTS, auditorId: AUDITOR_ID,
      nova: { address: nova.publicKey(), secret: nova.secret() },
      vega: { address: vega.publicKey(), secret: vega.secret() },
      fromLedger: firstLedger - 5,
      priceStroops: PRICE.toString(), depositStroops: DEPOSIT.toString(),
      chain: receipt.chain.map(({ step, tx, ledger, closedAt }) => ({ step, tx, ledger, closedAt })),
      product: receipt.product, commerce: receipt.commerce, proofs: receipt.proofs, views: receipt.views,
    }, null, 1));
    console.log("   session.json written (published-on-purpose testnet session)");
  }
  console.log("\n✅ Confidential agent commerce settled on testnet. The price never appeared on-chain.");
  console.log(`   payment tx: https://stellar.expert/explorer/testnet/tx/${pay.hash}`);
  console.log("   receipt.json written");
}

main().catch((e) => {
  console.error("\n❌ " + (e?.message ?? e));
  if (e?.stack) console.error(e.stack.split("\n").slice(1, 5).join("\n"));
  receipt.error = String(e?.message ?? e);
  writeFileSync(new URL("./receipt.json", import.meta.url).pathname, JSON.stringify(receipt, null, 1));
  process.exit(1);
});
