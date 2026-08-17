/**
 * A real 402-gated API, paid with confidential settlement.
 *
 * GET /api/brief            -> 402 Payment Required + how to pay
 * GET /api/brief?tx=<hash>  -> verifies the hash is a recent, successful
 *   confidential_transfer to the seller on the OpenZeppelin contract
 *   (decoded from the envelope; the amount is encrypted and stays unknown
 *   to this server), then serves the product, Ed25519-signed by the seller.
 *
 * Honest scope: this server proves a confidential payment to the seller
 * happened just now; it cannot read the amount (that is the point). The
 * demo client additionally proves the amount by decryption with the
 * seller key. Production would bind an invoice nonce into the transfer.
 */
import { Buffer } from "node:buffer";
import { xdr, StrKey, Keypair, hash } from "@stellar/stellar-sdk";
import SESSION from "../src/session.json" with { type: "json" };

const RPC = "https://soroban-testnet.stellar.org";
const MAX_AGE_SECONDS = 600;

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const tx = String(req.query?.tx ?? "");
  if (!/^[0-9a-f]{64}$/.test(tx)) {
    res.status(402).json({
      error: "payment required",
      scheme: "stellar-confidential-transfer",
      network: "stellar:testnet",
      payTo: SESSION.momo.address,
      contract: SESSION.contracts.token,
      how: "send a confidential_transfer to payTo on the contract, then retry with ?tx=<hash>",
      note: "the amount you pay is encrypted on-chain; this server verifies the payment exists, not its size",
    });
    return;
  }
  try {
    const r = await fetch(RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash: tx } }),
    }).then((x) => x.json());
    const t = r.result;
    if (!t || t.status !== "SUCCESS") { res.status(402).json({ error: "payment not found or not successful" }); return; }
    if (t.createdAt && Date.now() / 1000 - Number(t.createdAt) > MAX_AGE_SECONDS) {
      res.status(402).json({ error: "payment too old; pay again and retry promptly" }); return;
    }
    const env = xdr.TransactionEnvelope.fromXDR(t.envelopeXdr, "base64");
    const ops = env.v1().tx().operations();
    const ok = ops.some((op: any) => {
      const b = op.body();
      if (b.switch().name !== "invokeHostFunction") return false;
      const inv = b.invokeHostFunctionOp().hostFunction().invokeContract();
      const contract = StrKey.encodeContract(inv.contractAddress().contractId());
      const fn = inv.functionName().toString();
      const args = inv.args();
      const to = args[1]?.switch().name === "scvAddress"
        ? StrKey.encodeEd25519PublicKey(args[1].address().accountId().ed25519()) : "";
      return contract === SESSION.contracts.token && fn === "confidential_transfer" && to === SESSION.momo.address;
    });
    if (!ok) { res.status(402).json({ error: "transaction is not a confidential transfer to the seller" }); return; }

    const body = {
      title: "Stellar Settlement-Currency Brief",
      asOf: new Date().toISOString(),
      paidVia: { tx, settlement: "confidential; amount not visible to this server" },
      facts: [
        "Amounts in OpenZeppelin Confidential Tokens live on-chain as commitments; only the counterparties and the registered auditor can decrypt them.",
        "This response was released by an HTTP 402 gate that verified your payment from the transaction envelope alone.",
        "Reproduce everything: https://github.com/Stellar-Light/confidential-agent-commerce",
      ],
    };
    const payload = Buffer.from(JSON.stringify(body));
    const kp = Keypair.fromSecret(SESSION.momo.secret);
    res.status(200).json({
      paid: true, brief: body,
      sha256: hash(payload).toString("hex"),
      signature: kp.sign(hash(payload)).toString("base64"),
      signer: SESSION.momo.address,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}
