/**
 * Momo's policy at the till.
 *
 * A merchant is not a vending machine. When a payment arrives, Momo applies
 * its own rules BEFORE it delivers, at the money layer, with the payment
 * already decrypted. Every decision carries a machine-readable reason so a
 * buyer (or an examiner) can see exactly which term applied.
 *
 *  1. minimum ticket        never deliver for less than a floor amount
 *  2. per-customer velocity  cap payments per customer per window
 *  3. blocklist              refuse named counterparties (with a reason)
 *  4. terms attestation      Momo signs its current terms; a buyer can
 *                            fetch them before paying and hold Momo to them
 *
 * Money that fails policy is NOT lost: it sits in Momo's confidential
 * balance and Momo can refund it with a confidential_transfer back. Delivery
 * is what policy withholds, never funds. Testnet.
 */
import { signGoods, MOMO, STROOP } from "./momo.js";

export type Terms = {
  version: string; minTicketXlm: number; maxPaymentsPerCustomerPerHour: number;
  blocklist: { address: string; reason: string }[];
  auditorId: number; examinable: string; refunds: string;
};

export const TERMS: Terms = {
  version: "2026-08-17.1",
  minTicketXlm: 0.5,
  maxPaymentsPerCustomerPerHour: 6,
  blocklist: [
    // testnet demonstration entry: a documented, permanently-declined counterparty
    { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWQ", reason: "demonstration: declined counterparty" },
  ],
  auditorId: 0,
  examinable: "Momo is registered under auditor #0 on the OpenZeppelin confidential contract; every transfer to Momo carries a ciphertext that auditor can decrypt, by protocol.",
  refunds: "a payment that fails policy stays in Momo's confidential balance and is refundable by confidential_transfer; delivery is withheld, funds are not seized",
};

export const POLICY_LIVE_LEDGER = 4182200; // terms v2026-08-17.1 took effect here; earlier payments were delivered under no-policy terms

export type PolicyDecision = { allow: boolean; rule?: string; reason?: string; terms: string };

/** Signed, fetchable terms so a buyer can bind Momo to them before paying. */
export function signedTerms() {
  const body = { seller: MOMO, terms: TERMS, issuedAt: new Date().toISOString() };
  return { ...body, ...signGoods(body) };
}

/** Apply policy to a decrypted, located payment. `history` = this customer's inbound ledgers. */
export function decide(input: { from: string; paidXlm: number; ledger: number; customerLedgers: number[] }): PolicyDecision {
  const t = TERMS.version;
  if (input.ledger < POLICY_LIVE_LEDGER) return { allow: true, terms: "pre-policy" };
  const blocked = TERMS.blocklist.find((b) => b.address === input.from);
  if (blocked) return { allow: false, rule: "blocklist", reason: blocked.reason, terms: t };
  if (input.paidXlm < TERMS.minTicketXlm) return { allow: false, rule: "min-ticket", reason: `paid ${input.paidXlm} XLM, minimum is ${TERMS.minTicketXlm} XLM`, terms: t };
  const windowLedgers = 720; // ~1 hour
  // prior payments only: strictly earlier ledgers within the window. The payment being judged never counts against itself.
  const prior = input.customerLedgers.filter((l) => l < input.ledger && input.ledger - l < windowLedgers).length;
  if (prior >= TERMS.maxPaymentsPerCustomerPerHour) return { allow: false, rule: "velocity", reason: `${prior} prior payments from this customer in the last hour, limit ${TERMS.maxPaymentsPerCustomerPerHour}`, terms: t };
  return { allow: true, terms: t };
}
