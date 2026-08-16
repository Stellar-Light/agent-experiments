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
let spendable = (await rebuild()).state().spendable;
if (spendable.v < AMOUNT + 2n * STROOP) {
  const dep = await client.invoke(CONTRACTS.token, "deposit", [addr(me.address), addr(me.address), i128(AMOUNT + 50n * STROOP)], signer);
  console.log(`[${me.name}] deposited into the contract (public, by design) · tx ${dep.hash.slice(0, 12)}…`);
  const mrg = await client.invoke(CONTRACTS.token, "merge", [addr(me.address)], signer);
  console.log(`[${me.name}] merged · tx ${mrg.hash.slice(0, 12)}…`);
  spendable = (await rebuild()).state().spendable;
}

console.log(`[${me.name}] paying ${Number(AMOUNT) / 1e7} XLM to the merchant — confidentially… (proving)`);
const kAud = await client.auditorKey(0);
const t0 = Date.now();
const transfer = await proveTransfer({ keys, v: spendable.v, r: spendable.r, amount: AMOUNT,
  pvkB: (await client.confidentialBalance(MERCHANT))?.viewingPublicKey ?? (() => { throw new Error("merchant not registered on the confidential contract"); })(),
  kAudR: kAud, kAudS: kAud });
console.log(`[${me.name}] proof in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const pay = await client.invoke(CONTRACTS.token, "confidential_transfer", [addr(me.address), addr(MERCHANT), bytesVal(transfer.payload)], signer);

console.log(`
✅ ${me.name} paid the merchant. The amount is not on-chain.
   tx  https://stellar.expert/explorer/testnet/tx/${pay.hash}
   Open https://confidential-agent-commerce.vercel.app — the merchant's
   decrypted total on that page now includes your payment. Your agent:
   ${me.address}
`);
