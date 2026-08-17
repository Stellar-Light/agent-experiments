/**
 * Server side of `stellar`/`confidential-charge`: build the Mppx instance for
 * a merchant and the verifier that decrypts the payment.
 */
import { Buffer } from "node:buffer";
import { Method } from "mppx";
import { Mppx } from "mppx/server";
import { Keypair, xdr, StrKey } from "@stellar/stellar-sdk";
import { confidentialCharge } from "./method.js";
import { momoBooks, RPC, SESSION } from "../momo.js";
import type { MerchantProfile } from "../merchants.js";

export function confidentialChargeServer(M: MerchantProfile) {
  return Method.toServer(confidentialCharge, {
    defaults: { currency: SESSION.contracts.token, recipient: M.address, settlement: "confidential" as const },
    async verify({ credential, request }) {
      const { hash, sourceSignature } = credential.payload;
      const tx = hash.toLowerCase();
      const expectedStroops = BigInt(request.amount);
      // 1. the tx exists, succeeded, and is a confidential_transfer to this merchant on the confidential token
      const tr = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash: tx } }) }).then((r) => r.json());
      const t = tr.result;
      if (!t || t.status !== "SUCCESS") throw new Error("payment tx not found or not successful");
      const env = xdr.TransactionEnvelope.fromXDR(t.envelopeXdr, "base64");
      const ops = env.v1().tx().operations();
      if (ops.length !== 1) throw new Error("expected a single operation");
      const b = ops[0].body();
      if (b.switch().name !== "invokeHostFunction") throw new Error("not a contract invocation");
      const inv = b.invokeHostFunctionOp().hostFunction().invokeContract();
      const contract = StrKey.encodeContract(inv.contractAddress().contractId());
      const fn = inv.functionName().toString();
      const args = inv.args();
      const from = StrKey.encodeEd25519PublicKey(args[0].address().accountId().ed25519());
      const to = StrKey.encodeEd25519PublicKey(args[1].address().accountId().ed25519());
      if (contract !== request.currency) throw new Error("wrong token contract");
      if (fn !== "confidential_transfer") throw new Error(`function must be confidential_transfer, got ${fn}`);
      if (to !== request.recipient) throw new Error("payment is not to this merchant");
      // 2. payer binding: sourceSignature over "{challenge.id}:{hash}" by the on-chain payer
      const msg = Buffer.from(`${credential.challenge.id}:${tx}`);
      const ok = Keypair.fromPublicKey(from).verify(msg, Buffer.from(sourceSignature, "hex"));
      if (!ok) throw new Error("sourceSignature does not verify against the on-chain payer");
      // 3. THE CONFIDENTIAL PART: decrypt the amount with the merchant's own key; the chain never showed it
      const { inbound, engine } = await momoBooks(M);
      const ev: any = inbound.find((e: any) => String(e.txHash).toLowerCase() === tx);
      if (!ev) throw new Error("payment not yet visible in the merchant's replayed events; retry shortly");
      const paidStroops = typeof ev.amount === "number" ? BigInt(Math.round(ev.amount * 1e7)) : BigInt(engine.decryptIncoming(ev.rE, ev.vTilde, ev.sigma).vTx);
      if (paidStroops < expectedStroops) throw new Error(`decrypted amount ${paidStroops} < required ${expectedStroops}`);
      return { method: "stellar", reference: tx, externalId: request.externalId, status: "success" as const, timestamp: new Date().toISOString() };
    },
  });
}

export function mppFor(M: MerchantProfile) {
  return Mppx.create({
    secretKey: process.env.MPP_SECRET_KEY ?? "confidential-agent-commerce-testnet-" + M.id,
    methods: [confidentialChargeServer(M)],
  });
}
