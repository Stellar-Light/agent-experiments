/**
 * Invoices: Momo's binding between a negotiated price and one payment.
 *
 * At agreement, Momo issues a signed invoice { buyer, priceXlm, nonce,
 * expiresAt }. invoiceId = sha256(canonical json). The buyer puts
 * MEMO_HASH(invoiceId) on the payment transaction. At the till, Momo:
 *   1. reads the memo from the envelope it already verifies,
 *   2. checks it names an invoice Momo issued, for this buyer, unexpired,
 *   3. checks the decrypted amount == the invoice price,
 *   4. checks the invoice is unspent, then marks it spent.
 * A payment can therefore redeem exactly one invoice, once. Replaying the
 * same tx hash against another request fails at step 4; paying with a
 * memo-less transfer fails at step 1 (unless the buyer explicitly asks for
 * the legacy unbound flow, which is delivered but flagged unbound).
 *
 * Invoice state lives in the merchant's memory per instance; the durable
 * anti-replay is the CHAIN: a tx hash is unique and Momo records redeemed
 * invoiceIds. Testnet.
 */
import { Buffer } from "node:buffer";
import { hash } from "@stellar/stellar-sdk";
import { signGoods, MOMO, MERCHANTS } from "./momo.js";
import type { MerchantProfile } from "./merchants.js";

export type Invoice = { buyer: string; priceXlm: number; nonce: string; expiresAt: number; seller: string };
const issued = new Map<string, Invoice>();     // invoiceId -> invoice
const redeemed = new Map<string, string>();    // invoiceId -> tx that redeemed it

export function canonical(inv: Invoice) { return JSON.stringify({ buyer: inv.buyer, priceXlm: inv.priceXlm, nonce: inv.nonce, expiresAt: inv.expiresAt, seller: inv.seller }); }
export function invoiceId(inv: Invoice) { return hash(Buffer.from(canonical(inv))).toString("hex"); }

export function issueInvoice(buyer: string, priceXlm: number, M: MerchantProfile = MERCHANTS.momo) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  const inv: Invoice = { buyer, priceXlm, nonce, expiresAt: Date.now() + 10 * 60_000, seller: M.address };
  const id = invoiceId(inv);
  issued.set(id, inv);
  const signed = signGoods({ invoiceId: id, ...inv }, M);
  return { invoiceId: id, invoice: inv, ...signed };
}

/** Recreate an invoice from what a buyer presents (so a fresh function instance can still verify Momo's own signature-bound invoice). */
export function bindInvoice(inv: Invoice, signature: string, verify: (payload: Buffer, sig: Buffer) => boolean) {
  const id = invoiceId(inv);
  const ok = verify(hash(Buffer.from(JSON.stringify({ invoiceId: id, ...inv }))), Buffer.from(signature, "base64"));
  if (!ok) return null;
  if (!issued.has(id)) issued.set(id, inv);
  return id;
}

export function checkRedeem(id: string, buyer: string, paidXlm: number, tx: string) {
  const inv = issued.get(id);
  if (!inv) return { ok: false, reason: "memo names no invoice Momo issued (or this instance never saw it; present the signed invoice)" };
  if (inv.buyer !== buyer) return { ok: false, reason: "invoice was issued to a different buyer" };
  if (Date.now() > inv.expiresAt) return { ok: false, reason: "invoice expired" };
  if (Math.abs(inv.priceXlm - paidXlm) > 1e-7) return { ok: false, reason: `invoice is for ${inv.priceXlm} XLM, payment decrypted as ${paidXlm} XLM` };
  const prior = redeemed.get(id);
  if (prior && prior !== tx) return { ok: false, reason: `invoice already redeemed by tx ${prior.slice(0, 12)}…` };
  redeemed.set(id, tx);
  return { ok: true };
}
