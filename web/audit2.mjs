import { xdr } from "@stellar/stellar-sdk";
const RPC = "https://soroban-testnet.stellar.org";
const t = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash: "438701a217bdfee457f671614c9972cc0ee1e374ba2b0a518c457c37ab75c62a" } }) }).then(r=>r.json()).then(j=>j.result);
const raw = Buffer.from(t.envelopeXdr, "base64");
const env = xdr.TransactionEnvelope.fromXDR(t.envelopeXdr, "base64");
const tx = env.v1().tx();
const sd = tx.ext().sorobanData();
const res = sd.resources();
console.log("tx.fee (declared):", tx.fee());
console.log("sorobanData.resourceFee:", sd.resourceFee().toString());
console.log("resources.instructions:", res.instructions());
console.log("resources.readBytes:", res.diskReadBytes ? res.diskReadBytes() : res.readBytes?.());
// find offsets of the LE and BE 8-byte patterns for 50,000,000
for (const [name, buf] of [["LE", (()=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(50000000n);return b})()], ["BE", (()=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(50000000n);return b})()]]) {
  let i = -1, hits = [];
  while ((i = raw.indexOf(buf, i + 1)) !== -1) hits.push(i);
  console.log(`${name} pattern offsets:`, hits, "of", raw.length, "bytes");
}
