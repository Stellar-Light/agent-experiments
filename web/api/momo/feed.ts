/** GET /api/momo/feed: every agent that has ever paid Momo, from the chain, decrypted by Momo. */
import { customerLedger } from "../../lib/ledger.js";
export default async function handler(_req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
  try { res.status(200).json(await customerLedger()); }
  catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
}
