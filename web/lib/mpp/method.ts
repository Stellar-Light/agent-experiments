/**
 * MPP payment method: `stellar` / intent `confidential-charge`.
 *
 * A faithful sibling of the official `stellar`/`charge` method
 * (draft-stellar-charge-00), with one change: settlement is a
 * `confidential_transfer` on an OpenZeppelin Confidential Token instead of a
 * SEP-41 `transfer`, so the AMOUNT never appears on-chain. The server verifies
 * the payment by DECRYPTING it with the recipient's own key.
 *
 * Credential (push mode only, mirroring charge's `signedHash`):
 *   { type: "signedHash", hash, sourceSignature }
 *   sourceSignature = payer's Ed25519 signature over "{challenge.id}:{hash}",
 *   which binds this payer + this tx + this challenge (replay-safe: challenge
 *   ids are single-use and HMAC-bound by mppx; tx hashes are unique).
 *
 * Request: { amount (stroops, string), currency (confidential token contract),
 *            recipient (G...), description?, externalId? }
 */
import { Method } from "mppx";
import { z } from "zod/mini";

export const confidentialCharge = Method.from({
  name: "stellar",
  intent: "confidential-charge",
  schema: {
    credential: {
      payload: z.object({
        type: z.literal("signedHash"),
        hash: z.string().check(z.regex(/^[0-9a-f]{64}$/i)),
        sourceSignature: z.string().check(z.regex(/^[0-9a-f]{128}$/i)),
      }),
    },
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      recipient: z.string(),
      description: z.optional(z.string()),
      externalId: z.optional(z.string()),
      /** Advisory: the amount is encrypted on-chain; only recipient + auditor can read it. */
      settlement: z.optional(z.literal("confidential")),
    }),
  },
});
