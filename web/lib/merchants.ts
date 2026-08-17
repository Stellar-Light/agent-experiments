/**
 * The market: merchants a buyer can shop between. Each is a real service with
 * its own key, its own price profile, and its own policy. Same till software,
 * different shops. Buyers query the registry, compare quotes and track
 * records, and choose.
 */
import { Buffer } from "node:buffer";
import SESSION from "../src/session.json" with { type: "json" };

export type MerchantProfile = { id: string; name: string; address: string; listXlm: number; floorXlm: number; surgePerPaymentXlm: number; surgeCapXlm: number; product: string; minTicketXlm: number; maxPaymentsPerCustomerPerHour: number };

export const MERCHANTS: Record<string, MerchantProfile> = {
  momo: { id: "momo", name: "Momo", address: SESSION.momo.address, listXlm: 5, floorXlm: 2, surgePerPaymentXlm: 0.3, surgeCapXlm: 3, product: "settlement-currency brief", minTicketXlm: 0.5, maxPaymentsPerCustomerPerHour: 6 },
  // Kiki: cheaper list, higher floor (less room to haggle), no surge, stricter velocity. A different business.
  kiki: { id: "kiki", name: "Kiki", address: (SESSION as any).kiki.address, listXlm: 4, floorXlm: 3.5, surgePerPaymentXlm: 0, surgeCapXlm: 0, product: "settlement-currency brief", minTicketXlm: 1, maxPaymentsPerCustomerPerHour: 3 },
};

export function merchantById(id: string | undefined, cfg?: any): MerchantProfile {
  const base = MERCHANTS[String(id ?? "momo").toLowerCase()] ?? MERCHANTS.momo;
  return applyConfig(base, cfg);
}

/**
 * Visitor-configured behavior. The merchant's IDENTITY (key, address, on-chain
 * registration) is fixed; its BEHAVIOR (list price, private floor, surge,
 * surge cap) can be configured per session by the person running the
 * experiment, within bounds; its TERMS cannot (see below). The config travels with each request
 * (?cfg=<base64 json>) so the negotiation, the till, and the market board all
 * see the same shop the buyer is talking to. Bounds keep the shared testnet
 * balances sane.
 */
export function applyConfig(base: MerchantProfile, cfg: any): MerchantProfile {
  if (!cfg) return base;
  let c = cfg;
  if (typeof c === "string") { try { c = JSON.parse(Buffer.from(c, "base64").toString("utf8")); } catch { return base; } }
  const num = (v: any, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const out: MerchantProfile = {
    ...base,
    listXlm: num(c.listXlm, 0.1, 50, base.listXlm),
    floorXlm: num(c.floorXlm, 0.1, 50, base.floorXlm),
    surgePerPaymentXlm: num(c.surgePerPaymentXlm, 0, 5, base.surgePerPaymentXlm),
    surgeCapXlm: num(c.surgeCapXlm, 0, 20, base.surgeCapXlm),
    // TERMS (min ticket, velocity, blocklist) are deliberately NOT configurable: a verdict at the till must be a
    // pure function of chain facts + the merchant's signed terms, or the refund worker cannot re-derive it later
    // (it would either refund delivered goods under stricter terms or strand funds under looser ones).
    // Pricing is the shop's mood, yours to set. Terms are the shop's contract, fixed and signed.
  };
  if (out.floorXlm > out.listXlm) out.floorXlm = out.listXlm; // a floor above the list is not a shop
  return out;
}
export function secretFor(m: MerchantProfile): string {
  return m.id === "kiki" ? (SESSION as any).kiki.secret : SESSION.momo.secret;
}
