/**
 * GET /api/momo/pay?tx=<hash>&agreed=<xlm>&name=<agent name>
 * Momo checks the till: finds THIS transfer in its own replayed events,
 * decrypts its amount with its own viewing key, and compares it with what
 * was agreed. Only then does it deliver, signed. The buyer's word is never
 * taken for anything; the buyer's amount is never public.
 */
import { momoBooks, signGoods, STROOP, merchantById, kpFor } from "../../lib/momo.js";
import { appendLedger } from "../../lib/ledger.js";
import { decide } from "../../lib/policy.js";
import { bindInvoice, checkRedeem } from "../../lib/invoice.js";
import { Buffer } from "node:buffer";
import { xdr, Keypair, hash } from "@stellar/stellar-sdk";
import { RPC, SESSION } from "../../lib/momo.js";

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const tx = String(req.query?.tx ?? "").toLowerCase();
  const agreed = Number(req.query?.agreed ?? NaN);
  const name = String(req.query?.name ?? "agent").slice(0, 24);
  const M = merchantById(req.query?.merchant);
  if (!/^[0-9a-f]{64}$/.test(tx)) { res.status(400).json({ error: "tx hash required" }); return; }
  try {
    const { inbound, engine } = await momoBooks(M);
    const ev: any = inbound.find((e: any) => String(e.txHash).toLowerCase() === tx);
    if (!ev) { res.status(402).json({ paid: false, error: `no confidential transfer to ${M.name} found in that transaction (yet); retry in a few seconds` }); return; }
    const paidXlm = typeof ev.amount === "number" ? ev.amount : Number(engine.decryptIncoming(ev.rE, ev.vTilde, ev.sigma).vTx) / 1e7;
    if (Number.isFinite(agreed) && Math.abs(paidXlm - agreed) > 1e-7) {
      res.status(402).json({ paid: true, delivered: false, decryptedXlm: paidXlm, error: `you paid ${paidXlm} XLM but we agreed ${agreed}` });
      return;
    }
    // ── invoice binding: the PAYER attests {invoiceId, tx} with the same key that signed the payment.
    //    Soroban transactions cannot carry memos (the network rejects them at simulation), so the binding
    //    is a signature by ev.from over the invoice id + tx hash: cryptographically ties this payer, this
    //    payment, and this invoice. Invoices are single-use; tx hashes are unique; replay fails at redeem.
    let bound: { ok: boolean; reason?: string; invoiceId?: string } = { ok: false, reason: "no invoice binding presented" };
    try {
      const presented = req.query?.invoice ? JSON.parse(Buffer.from(String(req.query.invoice), "base64").toString("utf8")) : null;
      if (presented?.invoice && presented?.signature && presented?.attest) {
        const momoKp = kpFor(M);
        const id = bindInvoice(presented.invoice, presented.signature, (payload, sig) => momoKp.verify(payload, sig));
        if (!id) bound = { ok: false, reason: "presented invoice is not signed by Momo" };
        else {
          const payerKp = Keypair.fromPublicKey(ev.from);
          const attestOk = payerKp.verify(hash(Buffer.from(JSON.stringify({ invoiceId: id, tx }))), Buffer.from(presented.attest, "base64"));
          if (!attestOk) bound = { ok: false, reason: "payer attestation over {invoiceId, tx} does not verify against the on-chain payer" };
          else { const r = checkRedeem(id, ev.from, paidXlm, tx); bound = { ...r, invoiceId: id }; }
        }
      }
    } catch (e: any) { bound = { ok: false, reason: "binding parse error: " + String(e?.message ?? e) }; }
    if (!bound.ok) {
      res.status(402).json({ paid: true, delivered: false, decryptedXlm: paidXlm, binding: bound,
        error: `payment received (${paidXlm} XLM, decrypted) but it is not bound to a valid invoice: ${bound.reason}. Get an invoice from /api/momo/quote, pay, then present {invoice, signature, attest: sign(sha256({invoiceId, tx}))}. Funds refundable.` });
      return;
    }

    // ── policy at the till: Momo's own terms, applied to the decrypted payment ──
    const customerLedgers = (inbound as any[]).filter((e) => e.from === ev.from).map((e) => e.ledger as number);
    const verdict = decide({ from: ev.from, paidXlm, ledger: ev.ledger, customerLedgers }, M);
    if (!verdict.allow) {
      res.status(403).json({ paid: true, delivered: false, decryptedXlm: paidXlm, policy: verdict,
        error: `payment received (${paidXlm} XLM, decrypted) but Momo's policy declined delivery: ${verdict.rule}: ${verdict.reason}. Funds are refundable, not seized.` });
      return;
    }
    const brief = {
      title: "Stellar Settlement-Currency Brief", asOf: new Date().toISOString(),
      buyer: ev.from, paidVia: { tx, ledger: ev.ledger, settlement: "confidential; Momo decrypted the amount with its own key, the chain never saw it" },
      facts: [
        "Momo verified this exact payment by decrypting the transfer's ciphertext, not by trusting the buyer or a webhook.",
        "Amounts in OpenZeppelin Confidential Tokens live on-chain as commitments; only counterparties and the registered auditor can read them.",
        "Reproduce: https://github.com/Stellar-Light/confidential-agent-commerce",
      ],
    };
    const signed = signGoods(brief, M);
    await appendLedger({ at: new Date().toISOString(), tx, ledger: ev.ledger, from: ev.from, name, xlm: paidXlm });
    res.status(200).json({ paid: true, delivered: true, decryptedXlm: paidXlm, policy: verdict, binding: { ok: true, invoiceId: bound.invoiceId }, brief, ...signed });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
}
