/** GET /api/momo/health: replay-window headroom + checkpoint freshness. Degraded = the demo is dying. */
import { momoBooks, RPC } from "../../lib/momo.js";
import { replayHeadroom } from "../../lib/checkpoint.js";
export default async function handler(_req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const b = await momoBooks();
    const h = await replayHeadroom(RPC, b.replayFrom);
    res.status(h.degraded ? 503 : 200).json({ ok: !h.degraded, checkpoint: b.checkpoint, replayFrom: b.replayFrom, ...h, paymentsSeen: b.inbound.length });
  } catch (e: any) { res.status(500).json({ ok: false, error: String(e?.message ?? e) }); }
}
