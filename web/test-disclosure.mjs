// Pin the disclosure round-trip API + event field names (node-side rehearsal).
import { readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import {
  deriveSk, deriveKeys, skSigningMessage, addressToField,
  generateRecipientKeys, newDisclosureRequest, proveDisclosure, verifyDisclosure,
  proverFromArtifact, pointFromJson,
} from "stellar-confidential-token-sdk";
import { ChainClient, hybridFetchEvents } from "stellar-confidential-token-sdk/chain";

const S = JSON.parse(readFileSync("src/session.json", "utf8"));
const client = new ChainClient({ rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015", contracts: S.contracts });
const kp = Keypair.fromSecret(S.momo.secret);
const message = skSigningMessage(S.contracts.token, kp.publicKey());
const root = new Uint8Array(kp.signMessage(Buffer.from(message)));
const { sk, addrF } = deriveSk(root, S.contracts.token, kp.publicKey());
const keys = deriveKeys(sk, addrF, addressToField(kp.publicKey()));

const { events } = await hybridFetchEvents(client, undefined, { fromLedger: S.fromLedger });
const transfers = events.filter(e => e.type === "transfer" && e.to === S.momo.address);
const ev = transfers.at(-1);
console.log("last transfer event keys:", Object.keys(ev).join(", "));

const examiner = generateRecipientKeys();
const request = newDisclosureRequest(examiner);
const circuit = JSON.parse(readFileSync("public/circuits/disclose_recipient.json", "utf8"));
const prover = proverFromArtifact(circuit);
const t0 = Date.now();
const bundle = await proveDisclosure({ role: "recipient", keys, event: ev, request, prover });
console.log("proved in", ((Date.now()-t0)/1000).toFixed(1) + "s; bundle keys:", Object.keys(bundle).join(", "));

const vkJson = JSON.parse(readFileSync("public/circuits/disclose_recipient.vk.json", "utf8"));
const pinnedVk = new Uint8Array(Buffer.from(vkJson.vkBase64, "base64"));
const onchain = await client.confidentialBalance(S.momo.address);
console.log("confidentialBalance keys:", Object.keys(onchain).join(", "));
const ctx = {
  addrF: addressToField(S.contracts.token),
  rE: ev.rE ?? ev.re ?? ev.RE,
  sigma: ev.sigma,
  vTilde: ev.vTilde ?? ev.v_tilde,
  pvkA: onchain.pvk ?? keys.PVK,
  pinnedVk,
  disclosingAccount: S.momo.address,
  request, keys: examiner, prover: proverFromArtifact(circuit),
};
const verified = await verifyDisclosure(bundle, ctx);
console.log("VERIFIED:", verified.ok, "amount stroops:", verified.amount.toString(), "role:", verified.role);
console.log("steps:", JSON.stringify(verified.steps, null, 1).slice(0, 600));
