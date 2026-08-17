/**
 * POST /api/momo/quote  { buyer, offer? }
 * Momo quotes from its policy and its own decrypted books. Send an offer to
 * negotiate; Momo accepts at or above its private floor, otherwise declines
 * without revealing the floor. Every quote is signed by Momo and expires.
 */
import { momoBooks, policyQuote, considerOffer, signGoods, STROOP, MOMO } from "../../lib/momo.js";
import { issueInvoice } from "../../lib/invoice.js";

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
    const buyer = String(body.buyer ?? "");
    const offer = body.offer != null ? BigInt(Math.round(Number(body.offer) * 1e7)) : null;
    const { inbound } = await momoBooks();
    const latest = inbound.length ? Math.max(...inbound.map((e: any) => e.ledger)) : 0;
    const recent = inbound.filter((e: any) => latest - e.ledger < 720).length; // ~1 hour of ledgers
    const p = policyQuote(inbound.length, recent);
    const expiresAt = Date.now() + 5 * 60_000;
    if (offer != null) {
      const verdict = considerOffer(offer, p.floor);
      const q = { buyer, priceXlm: verdict.accept ? Number(offer) / 1e7 : Number(p.quote) / 1e7, accepted: verdict.accept, note: verdict.note, expiresAt, seller: MOMO };
      const inv = verdict.accept && buyer ? issueInvoice(buyer, Number(offer) / 1e7) : null;
      res.status(200).json({ ...q, ...signGoods(q), invoice: inv });
      return;
    }
    if (body.accept === true && buyer) {
      // buyer takes the list quote as-is: issue the invoice at the quote price
      const inv = issueInvoice(buyer, Number(p.quote) / 1e7);
      res.status(200).json({ buyer, priceXlm: Number(p.quote) / 1e7, accepted: true, note: "deal", expiresAt, seller: MOMO, invoice: inv });
      return;
    }
    const q = { buyer, priceXlm: Number(p.quote) / 1e7, rationale: p.rationale, product: "settlement-currency brief", expiresAt, seller: MOMO,
      settlement: "confidential_transfer on the OpenZeppelin contract; the amount never appears on-chain" };
    res.status(200).json({ ...q, ...signGoods(q), booksHint: { paymentsEverReceived: inbound.length, lastHour: recent } });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
}
