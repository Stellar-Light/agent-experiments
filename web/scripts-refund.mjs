/**
 * Momo's refund worker (GitHub Actions). For every policy-declined inbound
 * payment not yet refunded, prove a confidential_transfer back to the payer
 * for exactly the decrypted amount and record it in public/refunds.json.
 * Node has no serverless time cap, so proving here is fine (~2-3s per refund).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Keypair, Address, xdr, Networks } from "@stellar/stellar-sdk";
import { StateEngine, deriveSk, deriveKeys, skSigningMessage, addressToField, reviveState } from "stellar-confidential-token-sdk";
import { proveTransfer } from "stellar-confidential-token-sdk/node";
import { ChainClient, keypairSigner, hybridFetchEvents } from "stellar-confidential-token-sdk/chain";

const S = JSON.parse(readFileSync("src/session.json", "utf8"));
const MOMO = S.momo.address;
const TERMS = { minTicketXlm: 0.5, maxPaymentsPerCustomerPerHour: 6, blocklist: ["GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWQ"] };
const client = new ChainClient({ rpcUrl: "https://soroban-testnet.stellar.org", networkPassphrase: Networks.TESTNET, contracts: S.contracts });
const kp = Keypair.fromSecret(S.momo.secret), signer = keypairSigner(kp.secret(), Networks.TESTNET);
const root = new Uint8Array(kp.signMessage(Buffer.from(skSigningMessage(S.contracts.token, MOMO))));
const { sk, addrF } = deriveSk(root, S.contracts.token, MOMO);
const keys = deriveKeys(sk, addrF, addressToField(MOMO));
const addr = (a) => new Address(a).toScVal();

const cpAll = existsSync("public/checkpoint.json") ? JSON.parse(readFileSync("public/checkpoint.json", "utf8")) : null;
const cp = cpAll?.agents?.momo;
const from = cp ? Math.max(S.fromLedger, cp.savedAtLedger - 50) : S.fromLedger;
const { events } = await hybridFetchEvents(client, undefined, { fromLedger: from });
const mine = events.filter((e) => e.type === "register" || e.type === "merge" ? e.account === MOMO : e.from === MOMO || e.to === MOMO);
const eng = new StateEngine({ address: MOMO, keys, store: cp ? { load: async () => reviveState(cp.state), save: async () => {} } : undefined });
if (cp) await eng.load();
const fresh = cp ? mine.filter((e) => e.ledger > cp.state.lastLedger) : mine;
eng.ingestEvents(fresh);
const inbound = [...(cp?.state?.inbound ?? []), ...fresh.filter((e) => e.type === "transfer" && e.to === MOMO).map((e) => ({ txHash: e.txHash, ledger: e.ledger, from: e.from, amount: Number(eng.decryptIncoming(e.rE, e.vTilde, e.sigma).vTx) / 1e7 }))];

const refPath = "public/refunds.json";
const ref = existsSync(refPath) ? JSON.parse(readFileSync(refPath, "utf8")) : { done: [] };
const doneTx = new Set(ref.done.map((d) => d.tx));
// Same rules as the till (lib/policy.ts), evaluated at each payment's OWN ledger with prior-only velocity,
// so a payment's verdict is stable over time: what was delivered stays delivered, what was declined is refundable.
// Refunds from Momo itself are excluded (they're outbound, not inbound; inbound list is to==MOMO only).
const declined = inbound.filter((e) => {
  if (doneTx.has(e.txHash)) return false;
  if (e.ledger < 4182200) return false; // policy went live at ledger 4182200 (terms v2026-08-17.1); earlier payments were delivered under no-policy terms
  if (TERMS.blocklist.includes(e.from)) return true;
  if (e.amount < TERMS.minTicketXlm) return true;
  const prior = inbound.filter((x) => x.from === e.from && x.ledger < e.ledger && e.ledger - x.ledger < 720).length;
  return prior >= TERMS.maxPaymentsPerCustomerPerHour;
});
console.log(`declined & unrefunded: ${declined.length}`);
if (declined.length) {
  // merge receiving -> spendable so Momo can spend
  await client.invoke(S.contracts.token, "merge", [addr(MOMO)], signer);
  const { events: ev2 } = await hybridFetchEvents(client, undefined, { fromLedger: from });
  const eng2 = new StateEngine({ address: MOMO, keys, store: cp ? { load: async () => reviveState(cp.state), save: async () => {} } : undefined });
  if (cp) await eng2.load();
  eng2.ingestEvents((cp ? ev2.filter((e) => e.ledger > cp.state.lastLedger) : ev2).filter((e) => e.type === "register" || e.type === "merge" ? e.account === MOMO : e.from === MOMO || e.to === MOMO));
  let sp = eng2.state().spendable;
  const kAud = await client.auditorKey(0);
  for (const d of declined) {
    const payer = await client.confidentialBalance(d.from);
    if (!payer) { console.log(`skip ${d.txHash.slice(0,10)}: payer not registered`); continue; }
    const amount = BigInt(Math.round(d.amount * 1e7));
    if (sp.v < amount) { console.log("insufficient spendable"); break; }
    const t = await proveTransfer({ keys, v: sp.v, r: sp.r, amount, pvkB: payer.viewingPublicKey, kAudR: kAud, kAudS: kAud });
    const out = await client.invoke(S.contracts.token, "confidential_transfer", [addr(MOMO), addr(d.from), xdr.ScVal.scvBytes(Buffer.from(t.payload))], signer);
    sp = t.next; // SDK returns the post-transfer opening
    ref.done.push({ tx: d.txHash, refundTx: out.hash, to: d.from, amountXlm: d.amount, at: new Date().toISOString() });
    console.log(`refunded ${d.amount} XLM to ${d.from.slice(0,8)}… tx ${out.hash}`);
  }
}
writeFileSync(refPath, JSON.stringify(ref, null, 2));
