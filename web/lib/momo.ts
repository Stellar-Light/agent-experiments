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

export const RPC = "https://soroban-testnet.stellar.org";
export const PASSPHRASE = "Test SDF Network ; September 2015";
export const STROOP = 10_000_000n;
export const MOMO = SESSION.momo.address;

const kp = Keypair.fromSecret(SESSION.momo.secret);
const client = new ChainClient({ rpcUrl: RPC, networkPassphrase: PASSPHRASE, contracts: SESSION.contracts });
let keysCache: any = null;
function keys() {
  if (keysCache) return keysCache;
  const root = new Uint8Array(kp.signMessage(Buffer.from(skSigningMessage(SESSION.contracts.token, MOMO))));
  const { sk, addrF } = deriveSk(root, SESSION.contracts.token, MOMO);
  keysCache = deriveKeys(sk, addrF, addressToField(MOMO));
  return keysCache;
}

export type Transfer = { id: string; ledger: number; from: string; to: string; tx?: string };

import { loadCheckpoint } from "./checkpoint.js";

/**
 * Momo's own bookkeeping: resume from the latest checkpoint if one exists,
 * then replay only the public events since it, and decrypt what it received.
 * Falls back to genesis replay when no checkpoint is available.
 */
export async function momoBooks() {
  const cp = await loadCheckpoint(MOMO);
  const from = cp ? Math.max(SESSION.fromLedger, cp.savedAtLedger - 50) : SESSION.fromLedger;
  const { events } = await hybridFetchEvents(client, undefined, { fromLedger: from });
  const mine = events.filter((ev: any) =>
    ev.type === "register" || ev.type === "merge" ? ev.account === MOMO : ev.from === MOMO || ev.to === MOMO);
  const eng = new StateEngine({ address: MOMO, keys: keys(), store: cp ? { load: async () => cp.state, save: async () => {} } : undefined });
  if (cp) await eng.load();
  // only ingest events strictly after the checkpoint (avoid double-counting the overlap window)
  const fresh = cp ? mine.filter((e: any) => e.ledger > cp.state.lastLedger) : mine;
  eng.ingestEvents(fresh);
  const receivedTotal = BigInt(eng.receiving().v);
  // inbound list = checkpoint's remembered inbound + fresh inbound (for the ledger/feed)
  const inboundFresh = fresh.filter((e: any) => e.type === "transfer" && e.to === MOMO) as any[];
  const inbound = [...(cp?.inbound ?? []), ...inboundFresh];
  return { receivedTotal, inbound, engine: eng, events: mine, checkpoint: cp ? { savedAt: cp.savedAt, savedAtLedger: cp.savedAtLedger } : null, replayFrom: from };
}

/**
 * Pricing policy. Momo is a small business, not a vending machine:
 * a floor it never goes under, a list price it opens with, and a demand
 * signal from its own decrypted history (busier hour, firmer price).
 * The floor is private. The quote is what it says out loud.
 */
export function policyQuote(inboundCount: number, recentCount: number) {
  const floor = 2n * STROOP;                       // private
  const list = 5n * STROOP;                        // opening ask
  const demand = recentCount >= 5 ? 2n : recentCount >= 2 ? 1n : 0n;
  const quote = list + demand * STROOP;
  return { quote, floor, list, demand: Number(demand), rationale:
    recentCount >= 5 ? "busy hour, holding firm" : recentCount >= 2 ? "steady demand" : "quiet, open to offers" };
}

/** Would Momo accept this counter-offer? Never reveals the floor. */
export function considerOffer(offer: bigint, floor: bigint) {
  if (offer >= floor) return { accept: true, note: "deal" };
  return { accept: false, note: "can't do that; try closer to my quote" };
}

/** Sign goods as Momo. */
export function signGoods(body: object) {
  const payload = Buffer.from(JSON.stringify(body));
  return { sha256: hash(payload).toString("hex"), signature: kp.sign(hash(payload)).toString("base64"), signer: MOMO };
}

export { client, SESSION };
