/**
 * Bring your own agent.
 *
 *   node join.mjs --name Zuko [--merchant G...] [--amount 3]
 *
 * Creates (or reloads) YOUR agent — a persistent identity saved to
 * my-agent.json — funds it on testnet, registers it on the confidential
 * token contract, and pays the merchant confidentially. Run it again and
 * the same agent comes back: same address, same face on the site.
 *
 * Testnet only. my-agent.json holds a TESTNET secret — never reuse the
 * pattern for real keys.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Keypair, Networks, Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { deriveSk, deriveKeys, skSigningMessage, addressToField, StateEngine } from "stellar-confidential-token-sdk";
import { proveRegister, proveTransfer } from "stellar-confidential-token-sdk/node";
import { ChainClient, keypairSigner, hybridFetchEvents } from "stellar-confidential-token-sdk/chain";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > -1 ? process.argv[i + 1] : d; };
const NAME = arg("name", "Wanderer");
const MERCHANT = arg("merchant", "GCVDNTJA23S7DZNIWEWQLWMXBA5KA5Y6SWKMOHSMN2FIQKHHSRKV5BV5"); // Momo
const AMOUNT = BigInt(Math.round(parseFloat(arg("amount", String(1 + Math.floor(Math.random() * 5)))) * 1e7));
const STROOP = 10_000_000n;
const CONTRACTS = {
  token: "CBFOJTALVTO3LPZZHEXDD44K7RQKQJGAASF6XOKP5FWZD6WYKV4WN7HF",
  verifier: "CBXEPTSEC3433EH3TKUZSSZCIWIDMGZDY2FB7BN5IJ76A2JISQF4YTN6",
  auditor: "CDCPR4AURWJQRY4KXSRU7H7ABKIHTDORSQABIOUH37DU3IGYV5LRCHEK",
};
const addr = (a) => new Address(a).toScVal();
const i128 = (v) => nativeToScVal(v, { type: "i128" });
const bytesVal = (b) => xdr.ScVal.scvBytes(Buffer.from(b));

// ── your agent: persistent identity ─────────────────────────────────────────
let me;
if (existsSync("./my-agent.json")) {
  me = JSON.parse(readFileSync("./my-agent.json", "utf8"));
  console.log(`\n[${me.name}] back again: ${me.address}`);
} else {
  const kp = Keypair.random();
  me = { name: NAME, address: kp.publicKey(), secret: kp.secret(), createdAt: new Date().toISOString(), network: "stellar:testnet" };
  writeFileSync("./my-agent.json", JSON.stringify(me, null, 2));
  console.log(`\n[${me.name}] born: ${me.address}\n  identity saved to my-agent.json (testnet only). Same agent, same face, every run.`);
}
const kp = Keypair.fromSecret(me.secret);
const signer = keypairSigner(kp.secret(), Networks.TESTNET);
const client = new ChainClient({ rpcUrl: "https://soroban-testnet.stellar.org", networkPassphrase: Networks.TESTNET, contracts: CONTRACTS });

const fb = await fetch(`https://friendbot.stellar.org?addr=${me.address}`);
if (!fb.ok && fb.status !== 400) throw new Error("friendbot failed");
console.log(`[${me.name}] funded on testnet`);

const message = skSigningMessage(CONTRACTS.token, me.address);
const root = new Uint8Array(kp.signMessage(Buffer.from(message)));
const { sk, addrF } = deriveSk(root, CONTRACTS.token, me.address);
const keys = deriveKeys(sk, addrF, addressToField(me.address));

if (!(await client.isRegistered(me.address))) {
  const { payload } = await proveRegister(keys);
  const r = await client.invoke(CONTRACTS.token, "register", [addr(me.address), xdr.ScVal.scvU32(0), bytesVal(payload)], signer);
  console.log(`[${me.name}] registered on the confidential token · tx ${r.hash.slice(0, 12)}…`);
} else console.log(`[${me.name}] already registered`);

const fromLedger = (await fetch("https://soroban-testnet.stellar.org", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }) }).then(r => r.json())).result.sequence - 100000;
const rebuild = async () => {
  const { events } = await hybridFetchEvents(client, undefined, { fromLedger: Math.max(0, fromLedger) });
  const eng = new StateEngine({ address: me.address, keys });
  eng.ingestEvents(events.filter((ev) => ev.type === "register" || ev.type === "merge" ? ev.account === me.address : ev.from === me.address || ev.to === me.address));
  return eng;
};
// ── talk to Momo for real: ask for a quote, negotiate within budget ──
const SITE = process.env.MOMO_SITE ?? "https://confidential-agent-commerce.vercel.app";
const BUDGET = AMOUNT;
let agreed = null;
const q1 = await fetch(`${SITE}/api/momo/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ buyer: me.address }) }).then(r => r.json());
console.log(`[momo] quotes ${q1.priceXlm} XLM (${q1.rationale}; ${q1.booksHint?.paymentsEverReceived} payments on its books)`);
const quoted = BigInt(Math.round(q1.priceXlm * 1e7));
if (quoted <= BUDGET) { agreed = quoted; console.log(`[${me.name}] fine, ${Number(quoted) / 1e7} XLM`); }
else {
  let offer = BigInt(Math.min(Number(BUDGET), Math.round(Number(quoted) * 0.6)));
  for (let r = 0; r < 3 && agreed === null; r++) {
    console.log(`[${me.name}] offers ${Number(offer) / 1e7} XLM`);
    const q2 = await fetch(`${SITE}/api/momo/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ buyer: me.address, offer: Number(offer) / 1e7 }) }).then(r => r.json());
    console.log(`[momo] ${q2.note}`);
    if (q2.accepted) { agreed = offer; break; }
    const next = offer + (quoted - offer) / 2n;
    if (next > BUDGET || next <= offer) break;
    offer = next;
  }
}
if (agreed === null) { console.log(`\n[${me.name}] no deal within budget ${Number(BUDGET) / 1e7} XLM. Nothing paid. Raise --amount to try again.`); process.exit(0); }
console.log(`[${me.name}] paying ${Number(agreed) / 1e7} XLM to Momo, confidentially… (proving)`);
let spendable = (await rebuild()).state().spendable;
if (spendable.v < agreed + 2n * STROOP) {
  const dep = await client.invoke(CONTRACTS.token, "deposit", [addr(me.address), addr(me.address), i128(agreed + 50n * STROOP)], signer);
  console.log(`[${me.name}] deposited into the contract (public, by design) · tx ${dep.hash.slice(0, 12)}…`);
  const mrg = await client.invoke(CONTRACTS.token, "merge", [addr(me.address)], signer);
  console.log(`[${me.name}] merged · tx ${mrg.hash.slice(0, 12)}…`);
  spendable = (await rebuild()).state().spendable;
}

const kAud = await client.auditorKey(0);
const t0 = Date.now();
const transfer = await proveTransfer({ keys, v: spendable.v, r: spendable.r, amount: agreed,
  pvkB: (await client.confidentialBalance(MERCHANT))?.viewingPublicKey ?? (() => { throw new Error("merchant not registered on the confidential contract"); })(),
  kAudR: kAud, kAudS: kAud });
console.log(`[${me.name}] proof in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const pay = await client.invoke(CONTRACTS.token, "confidential_transfer", [addr(me.address), addr(MERCHANT), bytesVal(transfer.payload)], signer);

// ── Momo checks the till by decrypting THIS transfer, then delivers signed goods ──
let served = null;
for (let a = 0; a < 6 && !served?.delivered; a++) {
  served = await fetch(`${SITE}/api/momo/pay?tx=${pay.hash}&agreed=${Number(agreed) / 1e7}&name=${encodeURIComponent(me.name)}`).then(r => r.json()).catch(() => null);
  if (served?.delivered || (served?.paid && !served?.delivered && served?.decryptedXlm != null)) break;
  await new Promise(r => setTimeout(r, 2500));
}
console.log(served?.delivered ? `[momo] decrypted exactly ${served.decryptedXlm} XLM from your transfer, matches, delivered "${served.brief.title}" (signed ${String(served.signature).slice(0,10)}…)` : `[momo] ${served?.error ?? "no reply"}`);
console.log(`
✅ ${me.name} paid Momo. The amount is not on-chain.
   tx  https://stellar.expert/explorer/testnet/tx/${pay.hash}
   Open https://confidential-agent-commerce.vercel.app: you are now a row in
   Momo's customer ledger (from the chain, decrypted by Momo). Your agent:
   ${me.address}
`);
