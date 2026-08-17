/**
 * Refresh Momo's checkpoint. Run on a schedule (GitHub Action, every 12h).
 * Resumes from the previous checkpoint if present, replays new events, and
 * writes public/checkpoint.json with { spendable, receiving, lastLedger,
 * inbound[] (compact: txHash, ledger, from, amount decrypted) }.
 *
 * Node-side: no proving, only decryption + replay (~1s).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { StateEngine, deriveSk, deriveKeys, skSigningMessage, addressToField, reviveState, bigintReplacer } from "stellar-confidential-token-sdk";
import { ChainClient, hybridFetchEvents } from "stellar-confidential-token-sdk/chain";

const S = JSON.parse(readFileSync("src/session.json", "utf8"));
const RPC = "https://soroban-testnet.stellar.org";
const AGENTS = [["momo", S.momo], ["pip", S.pip]];
const outAll = {};
const prevPath = "public/checkpoint.json";
const prevAll = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, "utf8")) : null;
for (const [name, A] of AGENTS) {
const MOMO = A.address;
const kp = Keypair.fromSecret(A.secret);
const client = new ChainClient({ rpcUrl: RPC, networkPassphrase: "Test SDF Network ; September 2015", contracts: S.contracts });
const root = new Uint8Array(kp.signMessage(Buffer.from(skSigningMessage(S.contracts.token, MOMO))));
const { sk, addrF } = deriveSk(root, S.contracts.token, MOMO);
const keys = deriveKeys(sk, addrF, addressToField(MOMO));

const prev = prevAll?.agents?.[name] ?? (prevAll?.address === MOMO ? prevAll : null);
const prevState = prev?.state ? reviveState(prev.state) : null;
const from = prevState ? Math.max(S.fromLedger, prev.savedAtLedger - 50) : S.fromLedger;

const { events } = await hybridFetchEvents(client, undefined, { fromLedger: from });
const mine = events.filter((ev) => ev.type === "register" || ev.type === "merge" ? ev.account === MOMO : ev.from === MOMO || ev.to === MOMO);
const eng = new StateEngine({ address: MOMO, keys, store: prevState ? { load: async () => prevState, save: async () => {} } : undefined });
if (prevState) await eng.load();
const fresh = prevState ? mine.filter((e) => e.ledger > prevState.lastLedger) : mine;
eng.ingestEvents(fresh);

const inboundPrev = prev?.state?.inbound ?? [];
const inboundFresh = fresh.filter((e) => e.type === "transfer" && e.to === MOMO).map((e) => {
  let amount = null;
  try { amount = Number(eng.decryptIncoming(e.rE, e.vTilde, e.sigma).vTx) / 1e7; } catch {}
  return { txHash: e.txHash, ledger: e.ledger, from: e.from, amount, rE: e.rE, vTilde: e.vTilde, sigma: e.sigma };
});
const st = eng.state();
const latest = (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }) }).then((r) => r.json())).result.sequence;
const out = {
  address: MOMO,
  state: { spendable: st.spendable, receiving: st.receiving, lastLedger: Math.max(st.lastLedger, latest), inbound: [...inboundPrev, ...inboundFresh] },
  savedAt: new Date().toISOString(),
  savedAtLedger: latest,
};
outAll[name] = out;
console.log(JSON.stringify({ agent: name, replayedFrom: from, freshEvents: fresh.length, inboundTotal: out.state.inbound.length, receivingXlm: Number(st.receiving.v) / 1e7, spendableXlm: Number(st.spendable.v) / 1e7, savedAtLedger: latest }));
}
writeFileSync(prevPath, JSON.stringify({ agents: outAll, savedAt: new Date().toISOString() }, bigintReplacer, 2));
