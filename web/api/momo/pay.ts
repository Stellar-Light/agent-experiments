/**
 * GET /api/momo/pay?tx=<hash>&agreed=<xlm>&name=<agent name>
 * Momo checks the till: finds THIS transfer in its own replayed events,
 * decrypts its amount with its own viewing key, and compares it with what
 * was agreed. Only then does it deliver, signed. The buyer's word is never
 * taken for anything; the buyer's amount is never public.
 */
import { momoBooks, signGoods, MOMO, STROOP } from "../../lib/momo.js";
import { appendLedger } from "../../lib/ledger.js";
import { decide } from "../../lib/policy.js";

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const tx = String(req.query?.tx ?? "").toLowerCase();
  const agreed = Number(req.query?.agreed ?? NaN);
  const name = String(req.query?.name ?? "agent").slice(0, 24);
  if (!/^[0-9a-f]{64}$/.test(tx)) { res.status(400).json({ error: "tx hash required" }); return; }
  try {
    const { inbound, engine } = await momoBooks();
    const ev: any = inbound.find((e: any) => String(e.txHash).toLowerCase() === tx);
    if (!ev) { res.status(402).json({ paid: false, error: "no confidential transfer to Momo found in that transaction (yet); retry in a few seconds" }); return; }
    const paidXlm = typeof ev.amount === "number" ? ev.amount : Number(engine.decryptIncoming(ev.rE, ev.vTilde, ev.sigma).vTx) / 1e7;
    if (Number.isFinite(agreed) && Math.abs(paidXlm - agreed) > 1e-7) {
      res.status(402).json({ paid: true, delivered: false, decryptedXlm: paidXlm, error: `you paid ${paidXlm} XLM but we agreed ${agreed}` });
      return;
    }
    // ── policy at the till: Momo's own terms, applied to the decrypted payment ──
    const customerLedgers = (inbound as any[]).filter((e) => e.from === ev.from).map((e) => e.ledger as number);
    const verdict = decide({ from: ev.from, paidXlm, ledger: ev.ledger, customerLedgers });
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
    const signed = signGoods(brief);
    await appendLedger({ at: new Date().toISOString(), tx, ledger: ev.ledger, from: ev.from, name, xlm: paidXlm });
    res.status(200).json({ paid: true, delivered: true, decryptedXlm: paidXlm, policy: verdict, brief, ...signed });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
}
