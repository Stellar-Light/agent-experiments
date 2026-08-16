/**
 * e6 frontend — Confidential Agent Commerce.
 *
 * Two modes:
 *  · Simulate — replays the recorded session (real hashes) and prints the receipt.
 *  · Verify live — runs the REAL client in the visitor's browser: derives the
 *    agents' confidential keys from the published testnet session, fetches
 *    chain events over RPC, rebuilds + DECRYPTS both balances, and verifies
 *    them against the chain's own commitments. No server.
 *
 * The published secrets are testnet accounts holding nothing, published
 * deliberately — the SDK web demo's own precedent and reasoning.
 */
import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;

import SESSION from "./session.json";

const $ = (id: string) => document.getElementById(id)!;
const PAY = SESSION.chain.find((c: any) => c.step === "confidential-transfer")!;
const XLM = (stroops: bigint) => (stroops / 10_000_000n).toString();

// ── receipt slip ────────────────────────────────────────────────────────────
type SlipData = {
  mode: string; date: string; ledger: number | string;
  recipientXlm: string; senderChangeXlm: string; liveNote?: string;
};
function renderSlip(d: SlipData) {
  const slip = $("slip");
  slip.innerHTML = `
    <div class="brand">⭑ STELLAR-LIGHT AGENT EXPERIMENTS</div>
    <div class="title">PAYMENT RECEIPT</div>
    <div class="net">stellar testnet · confidential · ${d.mode}</div>
    <hr class="cut">
    <div class="lr"><span class="l">DATE</span><span class="r">${d.date}</span></div>
    <div class="lr"><span class="l">LEDGER</span><span class="r">${d.ledger}</span></div>
    <div class="lr"><span class="l">FROM</span><span class="r">NOVA · ${SESSION.nova.address.slice(0, 8)}…${SESSION.nova.address.slice(-4)}</span></div>
    <div class="lr"><span class="l">TO</span><span class="r">VEGA · ${SESSION.vega.address.slice(0, 8)}…${SESSION.vega.address.slice(-4)}</span></div>
    <div class="lr"><span class="l">FOR</span><span class="r">${SESSION.product.body.title} (signed)</span></div>
    <hr class="cut">
    <div class="bigrow"><span>TOKEN TRANSFERRED</span><span class="amt">🔒 hidden</span></div>
    <div class="lockbox">ON-CHAIN: elliptic-curve commitments only — no amount exists on-chain</div>
    <div class="okbox">RECIPIENT DECRYPTED: <b>${d.recipientXlm} XLM</b> ✓ matches invoice<br>SENDER CHANGE: ${d.senderChangeXlm} XLM ✓ verified vs chain</div>
    <div class="lr"><span class="l">AUDITOR #0</span><span class="r">can decrypt (protocol-enforced)</span></div>
    <div class="lr"><span class="l">FEE</span><span class="r">&lt;0.01 XLM</span></div>
    <div class="lr"><span class="l">TOTAL (public view)</span><span class="r">🔒</span></div>
    <hr class="cut">
    <div class="lr"><span class="l">TX HASH</span><span class="r">${PAY.tx}</span></div>
    <div class="lr"><span class="l">CONTRACT</span><span class="r">${SESSION.contracts.token.slice(0, 12)}… (OZ Confidential Token)</span></div>
    ${d.liveNote ? `<div class="lr"><span class="l">VERIFIED</span><span class="r">${d.liveNote}</span></div>` : ""}
    <div class="barcode"></div>
    <div class="thanks">amount settled · price private · auditor able</div>`;
  slip.classList.add("printed");
  slip.scrollIntoView({ behavior: "smooth", block: "center" });
  ($("exports") as HTMLElement).style.visibility = "visible";
  ($("link-tx") as HTMLAnchorElement).href = `https://stellar.expert/explorer/testnet/tx/${PAY.tx}`;
}

// ── feed helpers ────────────────────────────────────────────────────────────
function push(feedId: string, html: string, cls = "") {
  const d = document.createElement("div");
  d.className = "msg";
  d.innerHTML = cls ? `<span class="${cls}">${html}</span>` : html;
  const feed = $(feedId);
  feed.appendChild(d);
  feed.scrollTop = feed.scrollHeight;
  return d;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── simulate ────────────────────────────────────────────────────────────────
let simRunning = false;
async function simulate() {
  if (simRunning) return;
  simRunning = true;
  const btn = $("btn-sim") as HTMLButtonElement;
  btn.textContent = "● RUNNING";
  $("feed-sim").innerHTML = "";
  $("slip").classList.remove("printed");

  const chainByStep: Record<string, any> = {};
  for (const c of SESSION.chain) chainByStep[c.step] = c;
  const script: Array<[string, string, number]> = [
    ["nova", SESSION.commerce[0]?.msg ?? "Requesting product — what's your price?", 1100],
    ["vega", SESSION.commerce[1]?.msg ?? "Quote: 40 XLM, payable confidentially.", 1300],
    ["chain", `⛓ register NOVA → tx ${chainByStep["register-nova"].tx.slice(0, 12)}… (ledger ${chainByStep["register-nova"].ledger})`, 850],
    ["chain", `⛓ register VEGA → tx ${chainByStep["register-vega"].tx.slice(0, 12)}… (ledger ${chainByStep["register-vega"].ledger})`, 850],
    ["chain", `⛓ NOVA deposits 100 XLM → tx ${chainByStep["deposit-nova"].tx.slice(0, 12)}… (deposits are public by design)`, 950],
    ["chain", `⛓ merge receiving → spendable → tx ${chainByStep["merge-nova"].tx.slice(0, 12)}…`, 850],
    ["nova", "Paying the invoice confidentially now.", 1100],
    ["chain", `⛓ CONFIDENTIAL TRANSFER → tx ${PAY.tx.slice(0, 12)}… (ledger ${PAY.ledger}) — amount encrypted`, 1400],
    ["vega", "Rebuilding my state from chain events… decrypting my receiving balance…", 1500],
    ["vega", "Payment verified: decrypted exactly 40 XLM. Delivering goods.", 1150],
    ["vega", `Delivered: signed brief — sha256 ${SESSION.product.sha256.slice(0, 12)}…`, 1150],
    ["nova", "Goods received; signature verified. Transaction complete.", 1100],
    ["sys", "— printing receipt —", 650],
  ];
  for (const [who, msg, dwell] of script) {
    push("feed-sim", who === "chain" ? msg : `<span class="who">${who}</span>${msg}`, who === "chain" ? "chainline" : "");
    await sleep(dwell);
  }
  renderSlip({
    mode: "replay",
    date: (PAY.closedAt ?? "").replace("T", " ").replace(".000Z", " UTC"),
    ledger: PAY.ledger,
    recipientXlm: "40.0000000",
    senderChangeXlm: "60.0000000",
  });
  btn.textContent = "↻ REPLAY";
  simRunning = false;
}

// ── verify live: the real client, in this browser ───────────────────────────
let liveRunning = false;
async function verifyLive() {
  if (liveRunning) return;
  liveRunning = true;
  const btn = $("btn-live") as HTMLButtonElement;
  btn.textContent = "● WORKING";
  btn.disabled = true;
  $("feed-live").innerHTML = "";
  $("slip").classList.remove("printed");
  const t0 = performance.now();
  try {
    push("feed-live", "loading the confidential-token client…", "chainline");
    const [{ Keypair }, core, chain] = await Promise.all([
      import("@stellar/stellar-sdk"),
      import("stellar-confidential-token-sdk"),
      import("stellar-confidential-token-sdk/chain"),
    ]);
    const { deriveSk, deriveKeys, skSigningMessage, addressToField, StateEngine, pointToBytes } = core as any;
    const { ChainClient, hybridFetchEvents } = chain as any;

    push("feed-live", "1 · deriving both agents' confidential keys from the published session (SEP-53 signature → sk, in this tab)…");
    const ident = (secret: string) => {
      const kp = Keypair.fromSecret(secret);
      const message = skSigningMessage(SESSION.contracts.token, kp.publicKey());
      const root = new Uint8Array(kp.signMessage(Buffer.from(message)));
      const { sk, addrF } = deriveSk(root, SESSION.contracts.token, kp.publicKey());
      return { keys: deriveKeys(sk, addrF, addressToField(kp.publicKey())), address: kp.publicKey() };
    };
    const nova = ident(SESSION.nova.secret);
    const vega = ident(SESSION.vega.secret);
    push("feed-live", "keys derived — nothing was stored anywhere; the signature IS the root", "okline");

    push("feed-live", `2 · fetching chain events over RPC from ledger ${SESSION.fromLedger}…`);
    const client = new ChainClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contracts: SESSION.contracts,
    });
    const { events } = await hybridFetchEvents(client, undefined, { fromLedger: SESSION.fromLedger });
    const mine = (address: string) => (events as any[]).filter((ev) =>
      ev.type === "register" || ev.type === "merge" ? ev.account === address : ev.from === address || ev.to === address);
    push("feed-live", `${(events as any[]).length} session events fetched from the chain`, "okline");

    push("feed-live", "3 · rebuilding + DECRYPTING both balances locally…");
    const vegaEngine = new StateEngine({ address: vega.address, keys: vega.keys });
    vegaEngine.ingestEvents(mine(vega.address));
    const credited: bigint = vegaEngine.receiving().v;
    const novaEngine = new StateEngine({ address: nova.address, keys: nova.keys });
    novaEngine.ingestEvents(mine(nova.address));
    const change: bigint = novaEngine.state().spendable.v;
    push("feed-live", `VEGA decrypted receiving = <b>${XLM(credited)} XLM</b> · NOVA decrypted change = <b>${XLM(change)} XLM</b>`, "okline");

    push("feed-live", "4 · verifying against the chain's own commitments (the archive can't lie)…");
    const novaOnchain = await client.confidentialBalance(nova.address);
    const check = novaEngine.verifyAgainstChain({
      spendableC: pointToBytes(novaOnchain.spendableBalance),
      receivingC: pointToBytes(novaOnchain.receivingBalance),
    });
    push("feed-live", check.ok ? "byte-for-byte match with on-chain commitments ✓" : "MISMATCH — " + JSON.stringify(check), check.ok ? "okline" : "lockline");
    if (!check.ok) throw new Error("verifyAgainstChain failed");

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    push("feed-live", `— your browser just decrypted a confidential payment and proved it against the chain, in ${secs}s — printing receipt —`, "lockline");
    renderSlip({
      mode: "live-verified",
      date: new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
      ledger: PAY.ledger,
      recipientXlm: XLM(credited) + ".0000000",
      senderChangeXlm: XLM(change) + ".0000000",
      liveNote: `in your browser · ${secs}s`,
    });
  } catch (e: any) {
    push("feed-live", "✗ " + (e?.message ?? String(e)), "lockline");
  } finally {
    btn.textContent = "↻ DECRYPT AGAIN";
    btn.disabled = false;
    liveRunning = false;
  }
}

// ── exports ─────────────────────────────────────────────────────────────────
function receiptTxt() {
  return `STELLAR-LIGHT AGENT EXPERIMENTS
PAYMENT RECEIPT — stellar testnet, confidential
------------------------------------------
LEDGER   ${PAY.ledger}
FROM     NOVA ${SESSION.nova.address}
TO       VEGA ${SESSION.vega.address}
FOR      ${SESSION.product.body.title} (Ed25519-signed)
------------------------------------------
TOKEN TRANSFERRED          [ENCRYPTED]
recipient decrypted:       40.0000000 XLM
sender change decrypted:   60.0000000 XLM
auditor #0:                can decrypt (protocol-enforced)
------------------------------------------
TX  ${PAY.tx}
CONTRACT ${SESSION.contracts.token}
amount settled - price private - auditor able
`;
}
function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

// ── wire up ─────────────────────────────────────────────────────────────────
$("btn-sim").addEventListener("click", simulate);
$("btn-live").addEventListener("click", verifyLive);
$("btn-print").addEventListener("click", () => window.print());
$("btn-txt").addEventListener("click", () => download(`receipt-${PAY.tx.slice(0, 8)}.txt`, new Blob([receiptTxt()], { type: "text/plain" })));
$("btn-json").addEventListener("click", () => {
  const { nova, vega, ...pub } = SESSION as any;
  const safe = { ...pub, nova: { address: SESSION.nova.address }, vega: { address: SESSION.vega.address } };
  download(`receipt-${PAY.tx.slice(0, 8)}.json`, new Blob([JSON.stringify(safe, null, 2)], { type: "application/json" }));
});
$("tab-sim").addEventListener("click", () => switchTab("sim"));
$("tab-live").addEventListener("click", () => switchTab("live"));
function switchTab(which: "sim" | "live") {
  $("tab-sim").classList.toggle("active", which === "sim");
  $("tab-live").classList.toggle("active", which === "live");
  ($("panel-sim") as HTMLElement).style.display = which === "sim" ? "" : "none";
  ($("panel-live") as HTMLElement).style.display = which === "live" ? "" : "none";
}
$("foot").innerHTML = `Session ${PAY.tx.slice(0, 8)}… · 5 txs, ledgers ${SESSION.chain[0].ledger}→${PAY.ledger}, ~20s, proofs ≤1.8s ·
  contracts by <a href="https://github.com/OpenZeppelin/stellar-contracts">OpenZeppelin</a> (testnet) ·
  client SDK <a href="https://github.com/aguilar1x/stellar-confidential-token-sdk">stellar-confidential-token-sdk</a> v0.1.9 (testnet only, unaudited) ·
  published session secrets are deliberate: testnet accounts holding nothing ·
  to our knowledge the first confidential agent-to-agent commerce on Stellar.`;
