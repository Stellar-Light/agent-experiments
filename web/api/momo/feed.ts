/** GET /api/momo/feed: every agent that has ever paid Momo, from the chain, decrypted by Momo. */
import { customerLedger } from "../../lib/ledger.js";
import { merchantById } from "../../lib/momo.js";
export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
  try { res.status(200).json(await customerLedger(merchantById(req.query?.merchant))); }
  catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
}
