/**
 * The merchant's brief, sold over MPP (HTTP Payment Authentication):
 *   GET /api/mpp/brief?merchant=momo
 *     -> 402 + WWW-Authenticate: Payment ...  challenge: stellar / confidential-charge
 *   GET /api/mpp/brief  with  Authorization: Payment <credential>
 *     -> the server verifies by DECRYPTING the confidential transfer and
 *        returns the brief with a Payment-Receipt header.
 *
 * Standard MPP handshake; the settlement is confidential. To our knowledge
 * the first confidential-settlement MPP method anywhere.
 */
import { mppFor } from "../../lib/mpp/server.js";
import { merchantById, momoBooks, policyQuote, signGoods } from "../../lib/momo.js";

function toWebRequest(req: any): Request {
  const proto = req.headers["x-forwarded-proto"] ?? "https";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  const url = `${proto}://${host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  return new Request(url, { method: req.method, headers });
}

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Expose-Headers", "www-authenticate, payment-receipt");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  try {
    const M = merchantById(req.query?.merchant, req.query?.cfg);
    const { inbound } = await momoBooks(M);
    const latest = inbound.length ? Math.max(...inbound.map((e: any) => e.ledger)) : 0;
    const recent = inbound.filter((e: any) => latest - e.ledger < 720).length;
    const p = policyQuote(inbound.length, recent, { listXlm: M.listXlm, floorXlm: M.floorXlm, surgePerPaymentXlm: M.surgePerPaymentXlm, surgeCapXlm: M.surgeCapXlm, name: M.name, product: M.product });
    const mppx: any = mppFor(M);
    const handlerFn = mppx["stellar/confidential-charge"];
    // MPP pins a presented credential to the request it is verified against ({amount, currency, recipient}).
    // On the paid retry, honor the price the buyer was challenged with (HMAC-authenticated + expiry-bounded),
    // not a re-quote from live books; on the first call, quote live.
    let amount = p.quote.toString();
    const authz = req.headers?.authorization ?? req.headers?.Authorization;
    if (authz) {
      try {
        const { Credential } = await import("mppx");
        const cred = Credential.fromRequest(toWebRequest(req));
        const challenged = (cred.challenge as any)?.request?.amount;
        if (typeof challenged === "string" && /^\d+$/.test(challenged)) amount = challenged;
      } catch {}
    }
    const result = await handlerFn({ amount, description: `${M.name}: ${M.product} (confidential settlement)` })(toWebRequest(req));
    if (result.status === 402) {
      const c: Response = result.challenge;
      c.headers.forEach((v: string, k: string) => res.setHeader(k, v));
      res.status(402).send(await c.text());
      return;
    }
    const brief = { title: "Stellar Settlement-Currency Brief", asOf: new Date().toISOString(), seller: M.name,
      paidVia: { protocol: "MPP stellar/confidential-charge", settlement: "confidential; the merchant decrypted the amount, the chain never showed it" },
      facts: ["This response was released by an MPP payment challenge whose settlement is an OpenZeppelin confidential transfer.", "Only the merchant and the registered auditor can read what you paid."] };
    const out: Response = result.withReceipt(new Response(JSON.stringify({ paid: true, brief, ...signGoods(brief, M) }), { headers: { "content-type": "application/json" } }));
    out.headers.forEach((v: string, k: string) => res.setHeader(k, v));
    res.status(200).send(await out.text());
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
}
