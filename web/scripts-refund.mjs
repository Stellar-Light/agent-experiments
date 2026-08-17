/**
 * The merchants' refund worker (GitHub Actions). For every policy-declined inbound
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
// Fixed, signed terms per merchant: mirror of lib/merchants.ts + lib/policy.ts. Terms are NOT visitor-configurable,
// precisely so this worker can re-derive every verdict from chain facts alone (see lib/merchants.ts).
const MERCHANTS = [
  { id: "momo", terms: { minTicketXlm: 0.5, maxPaymentsPerCustomerPerHour: 6 } },
  { id: "kiki", terms: { minTicketXlm: 1, maxPaymentsPerCustomerPerHour: 3 } },
];
const BLOCKLIST = ["GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWQ"];
const POLICY_LIVE_LEDGER = 4182200; // terms v2026-08-17.1 took effect here; earlier payments were delivered under no-policy terms
const client = new ChainClient({ rpcUrl: "https://soroban-testnet.stellar.org", networkPassphrase: Networks.TESTNET, contracts: S.contracts });
const addr = (a) => new Address(a).toScVal();
const cpAll = existsSync("public/checkpoint.json") ? JSON.parse(readFileSync("public/checkpoint.json", "utf8")) : null;
const refPath = "public/refunds.json";
const ref = existsSync(refPath) ? JSON.parse(readFileSync(refPath, "utf8")) : { done: [] };
const doneTx = new Set(ref.done.map((d) => d.tx));

for (const { id, terms: TERMS } of MERCHANTS) {
  if (!S[id]) continue;
  const ME = S[id].address;
  const kp = Keypair.fromSecret(S[id].secret), signer = keypairSigner(kp.secret(), Networks.TESTNET);
  const root = new Uint8Array(kp.signMessage(Buffer.from(skSigningMessage(S.contracts.token, ME))));
  const { sk, addrF } = deriveSk(root, S.contracts.token, ME);
  const keys = deriveKeys(sk, addrF, addressToField(ME));
  const cp = cpAll?.agents?.[id];
  const from = cp ? Math.max(S.fromLedger, cp.savedAtLedger - 50) : S.fromLedger;
  const mineOf = (evs) => evs.filter((e) => e.type === "register" || e.type === "merge" ? e.account === ME : e.from === ME || e.to === ME);
  const engineFrom = async (evs) => {
    const eng = new StateEngine({ address: ME, keys, store: cp ? { load: async () => reviveState(cp.state), save: async () => {} } : undefined });
    if (cp) await eng.load();
    eng.ingestEvents(cp ? mineOf(evs).filter((e) => e.ledger > cp.state.lastLedger) : mineOf(evs));
    return eng;
  };
  const { events } = await hybridFetchEvents(client, undefined, { fromLedger: from });
  const eng = await engineFrom(events);
  const fresh = cp ? mineOf(events).filter((e) => e.ledger > cp.state.lastLedger) : mineOf(events);
  const inbound = [...(cp?.state?.inbound ?? []), ...fresh.filter((e) => e.type === "transfer" && e.to === ME).map((e) => ({ txHash: e.txHash, ledger: e.ledger, from: e.from, amount: Number(eng.decryptIncoming(e.rE, e.vTilde, e.sigma).vTx) / 1e7 }))];

  // Same rules as the till (lib/policy.ts), evaluated at each payment's OWN ledger with prior-only velocity,
  // so a payment's verdict is stable over time: what was delivered stays delivered, what was declined is refundable.
  const declined = inbound.filter((e) => {
    if (doneTx.has(e.txHash)) return false;
    if (e.ledger < POLICY_LIVE_LEDGER) return false;
    if (BLOCKLIST.includes(e.from)) return true;
    if (e.amount < TERMS.minTicketXlm) return true;
    const prior = inbound.filter((x) => x.from === e.from && x.ledger < e.ledger && e.ledger - x.ledger < 720).length;
    return prior >= TERMS.maxPaymentsPerCustomerPerHour;
  });
  console.log(`[${id}] inbound ${inbound.length}, declined & unrefunded: ${declined.length}`);
  if (!declined.length) continue;
  // merge receiving -> spendable so the merchant can spend
  await client.invoke(S.contracts.token, "merge", [addr(ME)], signer);
  const { events: ev2 } = await hybridFetchEvents(client, undefined, { fromLedger: from });
  let sp = (await engineFrom(ev2)).state().spendable;
  const kAud = await client.auditorKey(0);
  for (const d of declined) {
    const payer = await client.confidentialBalance(d.from);
    if (!payer) { console.log(`[${id}] skip ${d.txHash.slice(0, 10)}: payer not registered`); continue; }
    const amount = BigInt(Math.round(d.amount * 1e7));
    if (sp.v < amount) { console.log(`[${id}] insufficient spendable`); break; }
    const t = await proveTransfer({ keys, v: sp.v, r: sp.r, amount, pvkB: payer.viewingPublicKey, kAudR: kAud, kAudS: kAud });
    const out = await client.invoke(S.contracts.token, "confidential_transfer", [addr(ME), addr(d.from), xdr.ScVal.scvBytes(Buffer.from(t.payload))], signer);
    sp = t.next; // SDK returns the post-transfer opening
    ref.done.push({ tx: d.txHash, refundTx: out.hash, to: d.from, amountXlm: d.amount, merchant: id, at: new Date().toISOString() });
    console.log(`[${id}] refunded ${d.amount} XLM to ${d.from.slice(0, 8)}… tx ${out.hash}`);
  }
}
writeFileSync(refPath, JSON.stringify(ref, null, 2));
