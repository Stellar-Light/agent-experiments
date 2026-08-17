/**
 * Buy the brief over MPP with confidential settlement.
 *   node mpp-buy.mjs [--merchant momo|kiki] [--name Juno]
 * Uses your persistent my-agent.json identity (see join.mjs).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Keypair, Networks, Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { deriveSk, deriveKeys, skSigningMessage, addressToField, StateEngine, pointToBytes } from "stellar-confidential-token-sdk";
import { proveRegister } from "stellar-confidential-token-sdk/node";
import { ChainClient, keypairSigner, hybridFetchEvents } from "stellar-confidential-token-sdk/chain";
import { parseChallenge, payChallenge } from "../web/lib/mpp/client.mjs";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > -1 ? process.argv[i + 1] : d; };
const MERCHANT = arg("merchant", "momo");
const SITE = process.env.MOMO_SITE ?? "https://confidential-agent-commerce.vercel.app";
const CONTRACTS = { token: "CBFOJTALVTO3LPZZHEXDD44K7RQKQJGAASF6XOKP5FWZD6WYKV4WN7HF", verifier: "CBXEPTSEC3433EH3TKUZSSZCIWIDMGZDY2FB7BN5IJ76A2JISQF4YTN6", auditor: "CDCPR4AURWJQRY4KXSRU7H7ABKIHTDORSQABIOUH37DU3IGYV5LRCHEK" };
const RPC = "https://soroban-testnet.stellar.org";
const post = (m, p = {}) => fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }).then(r => r.json());

// identity (same file join.mjs uses)
let me;
if (existsSync("./my-agent.json")) me = JSON.parse(readFileSync("./my-agent.json", "utf8"));
else { const kp = Keypair.random(); const latest = (await post("getLatestLedger")).result.sequence; me = { name: arg("name", "Wanderer"), address: kp.publicKey(), secret: kp.secret(), bornLedger: latest - 20, network: "stellar:testnet" }; writeFileSync("./my-agent.json", JSON.stringify(me, null, 2)); await fetch(`https://friendbot.stellar.org?addr=${me.address}`); console.log(`[${me.name}] born ${me.address}`); }
const kp = Keypair.fromSecret(me.secret), signer = keypairSigner(kp.secret(), Networks.TESTNET);
const client = new ChainClient({ rpcUrl: RPC, networkPassphrase: Networks.TESTNET, contracts: CONTRACTS });
const root = new Uint8Array(kp.signMessage(Buffer.from(skSigningMessage(CONTRACTS.token, me.address))));
const { sk, addrF } = deriveSk(root, CONTRACTS.token, me.address); const keys = deriveKeys(sk, addrF, addressToField(me.address));
if (!(await client.isRegistered(me.address))) { const { payload } = await proveRegister(keys); await client.invoke(CONTRACTS.token, "register", [new Address(me.address).toScVal(), xdr.ScVal.scvU32(0), xdr.ScVal.scvBytes(Buffer.from(payload))], signer); console.log(`[${me.name}] registered`); }
const oldest = (await post("getHealth")).result?.oldestLedger ?? 0;
const rebuild = async () => { const { events } = await hybridFetchEvents(client, undefined, { fromLedger: Math.max(me.bornLedger ?? oldest, oldest) }); const e = new StateEngine({ address: me.address, keys }); e.ingestEvents(events.filter(ev => ev.type === "register" || ev.type === "merge" ? ev.account === me.address : ev.from === me.address || ev.to === me.address)); return e; };
let eng = await rebuild();
if (BigInt(eng.receiving().v) > 0n) { await client.invoke(CONTRACTS.token, "merge", [new Address(me.address).toScVal()], signer); eng = await rebuild(); }

// 1) ask for the resource: expect 402 + MPP challenge
console.log(`[${me.name}] GET ${SITE}/api/mpp/brief?merchant=${MERCHANT}`);
const r1 = await fetch(`${SITE}/api/mpp/brief?merchant=${MERCHANT}`);
if (r1.status !== 402) { console.log("unexpected", r1.status, await r1.text()); process.exit(1); }
const challenge = parseChallenge(r1);
console.log(`[mpp] 402 challenge id=${challenge.id.slice(0, 10)}… method=${challenge.method} intent=${challenge.intent} amount=${Number(challenge.request.amount) / 1e7} XLM to ${challenge.request.recipient.slice(0, 8)}… settlement=${challenge.request.settlement}`);

// funds
let sp = eng.state().spendable;
const need = BigInt(challenge.request.amount);
if (sp.v < need + 2n * 10_000_000n) {
  await client.invoke(CONTRACTS.token, "deposit", [new Address(me.address).toScVal(), new Address(me.address).toScVal(), nativeToScVal(need + 50n * 10_000_000n, { type: "i128" })], signer);
  await client.invoke(CONTRACTS.token, "merge", [new Address(me.address).toScVal()], signer);
  eng = await rebuild(); sp = eng.state().spendable;
}
{ const oc = await client.confidentialBalance(me.address); const chk = eng.verifyAgainstChain({ spendableC: pointToBytes(oc.spendableBalance), receivingC: pointToBytes(oc.receivingBalance) }); if (!chk.ok) { console.log(`[${me.name}] state mismatch with chain; delete my-agent.json for a fresh agent`); process.exit(1); } }

// 2) pay the challenge confidentially, build the credential
console.log(`[${me.name}] paying the challenge confidentially (proving)…`);
const cred = await payChallenge({ challenge, client, contracts: CONTRACTS, me: { address: me.address, kp }, keys, spendable: sp, signer });
console.log(`[${me.name}] settled tx ${cred.hash} (amount encrypted on-chain); credential = Payment <…>`);

// 3) retry with Authorization: Payment <credential>
let r2, body;
for (let i = 0; i < 8; i++) {
  r2 = await fetch(`${SITE}/api/mpp/brief?merchant=${MERCHANT}`, { headers: { Authorization: cred.header } });
  body = await r2.text();
  if (r2.status === 200) break;
  await new Promise(z => setTimeout(z, 2500));
}
console.log(`[mpp] ${r2.status} ${r2.status === 200 ? "Payment-Receipt: " + (r2.headers.get("payment-receipt") ?? "").slice(0, 40) + "…" : body.slice(0, 200)}`);
if (r2.status === 200) { const j = JSON.parse(body); console.log(`[${me.name}] got "${j.brief.title}" from ${j.brief.seller}, signed ${String(j.signature).slice(0, 10)}…\n\n✅ confidential MPP: standard 402 challenge, confidential settlement, merchant verified by decryption.\n   tx https://stellar.expert/explorer/testnet/tx/${cred.hash}`); }
