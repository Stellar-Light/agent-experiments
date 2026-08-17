/**
 * Client for `stellar`/`confidential-charge`: parse the MPP challenge, pay it
 * with a confidential_transfer for the challenged amount, and return the
 * signedHash credential. Node (proving via the SDK's node entry).
 */
import { Challenge, Credential } from "mppx";
import { Address, xdr } from "@stellar/stellar-sdk";
import { proveTransfer } from "stellar-confidential-token-sdk/node";

/** Parse a 402 Response's WWW-Authenticate: Payment header with mppx's own parser (exact round-trip for the HMAC check). */
export function parseChallenge(res) {
  return Challenge.fromHeaders(res.headers);
}

/** Pay a confidential-charge challenge and produce the credential header value. */
export async function payChallenge({ challenge, client, contracts, me, keys, spendable, signer, auditorId = 0 }) {
  const amount = BigInt(challenge.request.amount);
  const to = challenge.request.recipient;
  const kAud = await client.auditorKey(auditorId);
  const recipient = await client.confidentialBalance(to);
  const t = await proveTransfer({ keys, v: spendable.v, r: spendable.r, amount, pvkB: recipient.viewingPublicKey, kAudR: kAud, kAudS: kAud });
  const pay = await client.invoke(contracts.token, "confidential_transfer",
    [new Address(me.address).toScVal(), new Address(to).toScVal(), xdr.ScVal.scvBytes(Buffer.from(t.payload))], signer);
  const hash = pay.hash.toLowerCase();
  const sourceSignature = Buffer.from(me.kp.sign(Buffer.from(`${challenge.id}:${hash}`))).toString("hex");
  const credential = Credential.from({ challenge, payload: { type: "signedHash", hash, sourceSignature }, source: me.address });
  return { hash, header: Credential.serialize(credential), next: t.next };
}
