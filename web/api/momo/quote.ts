/**
 * POST /api/momo/quote  { buyer, offer? }
 * Momo quotes from its policy and its own decrypted books. Send an offer to
 * negotiate; Momo accepts at or above its private floor, otherwise declines
 * without revealing the floor. Every quote is signed by Momo and expires.
 */
import { momoBooks, quoteFor, considerOffer, signGoods, merchantById } from "../../lib/momo.js";
import { issueInvoice } from "../../lib/invoice.js";

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
    const M = merchantById(body.merchant ?? req.query?.merchant, body.cfg ?? req.query?.cfg);
    const MOMO = M.address;
    const buyer = String(body.buyer ?? "");
    const offer = body.offer != null ? BigInt(Math.round(Number(body.offer) * 1e7)) : null;
    const books = await momoBooks(M);
    const { inbound } = books;
    const p = quoteFor(M, books);
    const recent = p.recent;
    const expiresAt = Date.now() + 5 * 60_000;
    if (offer != null) {
      const verdict = considerOffer(offer, p.floor);
      const q = { buyer, priceXlm: verdict.accept ? Number(offer) / 1e7 : Number(p.quote) / 1e7, accepted: verdict.accept, note: verdict.note, expiresAt, seller: MOMO };
      const inv = verdict.accept && buyer ? issueInvoice(buyer, Number(offer) / 1e7, M) : null;
      res.status(200).json({ ...q, merchant: M.id, ...signGoods(q, M), invoice: inv });
      return;
    }
    if (body.accept === true && buyer) {
      // buyer takes the list quote as-is: issue the invoice at the quote price
      const inv = issueInvoice(buyer, Number(p.quote) / 1e7, M);
      res.status(200).json({ buyer, priceXlm: Number(p.quote) / 1e7, accepted: true, note: "deal", expiresAt, seller: MOMO, merchant: M.id, invoice: inv });
      return;
    }
    const q = { buyer, priceXlm: Number(p.quote) / 1e7, rationale: p.rationale, product: M.product, expiresAt, seller: MOMO, merchant: M.id,
      settlement: "confidential_transfer on the OpenZeppelin contract; the amount never appears on-chain" };
    res.status(200).json({ ...q, ...signGoods(q, M), booksHint: { paymentsEverReceived: inbound.length, lastHour: recent } });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
}
