// mint + register a new merchant identity on the confidential contract; append to session.json under the given name
import { Keypair, Networks, Address, xdr } from "@stellar/stellar-sdk";
import { deriveSk, deriveKeys, skSigningMessage, addressToField } from "stellar-confidential-token-sdk";
import { proveRegister } from "stellar-confidential-token-sdk/node";
import { ChainClient, keypairSigner } from "stellar-confidential-token-sdk/chain";
import { readFileSync, writeFileSync } from "node:fs";
const name = process.argv[2] ?? "kiki";
const S = JSON.parse(readFileSync("src/session.json", "utf8"));
const kp = Keypair.random();
await fetch("https://friendbot.stellar.org?addr=" + kp.publicKey());
const client = new ChainClient({ rpcUrl: "https://soroban-testnet.stellar.org", networkPassphrase: Networks.TESTNET, contracts: S.contracts });
const root = new Uint8Array(kp.signMessage(Buffer.from(skSigningMessage(S.contracts.token, kp.publicKey()))));
const { sk, addrF } = deriveSk(root, S.contracts.token, kp.publicKey());
const keys = deriveKeys(sk, addrF, addressToField(kp.publicKey()));
const { payload } = await proveRegister(keys);
const r = await client.invoke(S.contracts.token, "register", [new Address(kp.publicKey()).toScVal(), xdr.ScVal.scvU32(0), xdr.ScVal.scvBytes(Buffer.from(payload))], keypairSigner(kp.secret(), Networks.TESTNET));
S[name] = { address: kp.publicKey(), secret: kp.secret() };
writeFileSync("src/session.json", JSON.stringify(S, null, 2));
console.log(JSON.stringify({ [name]: kp.publicKey(), registerTx: r.hash }));
