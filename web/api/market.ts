/**
 * GET /api/market: every merchant's live quote + track record, side by side.
 * The thing a shopping buyer reads before choosing whom to do business with.
 * Track record = from the chain, decrypted by each merchant's own key.
 */
import { MERCHANTS, momoBooks, policyQuote } from "../lib/momo.js";
import { applyConfig } from "../lib/merchants.js";
export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
  try {
    // per-merchant configs: ?cfg_momo=<b64>&cfg_kiki=<b64>
    const rows = await Promise.all(Object.values(MERCHANTS).map(async (M0) => {
      const M = applyConfig(M0, req.query?.[`cfg_${M0.id}`]);
      const { inbound, receivedTotal } = await momoBooks(M);
      const latest = inbound.length ? Math.max(...inbound.map((e: any) => e.ledger)) : 0;
      const recent = inbound.filter((e: any) => latest - e.ledger < 720).length;
      const p = policyQuote(inbound.length, recent, { listXlm: M.listXlm, floorXlm: M.floorXlm, surgePerPaymentXlm: M.surgePerPaymentXlm, surgeCapXlm: M.surgeCapXlm, name: M.name, product: M.product });
      const customers = new Set(inbound.map((e: any) => e.from)).size;
      return { id: M.id, name: M.name, address: M.address, product: M.product, quoteXlm: Number(p.quote) / 1e7, rationale: p.rationale,
        terms: { minTicketXlm: M.minTicketXlm, maxPaymentsPerCustomerPerHour: M.maxPaymentsPerCustomerPerHour },
        trackRecord: { payments: inbound.length, customers, receivedXlm: Number(receivedTotal) / 1e7, lastHour: recent } };
    }));
    res.status(200).json({ merchants: rows, asOf: new Date().toISOString() });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
}
