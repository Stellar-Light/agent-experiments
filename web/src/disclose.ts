/**
 * Selective disclosure, as an agent action.
 *
 * After Pip pays, an EXAMINER (fresh keys, holds no wallet secrets, could be
 * an accountant / regulator / counterparty) issues a disclosure request. Pip
 * proves the exact amount of THAT ONE transfer to the examiner with a
 * zero-knowledge proof bound to the examiner's key and nonce. The examiner
 * verifies it against the chain's own event fields with OpenZeppelin's
 * pinned circuit verification key. Nobody learns Pip's balance, its other
 * payments, or anything about Momo's side.
 *
 * Contract-level: the auditor can always read. This is the OTHER lane:
 * proving to a party who was never given a key, on demand, one payment.
 */
import { Buffer } from "buffer";

export type Disclosure = {
  examinerPubkey: string; nonce: string; bundle: any; amountXlm: number; ok: boolean; steps: string[]; proveSecs: string; verifySecs: string;
};

export async function discloseToExaminer(opts: {
  core: any; client: any; circuit: any; vkBase64: string;
  role: "sender" | "recipient"; keys: any; rEScalar?: bigint; pvkB?: any;
  event: any; addrF: bigint; disclosingAccount: string;
}): Promise<Disclosure> {
  const { generateRecipientKeys, newDisclosureRequest, proveDisclosure, verifyDisclosure, proverFromArtifact } = opts.core;
  // 1. examiner appears with fresh keys and a one-time request (nonce binds the proof to this request)
  const examiner = generateRecipientKeys();
  const request = newDisclosureRequest(examiner);
  // 2. discloser proves the amount of this exact transfer to that examiner
  const t0 = performance.now();
  const bundle = opts.role === "sender"
    ? await proveDisclosure({ role: "sender", keys: opts.keys, rEScalar: opts.rEScalar!, event: opts.event, pvkB: opts.pvkB, request, prover: proverFromArtifact(opts.circuit) })
    : await proveDisclosure({ role: "recipient", keys: opts.keys, event: opts.event, request, prover: proverFromArtifact(opts.circuit) });
  const proveSecs = ((performance.now() - t0) / 1000).toFixed(1);
  // 3. examiner verifies with NO wallet keys: chain event fields + pinned circuit vk + its own request keys
  const t1 = performance.now();
  const onchain = await opts.client.confidentialBalance(opts.disclosingAccount);
  const pinnedVk = new Uint8Array(Buffer.from(opts.vkBase64, "base64"));
  const ctx: any = {
    addrF: opts.addrF, rE: opts.event.rE, sigma: opts.event.sigma, vTilde: opts.event.vTilde,
    pvkA: onchain.viewingPublicKey, pinnedVk, disclosingAccount: opts.disclosingAccount,
    request, keys: examiner, prover: proverFromArtifact(opts.circuit),
  };
  if (opts.role === "sender") ctx.pvkB = opts.pvkB;
  const verified = await verifyDisclosure(bundle, ctx);
  const verifySecs = ((performance.now() - t1) / 1000).toFixed(1);
  return {
    examinerPubkey: JSON.stringify(request.pR).slice(0, 24), nonce: String(request.nu).slice(0, 12), bundle,
    amountXlm: Number(verified.amount) / 1e7, ok: verified.ok === true, steps: verified.steps ?? [], proveSecs, verifySecs,
  };
}
