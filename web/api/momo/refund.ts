/**
 * POST /api/momo/refund { tx }
 * Momo refunds a payment its policy declined: a confidential_transfer BACK
 * to the payer for exactly the decrypted amount, from Momo's own balance,
 * proven server-side. Only payments that were policy-declined are refundable
 * (delivered goods are final), and each tx is refundable once.
 *
 * This is what makes "held, not seized" true. Testnet.
 */
import { momoBooks, merchantById } from "../../lib/momo.js";
import { decide } from "../../lib/policy.js";


export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
    const tx = String(body.tx ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(tx)) { res.status(400).json({ error: "tx required" }); return; }
    const M = merchantById(body.merchant ?? req.query?.merchant);
    const { inbound, engine } = await momoBooks(M);
    const ev: any = inbound.find((e: any) => String(e.txHash).toLowerCase() === tx);
    if (!ev) { res.status(404).json({ error: `no payment to ${M.name} in that tx` }); return; }
    const paidXlm = typeof ev.amount === "number" ? ev.amount : Number(engine.decryptIncoming(ev.rE, ev.vTilde, ev.sigma).vTx) / 1e7;
    const customerLedgers = (inbound as any[]).filter((e) => e.from === ev.from).map((e) => e.ledger as number);
    const verdict = decide({ from: ev.from, paidXlm, ledger: ev.ledger, customerLedgers }, M);
    if (verdict.allow) { res.status(409).json({ error: "that payment passed policy and was delivered; nothing to refund" }); return; }

    // Refunds are PROVEN by Momo's worker (full Node, no serverless time cap), not in this function.
    // Here Momo commits to the refund: eligibility verified above, intent recorded, worker executes.
    const already = await fetch("https://confidential-agent-commerce.vercel.app/refunds.json", { cache: "no-store" }).then((x) => x.ok ? x.json() : { done: [] }).catch(() => ({ done: [] }));
    const done = (already.done ?? []).find((d: any) => d.tx === tx);
    if (done) { res.status(200).json({ refunded: true, to: ev.from, amountXlm: paidXlm, refundTx: done.refundTx, reason: `${verdict.rule}: ${verdict.reason}` }); return; }
    // queue via repository_dispatch so the worker runs now (needs GH token in env; otherwise the 12h schedule catches it)
    let dispatched = false;
    if (process.env.GH_DISPATCH_TOKEN) {
      const d = await fetch("https://api.github.com/repos/Stellar-Light/confidential-agent-commerce/dispatches", {
        method: "POST", headers: { Authorization: `Bearer ${process.env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json" },
        body: JSON.stringify({ event_type: "refund", client_payload: { tx, merchant: M.id } }) });
      dispatched = d.status === 204;
    }
    res.status(202).json({ refunded: false, queued: true, dispatched, to: ev.from, amountXlm: paidXlm,
      reason: `${verdict.rule}: ${verdict.reason}`, note: `${M.name}'s worker proves and submits the refund (confidential_transfer back to you); check /refunds.json for the refund tx` });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
}
