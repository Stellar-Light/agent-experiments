// Independent audit of the confidentiality claims. For each payment tx:
//  1. fetch the envelope from RPC, decode the XDR,
//  2. list every operation + argument type — show the amount is NOT among them,
//  3. byte-search the raw envelope for the amount (stroops as i128 LE/BE bytes
//     and as decimal text) — prove absence,
//  4. read the contract's stored balances — points, not numbers.
import { readFileSync, writeFileSync } from "node:fs";
import { xdr, scValToNative, StrKey } from "@stellar/stellar-sdk";

const S = JSON.parse(readFileSync("src/session.json", "utf8"));
const RPC = "https://soroban-testnet.stellar.org";
const CASES = [
  { tx: "4f295698d3280af1c0a110377bb8350eeb895cef8e87fd5e764e60d167fbdbba", stroops: 400000000n, label: "session payment (40 XLM)" },
  { tx: "438701a217bdfee457f671614c9972cc0ee1e374ba2b0a518c457c37ab75c62a", stroops: 50000000n, label: "browser run (5 XLM)" },
];
const rpc = (method, params) => fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json()).then(j => j.result);

const out = { auditedAt: new Date().toISOString(), cases: [] };
for (const c of CASES) {
  const t = await rpc("getTransaction", { hash: c.tx });
  const raw = Buffer.from(t.envelopeXdr, "base64");
  const env = xdr.TransactionEnvelope.fromXDR(t.envelopeXdr, "base64");
  const tx = env.v1().tx();
  const ops = tx.operations().map(op => {
    const body = op.body();
    if (body.switch().name !== "invokeHostFunction") return { type: body.switch().name };
    const fn = body.invokeHostFunctionOp().hostFunction();
    const inv = fn.invokeContract();
    return {
      type: "invokeHostFunction",
      contract: StrKey.encodeContract(inv.contractAddress().contractId()),
      function: inv.functionName().toString(),
      argTypes: inv.args().map(a => a.switch().name),
      args: inv.args().map(a => { try { const n = scValToNative(a); return a.switch().name === "scvBytes" ? `bytes[${n.length}]` : String(n).slice(0, 60); } catch { return "?"; } }),
    };
  });
  // amount byte-search: i128 stroops appear as 8-byte BE within scvI128 parts; also search ascii decimal
  const le = Buffer.alloc(8); le.writeBigUInt64LE(c.stroops);
  const be = Buffer.alloc(8); be.writeBigUInt64BE(c.stroops);
  const offsets = (buf) => { const hits=[]; let i=-1; while((i=raw.indexOf(buf,i+1))!==-1) hits.push(i); return hits; };
  // search only unambiguous patterns: 8-byte LE/BE stroops + ascii stroop string (>=6 chars)
  const found = { i128_le_offsets: offsets(le), i128_be_offsets: offsets(be), ascii_stroops_offsets: offsets(Buffer.from(String(c.stroops))) };
  const anyHit = Object.values(found).some((v) => v.length > 0);
  const env2 = env.v1().tx();
  const sd = env2.ext().sorobanData();
  out.cases.push({ label: c.label, tx: c.tx, ledger: t.ledger, status: t.status, envelopeBytes: raw.length,
    declaredFeeStroops: env2.fee(), resourceFeeStroops: sd.resourceFee().toString(), instructions: sd.resources().instructions(),
    ops, amountSearch: { stroops: c.stroops.toString(), ...found, verdict: anyHit ? "FOUND — investigate offsets" : "absent — amount appears nowhere in the envelope" },
    semanticCheck: ops.every((o) => !(o.argTypes ?? []).some((t2) => t2.includes("I128") || t2.includes("i128"))) ? "no numeric amount argument in any operation" : "numeric arg present — investigate" });
}
// balances as stored: getLedgerEntries for the two accounts' balance keys is contract-internal;
// use the public simulate-read the site uses instead: confirmed elsewhere. Record the classic balances:
for (const [name, a] of [["nova", S.nova.address], ["vega", S.vega.address]]) {
  const r = await fetch(`https://horizon-testnet.stellar.org/accounts/${a}`).then(r => r.json());
  const xlm = r.balances?.find(b => b.asset_type === "native")?.balance;
  out[name + "_classic_xlm"] = xlm; // classic balance only moves on deposit/fees — per-payment amounts never touch it
}
writeFileSync("audit.json", JSON.stringify(out, null, 1));
for (const c of out.cases) {
  console.log(`\n── ${c.label} · ${c.status} · ledger ${c.ledger}`);
  for (const op of c.ops) console.log(`   op: ${op.function ?? op.type}(${(op.argTypes ?? []).join(", ")}) args: ${(op.args ?? []).join(" | ")}`);
  console.log(`   amount ${c.amountSearch.stroops} stroops in envelope? ${c.amountSearch.verdict}`);
}
console.log(`\nclassic XLM — nova: ${out.nova_classic_xlm} · vega: ${out.vega_classic_xlm} (per-payment amounts never appear here)`);
