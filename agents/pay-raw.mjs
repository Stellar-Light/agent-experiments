// pay Momo an arbitrary amount directly (bypassing negotiation) to test policy at the till
import { readFileSync } from "node:fs";
import { Keypair, Networks, Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { deriveSk, deriveKeys, skSigningMessage, addressToField, StateEngine } from "stellar-confidential-token-sdk";
import { proveTransfer } from "stellar-confidential-token-sdk/node";
import { ChainClient, keypairSigner, hybridFetchEvents } from "stellar-confidential-token-sdk/chain";
const me = JSON.parse(readFileSync("./my-agent.json","utf8"));
const S = { token: "CBFOJTALVTO3LPZZHEXDD44K7RQKQJGAASF6XOKP5FWZD6WYKV4WN7HF", verifier: "CBXEPTSEC3433EH3TKUZSSZCIWIDMGZDY2FB7BN5IJ76A2JISQF4YTN6", auditor: "CDCPR4AURWJQRY4KXSRU7H7ABKIHTDORSQABIOUH37DU3IGYV5LRCHEK" };
const MERCHANT = "GCVDNTJA23S7DZNIWEWQLWMXBA5KA5Y6SWKMOHSMN2FIQKHHSRKV5BV5";
const AMOUNT = BigInt(Math.round(parseFloat(process.argv[2] ?? "0.3") * 1e7));
const kp = Keypair.fromSecret(me.secret), signer = keypairSigner(kp.secret(), Networks.TESTNET);
const client = new ChainClient({ rpcUrl: "https://soroban-testnet.stellar.org", networkPassphrase: Networks.TESTNET, contracts: S });
const root = new Uint8Array(kp.signMessage(Buffer.from(skSigningMessage(S.token, me.address))));
const { sk, addrF } = deriveSk(root, S.token, me.address); const keys = deriveKeys(sk, addrF, addressToField(me.address));
const { events } = await hybridFetchEvents(client, undefined, { fromLedger: me.bornLedger ?? ((await fetch("https://soroban-testnet.stellar.org",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getHealth"})}).then(r=>r.json())).result.oldestLedger) });
const eng = new StateEngine({ address: me.address, keys }); eng.ingestEvents(events.filter(e => e.type==="register"||e.type==="merge" ? e.account===me.address : e.from===me.address||e.to===me.address));
const sp = eng.state().spendable;
const kAud = await client.auditorKey(0);
const t = await proveTransfer({ keys, v: sp.v, r: sp.r, amount: AMOUNT, pvkB: (await client.confidentialBalance(MERCHANT)).viewingPublicKey, kAudR: kAud, kAudS: kAud });
const pay = await client.invoke(S.token, "confidential_transfer", [new Address(me.address).toScVal(), new Address(MERCHANT).toScVal(), xdr.ScVal.scvBytes(Buffer.from(t.payload))], signer);
console.log("paid", Number(AMOUNT)/1e7, "XLM, tx", pay.hash);
let r; for (let i=0;i<8;i++){ r = await fetch(`https://confidential-agent-commerce.vercel.app/api/momo/pay?tx=${pay.hash}&agreed=${Number(AMOUNT)/1e7}&name=${me.name}`).then(x=>x.json()); if (r.paid) break; await new Promise(z=>setTimeout(z,2500)); }
console.log(JSON.stringify({ paid: r.paid, delivered: r.delivered, decryptedXlm: r.decryptedXlm, policy: r.policy, error: r.error }, null, 1));
