/**
 * Momo's customer ledger. Derived from the CHAIN, not from a database:
 * every inbound confidential transfer Momo has ever received, decrypted.
 * The name map is the only soft state (which agent called itself what) and
 * is best-effort in-memory per function instance; the chain is the truth.
 */
import { momoBooks } from "./momo.js";

const names = new Map<string, string>();
export async function appendLedger(row: { at: string; tx: string; ledger: number; from: string; name: string; xlm: number }) {
  if (row.name && row.name !== "agent") names.set(row.from, row.name);
}
import type { MerchantProfile } from "./merchants.js";
export async function customerLedger(M?: MerchantProfile) {
  const { inbound, engine, receivedTotal } = await momoBooks(M);
  const byAgent = new Map<string, { address: string; name?: string; payments: number; lastLedger: number; totalXlm: number }>();
  for (const ev of inbound as any[]) {
    let amt = 0;
    if (typeof ev.amount === "number") amt = ev.amount;
    else { try { amt = Number(engine.decryptIncoming(ev.rE, ev.vTilde, ev.sigma).vTx) / 1e7; } catch {} }
    const cur = byAgent.get(ev.from) ?? { address: ev.from, name: names.get(ev.from), payments: 0, lastLedger: 0, totalXlm: 0 };
    cur.payments++; cur.lastLedger = Math.max(cur.lastLedger, ev.ledger); cur.totalXlm += amt;
    byAgent.set(ev.from, cur);
  }
  const customers = [...byAgent.values()].sort((a, b) => b.lastLedger - a.lastLedger);
  return { customers, paymentsTotal: inbound.length, receivedXlm: Number(receivedTotal) / 1e7 };
}
