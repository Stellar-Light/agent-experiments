/**
 * Momo, the merchant agent. Server-side. Its own key, its own policy, its
 * own view of the chain. Momo never learns a buyer's budget; buyers never
 * learn Momo's floor. Amounts are private on-chain; Momo verifies payments
 * by DECRYPTING its own receiving balance, not by trusting anyone.
 *
 * Testnet only. Momo's key is a published testnet key holding nothing.
 */
import { Buffer } from "node:buffer";
import { Keypair, hash } from "@stellar/stellar-sdk";
import {
  StateEngine, deriveSk, deriveKeys, skSigningMessage, addressToField, pointToBytes,
} from "stellar-confidential-token-sdk";
import { ChainClient, hybridFetchEvents } from "stellar-confidential-token-sdk/chain";
import SESSION from "../src/session.json" with { type: "json" };
import { MERCHANTS, merchantById, secretFor, type MerchantProfile } from "./merchants.js";

export const RPC = "https://soroban-testnet.stellar.org";
export const PASSPHRASE = "Test SDF Network ; September 2015";
export const STROOP = 10_000_000n;
export const MOMO = SESSION.momo.address;

const client = new ChainClient({ rpcUrl: RPC, networkPassphrase: PASSPHRASE, contracts: SESSION.contracts });
const keysCache = new Map<string, any>();
export function kpFor(m: MerchantProfile = MERCHANTS.momo) { return Keypair.fromSecret(secretFor(m)); }
function keys(m: MerchantProfile = MERCHANTS.momo) {
  if (keysCache.has(m.id)) return keysCache.get(m.id);
  const kp = kpFor(m);
  const root = new Uint8Array(kp.signMessage(Buffer.from(skSigningMessage(SESSION.contracts.token, m.address))));
  const { sk, addrF } = deriveSk(root, SESSION.contracts.token, m.address);
  const k = deriveKeys(sk, addrF, addressToField(m.address));
  keysCache.set(m.id, k);
  return k;
}
const kp = kpFor(MERCHANTS.momo);

export type Transfer = { id: string; ledger: number; from: string; to: string; tx?: string };

import { loadCheckpoint } from "./checkpoint.js";

/**
 * Momo's own bookkeeping: resume from the latest checkpoint if one exists,
 * then replay only the public events since it, and decrypt what it received.
 * Falls back to genesis replay when no checkpoint is available.
 */
export async function momoBooks(m: MerchantProfile = MERCHANTS.momo) {
  const ME = m.address;
  const cp = await loadCheckpoint(ME);
  const from = cp ? Math.max(SESSION.fromLedger, cp.savedAtLedger - 50) : SESSION.fromLedger;
  const { events } = await hybridFetchEvents(client, undefined, { fromLedger: from });
  const mine = events.filter((ev: any) =>
    ev.type === "register" || ev.type === "merge" ? ev.account === ME : ev.from === ME || ev.to === ME);
  const eng = new StateEngine({ address: ME, keys: keys(m), store: cp ? { load: async () => cp.state, save: async () => {} } : undefined });
  if (cp) await eng.load();
  // only ingest events strictly after the checkpoint (avoid double-counting the overlap window)
  const fresh = cp ? mine.filter((e: any) => e.ledger > cp.state.lastLedger) : mine;
  eng.ingestEvents(fresh);
  const receivedTotal = BigInt(eng.receiving().v);
  // inbound list = checkpoint's remembered inbound + fresh inbound (for the ledger/feed)
  const inboundFresh = fresh.filter((e: any) => e.type === "transfer" && e.to === ME) as any[];
  const inbound = [...(cp?.inbound ?? []), ...inboundFresh];
  return { receivedTotal, inbound, engine: eng, events: mine, checkpoint: cp ? { savedAt: cp.savedAt, savedAtLedger: cp.savedAtLedger } : null, replayFrom: from };
}

/**
 * Pricing policy. Momo is a small business, not a vending machine:
 * a floor it never goes under, a list price it opens with, and a demand
 * signal from its own decrypted history (busier hour, firmer price).
 * The floor is private. The quote is what it says out loud.
 */
/**
 * Continuous demand pricing: quote = list + 0.3 XLM per payment in the last hour
 * (capped), so the price actually moves with the books instead of sitting on
 * three plateaus. Floor stays private. A busy hour is visible in the quote.
 */
export function policyQuote(inboundCount: number, recentCount: number, profile = MOMO_PROFILE) {
  const floor = profile.floorXlm;                                       // private
  const surge = Math.min(recentCount * profile.surgePerPaymentXlm, profile.surgeCapXlm);
  const quoteXlm = +(profile.listXlm + surge).toFixed(2);
  const quote = BigInt(Math.round(quoteXlm * 1e7));
  const rationale = recentCount >= 5 ? `busy hour (${recentCount} payments), price up ${surge.toFixed(2)}`
    : recentCount >= 2 ? `steady demand (${recentCount} in the last hour), small premium` : "quiet, open to offers";
  return { quote, floor: BigInt(Math.round(floor * 1e7)), list: BigInt(Math.round(profile.listXlm * 1e7)), demand: recentCount, rationale };
}
/** Momo's merchant profile. Kiki (the second merchant) has a different one; see lib/merchants.ts. */
export const MOMO_PROFILE = { name: "Momo", listXlm: 5, floorXlm: 2, surgePerPaymentXlm: 0.3, surgeCapXlm: 3, product: "settlement-currency brief" };

/** Would Momo accept this counter-offer? Never reveals the floor. */
export function considerOffer(offer: bigint, floor: bigint) {
  if (offer >= floor) return { accept: true, note: "deal" };
  return { accept: false, note: "can't do that; try closer to my quote" };
}

/** Sign goods as Momo. */
export function signGoods(body: object, m: MerchantProfile = MERCHANTS.momo) {
  const payload = Buffer.from(JSON.stringify(body));
  const k = kpFor(m);
  return { sha256: hash(payload).toString("hex"), signature: k.sign(hash(payload)).toString("base64"), signer: m.address };
}

export { client, SESSION, MERCHANTS, merchantById };
