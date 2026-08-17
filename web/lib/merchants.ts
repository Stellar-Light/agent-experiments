/**
 * The market: merchants a buyer can shop between. Each is a real service with
 * its own key, its own price profile, and its own policy. Same till software,
 * different shops. Buyers query the registry, compare quotes and track
 * records, and choose.
 */
import SESSION from "../src/session.json" with { type: "json" };

export type MerchantProfile = { id: string; name: string; address: string; listXlm: number; floorXlm: number; surgePerPaymentXlm: number; surgeCapXlm: number; product: string; minTicketXlm: number; maxPaymentsPerCustomerPerHour: number };

export const MERCHANTS: Record<string, MerchantProfile> = {
  momo: { id: "momo", name: "Momo", address: SESSION.momo.address, listXlm: 5, floorXlm: 2, surgePerPaymentXlm: 0.3, surgeCapXlm: 3, product: "settlement-currency brief", minTicketXlm: 0.5, maxPaymentsPerCustomerPerHour: 6 },
  // Kiki: cheaper list, higher floor (less room to haggle), no surge, stricter velocity. A different business.
  kiki: { id: "kiki", name: "Kiki", address: (SESSION as any).kiki.address, listXlm: 4, floorXlm: 3.5, surgePerPaymentXlm: 0, surgeCapXlm: 0, product: "settlement-currency brief", minTicketXlm: 1, maxPaymentsPerCustomerPerHour: 3 },
};

export function merchantById(id: string | undefined): MerchantProfile {
  return MERCHANTS[String(id ?? "momo").toLowerCase()] ?? MERCHANTS.momo;
}
export function secretFor(m: MerchantProfile): string {
  return m.id === "kiki" ? (SESSION as any).kiki.secret : SESSION.momo.secret;
}
