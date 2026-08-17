/**
 * One button, one REAL confidential payment on Stellar testnet.
 *
 * Everything happens in this tab: the buyer's zero-knowledge proof is
 * generated in your browser (UltraHonk via wasm), the transfer is submitted
 * to the live contract, and the seller confirms payment by decrypting its
 * own receiving balance from public chain events. Every run is a new
 * on-chain transaction, the price is random each time and never visible
 * on-chain.
 *
 * Session keys are published testnet keys holding nothing (deliberate, the
 * SDK demo's own precedent), so the page can run the real client.
 */
import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;

import SESSION from "./session.json";
import { blobAvatar } from "./avatar";
import { discloseToExaminer } from "./disclose";

// the site redeploys often; if an old tab's lazy chunk 404s, reload once
window.addEventListener("vite:preloadError", () => window.location.reload());

const $ = (id: string) => document.getElementById(id)!;
const STROOP = 10_000_000n;
const RPC = "https://soroban-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";

// ── chat rendering ──────────────────────────────────────────────────────────
let lastSide = "";
function ensureName(side: "pip" | "momo") {
  if (lastSide === side) return;
  lastSide = side;
  const n = document.createElement("div");
  n.className = `name ${side === "pip" ? "pip" : ""}`;
  n.style.textAlign = side === "pip" ? "right" : "left";
  const who = side === "pip" ? SESSION.pip.address : SESSION.momo.address;
  const face = `<img src="${blobAvatar(who)}" width="20" height="20" style="vertical-align:-5px;border-radius:50%">`;
  n.innerHTML = side === "pip"
    ? `${agentName("pip")} (buyer) <span style="margin-left:5px">${face}</span>`
    : `<span style="margin-right:5px">${face}</span> ${agentName("momo")} (seller)`;
  $("chat").appendChild(n);
}
function bubble(side: "pip" | "momo", text: string) {
  ensureName(side);
  const row = document.createElement("div");
  row.className = `row ${side}`;
  row.innerHTML = `<div class="bubble">${text}</div>`;
  $("chat").appendChild(row);
  row.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function sys(text: string, cls = "") {
  const row = document.createElement("div");
  row.className = "row sys";
  row.innerHTML = `<div class="s ${cls}">${text}</div>`;
  $("chat").appendChild(row);
  row.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function typing(side: "pip" | "momo", label: string) {
  ensureName(side);
  const row = document.createElement("div");
  row.className = `row ${side} typing`;
  row.innerHTML = `<div class="bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
  const lab = document.createElement("div");
  lab.className = `tlabel ${side}`;
  lab.textContent = label;
  $("chat").appendChild(row);
  $("chat").appendChild(lab);
  row.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return () => { row.remove(); lab.remove(); };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const status = (t: string) => (($("status") as HTMLElement).textContent = t);

// agent display names (fixed)
const DEFAULT_NAMES: Record<string, string> = { pip: "Pip", momo: "Momo" };
function agentName(k: string): string {
  try { return localStorage.getItem("name:" + k) || DEFAULT_NAMES[k]; } catch { return DEFAULT_NAMES[k]; }
}

async function renderFeed() {
  try {
    const f = await fetch("/api/momo/feed").then((r) => r.json());
    const ul = document.getElementById("feedlist"); if (!ul) return;
    const rows = (f.customers ?? []).slice(0, 8).map((c: any) => {
      const who = c.address === SESSION.pip.address ? "Pip (this page)" : (c.name ? c.name : "agent " + c.address.slice(0, 6) + "…");
      return `<li><img src="${blobAvatar(c.address, 16)}" width="16" height="16" style="vertical-align:-3px;border-radius:50%;margin-right:6px">${who}: ${c.payments} payment${c.payments === 1 ? "" : "s"}, ${(+c.totalXlm).toFixed(2)} XLM decrypted, last ledger ${c.lastLedger} <a href="https://stellar.expert/explorer/testnet/account/${c.address}" target="_blank" rel="noreferrer">↗</a></li>`;
    });
    ul.innerHTML = rows.join("") + `<li style="color:var(--sub)">${f.paymentsTotal} payments, ${(+f.receivedXlm).toFixed(2)} XLM received in total</li>`;
  } catch { const ul = document.getElementById("feedlist"); if (ul) ul.innerHTML = "<li style='color:var(--sub)'>feed unavailable</li>"; }
}
renderFeed();

// USD mode: live XLM/USD from the reflector oracle (mainnet, read-only, keyless)
async function xlmUsdRate(sdk: any): Promise<number> {
  const { Contract, TransactionBuilder, Networks, xdr: X, scValToNative, rpc } = sdk;
  const server = new (rpc?.Server ?? sdk.SorobanRpc.Server)("https://mainnet.sorobanrpc.com");
  const source = await server.getAccount("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7");
  const contract = new Contract("CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN");
  const asset = X.ScVal.scvVec([X.ScVal.scvSymbol("Other"), X.ScVal.scvSymbol("XLM")]);
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.PUBLIC })
    .addOperation(contract.call("lastprice", asset)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  const native = scValToNative(sim.result.retval);
  const rate = Number(native.price) / 1e14;
  if (!(rate > 0.01 && rate < 100)) throw new Error("oracle rate out of sane range");
  return rate;
}

// ── the run ─────────────────────────────────────────────────────────────────
let running = false;
async function run() {
  if (running) return;
  running = true;
  const btn = $("run") as HTMLButtonElement;
  btn.disabled = true;
  $("chat").innerHTML = "";
  lastSide = "";
  $("slip").classList.remove("printed");
  const mask0 = document.getElementById("feedmask") as HTMLElement | null; if (mask0) { mask0.style.height = "0px"; mask0.classList.remove("printing"); }
  ($("exports") as HTMLElement).style.visibility = "hidden";

  try {
    status("loading client…");
    const [{ Keypair, Address, nativeToScVal, xdr }, core, chain, circuit] = await Promise.all([
      import("@stellar/stellar-sdk"),
      import("stellar-confidential-token-sdk"),
      import("stellar-confidential-token-sdk/chain"),
      fetch("/circuits/transfer.json").then((r) => r.json()),
    ]);
    const { deriveSk, deriveKeys, skSigningMessage, addressToField, StateEngine, pointToBytes,
            proverFromArtifact, buildTransferWitness, encodeTransferData } = core as any;
    const { ChainClient, keypairSigner, hybridFetchEvents } = chain as any;
    const addr = (a: string) => new Address(a).toScVal();
    const i128 = (v: bigint) => nativeToScVal(v, { type: "i128" });
    const bytesVal = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));

    const client = new ChainClient({ rpcUrl: RPC, networkPassphrase: PASSPHRASE, contracts: SESSION.contracts });
    const pipKp = Keypair.fromSecret(SESSION.pip.secret);
    const momoKp = Keypair.fromSecret(SESSION.momo.secret);
    const ident = (kp: any) => {
      const message = skSigningMessage(SESSION.contracts.token, kp.publicKey());
      const root = new Uint8Array(kp.signMessage(Buffer.from(message)));
      const { sk, addrF } = deriveSk(root, SESSION.contracts.token, kp.publicKey());
      return { keys: deriveKeys(sk, addrF, addressToField(kp.publicKey())), address: kp.publicKey() };
    };
    const pip = ident(pipKp);
    const momo = ident(momoKp);
    const pipSigner = keypairSigner(pipKp.secret(), PASSPHRASE);

    const mine = (address: string, events: any[]) => events.filter((ev) =>
      ev.type === "register" || ev.type === "merge" ? ev.account === address : ev.from === address || ev.to === address);
    // replay from the latest checkpoint when one exists (defuses the RPC retention window), else from genesis
    let CP: any = null;
    try { CP = await fetch("/checkpoint.json", { cache: "no-store" }).then((r) => r.ok ? r.json() : null); } catch {}
    const { reviveState } = core as any;
    const cpFor = (address: string) => {
      const entry: any = CP?.agents ? Object.values(CP.agents).find((a: any) => a?.address === address) : null;
      return entry?.state ? { state: reviveState(entry.state), savedAtLedger: entry.savedAtLedger as number } : null;
    };
    const rebuild = async (who: { address: string; keys: any }) => {
      const cp = cpFor(who.address);
      const from = cp ? Math.max(SESSION.fromLedger, cp.savedAtLedger - 50) : SESSION.fromLedger;
      const { events } = await hybridFetchEvents(client, undefined, { fromLedger: from });
      const e = new StateEngine({ address: who.address, keys: who.keys, store: cp ? { load: async () => cp.state, save: async () => {} } : undefined });
      if (cp) await e.load();
      const evs = mine(who.address, events).filter((ev: any) => !cp || ev.ledger > cp.state.lastLedger);
      e.ingestEvents(evs);
      return e;
    };

    // ── Pip's policy: a budget it will not exceed, and a haggling style ──
    const parseXlm = (raw: string): bigint | null => {
      const t = raw.trim();
      if (!t) return null;
      if (!/^\d+(\.\d{1,7})?$/.test(t)) throw new Error("budget must be a number with up to 7 decimals, e.g. 3.7");
      const [i, f = ""] = t.split(".");
      const v = BigInt(i) * STROOP + BigInt((f + "0000000").slice(0, 7));
      if (v <= 0n) throw new Error("budget must be positive");
      if (v > 200n * STROOP) throw new Error("keep the budget under 200 XLM, it's a shared testnet balance");
      return v;
    };
    const denom = ($("denom") as HTMLSelectElement).value;
    const typed = parseXlm(($("amt") as HTMLInputElement).value);
    let budget: bigint;
    if (denom === "usd" && typed) {
      status("reading oracle rate");
      const rate = await xlmUsdRate(await import("@stellar/stellar-sdk"));
      const usd = Number(typed) / 1e7;
      budget = BigInt(Math.round((usd / rate) * 1e7));
      if (budget > 200n * STROOP) throw new Error(`$${usd} is ${(Number(budget) / 1e7).toFixed(2)} XLM at the current rate; keep it under 200 XLM`);
      sys(`Pip's budget: $${usd} = ${(Number(budget) / 1e7).toFixed(4)} XLM at ${rate.toFixed(4)} USD/XLM (live reflector oracle). Momo will not learn this number.`);
    } else {
      budget = typed ?? BigInt(3 + Math.floor(Math.random() * 5)) * STROOP;
      sys(`Pip's budget: ${(Number(budget) / 1e7)} XLM (private to Pip). Momo quotes from its own policy; neither knows the other's number.`);
    }
    const style = (($("style") as HTMLSelectElement | null)?.value ?? "haggle") as "haggle" | "take" | "stingy";

    // ── Momo is a real service. Pip asks it for a quote. ──
    status("Pip requests a quote from Momo");
    bubble("pip", "Need the settlement brief. What's your price today?");
    let t = typing("momo", "checking my books");
    const q1 = await fetch("/api/momo/quote", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyer: pip.address }) }).then((r) => r.json());
    t();
    if (!q1?.priceXlm) throw new Error("Momo did not answer");
    bubble("momo", `${q1.priceXlm} XLM. ${q1.rationale}. Pay confidentially; the amount stays between us and the auditor.`);
    sys(`Momo's quote is signed by Momo (${String(q1.signature).slice(0, 10)}…) and reflects its books: ${q1.booksHint?.paymentsEverReceived} payments ever, ${q1.booksHint?.lastHour} in the last hour`);

    // ── Pip decides: accept, counter, or walk ──
    let agreed: bigint | null = null;
    const quoted = BigInt(Math.round(q1.priceXlm * 1e7));
    const xl = (v: bigint) => (Number(v) / 1e7).toString();
    await wait(500);
    if (quoted <= budget && style === "take") {
      agreed = quoted; bubble("pip", `${xl(quoted)} works. Paying now.`);
    } else {
      // counter: haggle opens at ~60% of the quote (capped at budget); stingy opens at 40%
      const openFrac = style === "stingy" ? 0.4 : 0.6;
      let offer = BigInt(Math.round(Number(quoted) * openFrac));
      if (offer > budget) offer = budget;
      for (let round = 0; round < 3 && agreed === null; round++) {
        bubble("pip", round === 0 ? `Steep. I can do ${xl(offer)}.` : `Meet me at ${xl(offer)}?`);
        t = typing("momo", "considering the offer");
        const q2 = await fetch("/api/momo/quote", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ buyer: pip.address, offer: Number(offer) / 1e7 }) }).then((r) => r.json());
        t();
        if (q2.accepted) { agreed = offer; bubble("momo", `${q2.note}. ${xl(offer)} it is.`); break; }
        bubble("momo", `${q2.note}.`);
        // raise toward the quote, never past the budget
        const next = offer + (quoted - offer) / 2n;
        if (next > budget || next <= offer) {
          if (quoted <= budget) { agreed = quoted; bubble("pip", `Fine, ${xl(quoted)}. Paying.`); }
          else { bubble("pip", `That's over my budget. Walking away.`); }
          break;
        }
        offer = next;
      }
    }
    if (agreed === null) {
      sys("no deal: Momo's floor is above Pip's budget. Nothing was paid, nothing hit the chain. Raise the budget or change Pip's style.");
      status("no deal");
      return;
    }
    const price = agreed;
    const priceXlm = xl(price);

    // ── funds check + top-up if needed (real transactions, no proof required) ──
    status("checking balance…");
    let pipEngine = await rebuild(pip);
    let spendable = pipEngine.state().spendable;
    if (spendable.v < price + 2n * STROOP) {
      const topup = price + 100n * STROOP;
      sys(`buyer balance low, depositing ${xl(topup)} XLM into the contract (deposits are public by design)`);
      const dep = await client.invoke(SESSION.contracts.token, "deposit",
        [addr(pip.address), addr(pip.address), i128(topup)], pipSigner);
      sys(`deposit tx ${dep.hash.slice(0, 10)}…`);
      const mrg = await client.invoke(SESSION.contracts.token, "merge", [addr(pip.address)], pipSigner);
      sys(`merge tx ${mrg.hash.slice(0, 10)}…`);
      pipEngine = await rebuild(pip);
      spendable = pipEngine.state().spendable;
    }

    // ── Pip pays: proof in this tab, settle on testnet ──
    t = typing("pip", "generating zero-knowledge proof in this tab…");
    status("proving…");
    const kAud = await client.auditorKey(SESSION.auditorId);
    const t0 = performance.now();
    const witness = buildTransferWitness({
      keys: pip.keys, v: spendable.v, r: spendable.r, amount: price,
      pvkB: momo.keys.PVK, kAudR: kAud, kAudS: kAud,
    });
    const prover = proverFromArtifact(circuit);
    const { proof } = await prover.prove(witness.inputs);
    await prover.destroy();
    const proveSecs = ((performance.now() - t0) / 1000).toFixed(1);
    const payload = new Uint8Array(encodeTransferData(witness, proof).bytes());
    const rEScalarForDisclosure: bigint = witness.rEScalar;
    t();
    sys(`proof generated in this browser in ${proveSecs}s`, "good");

    t = typing("pip", "submitting to testnet…");
    status("submitting…");
    const pay = await client.invoke(SESSION.contracts.token, "confidential_transfer",
      [addr(pip.address), addr(momo.address), bytesVal(payload)], pipSigner);
    t();
    sys(`confidential transfer settled <a href="https://stellar.expert/explorer/testnet/tx/${pay.hash}" target="_blank" rel="noreferrer">${pay.hash.slice(0, 16)}…</a> (the amount is not in that transaction)`, "good");
    bubble("pip", `Sent. ${xl(price)} as agreed. Check your side.`);

    // ── Momo checks the till: decrypts THIS payment with its own key, server-side ──
    await wait(400);
    t = typing("momo", "checking the till, decrypting your transfer with my key");
    status("Momo verifying by decryption…");
    let served: any = null;
    for (let attempt = 0; attempt < 6 && !served?.delivered; attempt++) {
      const resp = await fetch(`/api/momo/pay?tx=${pay.hash}&agreed=${priceXlm}&name=Pip`);
      served = await resp.json().catch(() => null);
      if (served?.delivered) break;
      if (served?.paid && served?.decryptedXlm != null && !served?.delivered) break; // mismatch, no retry
      await wait(2500);
    }
    t();
    if (!served?.paid) throw new Error(served?.error || "Momo could not find the payment");
    if (!served.delivered) throw new Error(served.error || "Momo refused delivery");
    const momoAfter = BigInt(Math.round((served.decryptedXlm ?? 0) * 1e7));
    bubble("momo", `Confirmed. I decrypted exactly ${served.decryptedXlm} XLM from your transfer. Matches what we agreed. Shipping.`);
    const sigOk = momoKp.verify(
      (await import("@stellar/stellar-sdk")).hash(Buffer.from(JSON.stringify(served.brief))),
      Buffer.from(served.signature, "base64"));
    sys(`Momo verified the payment by decrypting it (not by trusting Pip), delivered "${served.brief.title}", sha256 ${String(served.sha256).slice(0, 12)}…, signature ${sigOk ? "verified" : "FAILED"}`, sigOk ? "good" : "");
    bubble("momo", `Delivered: "${served.brief.title}".`);

    // chain verification of the buyer's own state
    const after = await rebuild(pip);
    const onchain = await client.confidentialBalance(pip.address);
    const check = after.verifyAgainstChain({
      spendableC: pointToBytes(onchain.spendableBalance),
      receivingC: pointToBytes(onchain.receivingBalance),
    });
    sys(check.ok ? "buyer state verified byte-for-byte against on-chain commitments" : "verify mismatch", check.ok ? "good" : "");
    await wait(300);
    bubble("pip", "Received. Good doing business.");

    // ── Selective disclosure: an examiner shows up. Pip proves THIS payment to them, and only this. ──
    if ((($("disclose") as HTMLInputElement | null)?.checked ?? true)) {
      status("examiner requests disclosure…");
      sys("an examiner appears (fresh keys, no wallet secrets, could be an accountant or regulator). It asks Pip to disclose this one payment.");
      t = typing("pip", "proving the amount of this exact transfer to the examiner (zero-knowledge, sender-role)");
      try {
        // Pip needs the on-chain event for its own transfer
        const { events: evs } = await hybridFetchEvents(client, undefined, { fromLedger: SESSION.fromLedger });
        const myEv: any = evs.find((e: any) => e.type === "transfer" && String(e.txHash).toLowerCase() === pay.hash.toLowerCase());
        if (!myEv) throw new Error("own transfer event not found yet");
        const [dc, dvk] = await Promise.all([
          fetch("/circuits/disclose_sender.json").then((r) => r.json()),
          fetch("/circuits/disclose_sender.vk.json").then((r) => r.json()),
        ]);
        const d = await discloseToExaminer({
          core, client, circuit: dc, vkBase64: dvk.vkBase64, role: "sender", keys: pip.keys, rEScalar: rEScalarForDisclosure,
          pvkB: momo.keys.PVK, event: myEv, addrF: addressToField(SESSION.contracts.token), disclosingAccount: pip.address,
        });
        t();
        sys(`examiner verified with no keys of its own: this transfer was exactly ${d.amountXlm} XLM (proof ${d.proveSecs}s, verify ${d.verifySecs}s, ${d.steps.length} checks, pinned OpenZeppelin vk). It learned nothing else: not Pip's balance, not other payments, not Momo's side.`, d.ok ? "good" : "");
        bubble("pip", `Disclosed to the examiner: ${d.amountXlm} XLM for this payment. That's all they get.`);
        (window as any).__lastDisclosure = d.bundle;
      } catch (e: any) {
        t();
        sys(`disclosure skipped: ${String(e?.message ?? e).replace(/[<>&]/g, "")}`);
      }
    }
    status("");

    // the receipt, with the actual fee charged
    let feeXlm = "";
    try {
      const tr = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash: pay.hash } }) }).then((r) => r.json());
      const fc = xdr.TransactionResult.fromXDR(tr.result.resultXdr, "base64").feeCharged().toString();
      feeXlm = (Number(fc) / 1e7).toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
    } catch {}
    receipt(pay.hash, priceXlm, (Number(after.state().spendable.v) / 1e7).toString(), feeXlm);

    // live panels: chain view vs decrypted view + history
    try {
      const vegaOn = await client.confidentialBalance(momo.address);
      $("pip-commit").textContent = Buffer.from(pointToBytes(onchain.spendableBalance)).toString("hex").slice(0, 48) + "…";
      $("momo-commit").textContent = Buffer.from(pointToBytes(vegaOn.receivingBalance)).toString("hex").slice(0, 48) + "…";
      $("pip-dec").textContent = (Number(after.state().spendable.v) / 1e7).toString() + " XLM spendable";
      $("momo-dec").textContent = (Number(momoAfter) / 1e7).toString() + " XLM decrypted from this payment";
      ($("balances") as HTMLElement).style.display = "";
    } catch {}
    pushHistory({ tx: pay.hash, amt: priceXlm, at: new Date().toISOString().slice(0, 16).replace("T", " ") });
    renderFeed();
  } catch (e: any) {
    const raw = String(e?.message || e?.name || e || "unknown");
    if (raw.includes("dynamically imported module")) {
      sys("the site was updated while this tab was open; reloading the new version");
      setTimeout(() => window.location.reload(), 1200);
      return;
    }
    const msg = raw.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
    sys(`error: ${msg}. If two people run this at once the balance state races; try again`, "");
    status("");
  } finally {
    btn.disabled = false;
    running = false;
  }
}

// ── receipt ─────────────────────────────────────────────────────────────────
let lastTx = "";
let lastTxt = "";
function receipt(tx: string, priceXlm: string, changeXlm: string, feeXlm = "") {
  lastTx = tx;
  const dt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  $("slip").innerHTML = `
    <div class="t1">PAYMENT RECEIPT</div>
    <div class="t2">stellar testnet, confidential transfer</div>
    <hr class="cut">
    <div class="lr"><span class="l">DATE</span><span class="r">${dt}</span></div>
    <div class="lr"><span class="l">FROM</span><span class="r">${agentName("pip")} <a href="https://stellar.expert/explorer/testnet/account/${SESSION.pip.address}" target="_blank" rel="noreferrer">${SESSION.pip.address.slice(0, 6)}…${SESSION.pip.address.slice(-4)}</a></span></div>
    <div class="lr"><span class="l">TO</span><span class="r">${agentName("momo")} <a href="https://stellar.expert/explorer/testnet/account/${SESSION.momo.address}" target="_blank" rel="noreferrer">${SESSION.momo.address.slice(0, 6)}…${SESSION.momo.address.slice(-4)}</a></span></div>
    <hr class="cut">
    <div class="bigrow"><span>AMOUNT ON-CHAIN</span><span class="amt">ENCRYPTED</span></div>
    <div class="decr">SELLER DECRYPTED: +${priceXlm} XLM (exact match)<br>BUYER CHANGE: ${changeXlm} XLM, chain-verified</div>
    <div class="lr"><span class="l">AUDITOR</span><span class="r">#${SESSION.auditorId}, can decrypt, enforced by the proof</span></div>
    <div class="lr"><span class="l">FEE</span><span class="r">${feeXlm ? feeXlm + " XLM (actual)" : "unavailable"}</span></div>
    <hr class="cut">
    <div class="lr"><span class="l">TX</span><span class="r"><a href="https://stellar.expert/explorer/testnet/tx/${tx}" target="_blank" rel="noreferrer">${tx}</a></span></div>
    <div class="lr"><span class="l">CONTRACT</span><span class="r"><a href="https://stellar.expert/explorer/testnet/contract/${SESSION.contracts.token}" target="_blank" rel="noreferrer">${SESSION.contracts.token.slice(0, 10)}…</a> (OpenZeppelin)</span></div>
    <div class="lr"><span class="l">PROOF</span><span class="r">UltraHonk, generated in this browser</span></div>`;
  const slip = $("slip");
  slip.classList.add("printed");
  const slot = document.getElementById("slot");
  if (slot) slot.style.display = "";
  const mask = document.getElementById("feedmask") as HTMLElement | null;
  if (mask) {
    mask.classList.remove("printing");
    mask.style.height = slip.scrollHeight + 16 + "px";
    if (slot) slot.scrollIntoView({ behavior: "smooth", block: "center" });
    void mask.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => mask.classList.add("printing")));
  }
  ($("exports") as HTMLElement).style.visibility = "visible";
  ($("b-tx") as HTMLAnchorElement).href = `https://stellar.expert/explorer/testnet/tx/${tx}`;
  lastTxt = `PAYMENT RECEIPT - stellar testnet, confidential transfer
${dt}
FROM ${agentName("pip")} ${SESSION.pip.address}
TO   ${agentName("momo")} ${SESSION.momo.address}
AMOUNT ON-CHAIN: ENCRYPTED
seller decrypted: +${priceXlm} XLM (exact match)
buyer change: ${changeXlm} XLM, chain-verified
auditor #${SESSION.auditorId}: can decrypt, enforced by the proof
TX ${tx}
CONTRACT ${SESSION.contracts.token}
`;
  $("slip").scrollIntoView({ behavior: "smooth", block: "center" });
}

type Run = { tx: string; amt: string; at: string };
function loadHistory(): Run[] { try { return JSON.parse(localStorage.getItem("runs") ?? "[]"); } catch { return []; } }
let historyExpanded = false;
function renderHistory() {
  const runs = loadHistory();
  if (!runs.length) return;
  ($("histwrap") as HTMLElement).style.display = "";
  const shown = historyExpanded ? runs : runs.slice(0, 3);
  const row = (r: Run) =>
    `<li>${r.at} UTC, ${r.amt} XLM (hidden on-chain), <a href="https://stellar.expert/explorer/testnet/tx/${r.tx}" target="_blank" rel="noreferrer">${r.tx.slice(0, 12)}…</a></li>`;
  const toggle = runs.length > 3
    ? `<li><button class="histmore" id="histmore">${historyExpanded ? "show fewer" : `show all ${runs.length}`}</button></li>`
    : "";
  $("history").innerHTML = shown.map(row).join("") + toggle;
  document.getElementById("histmore")?.addEventListener("click", () => { historyExpanded = !historyExpanded; renderHistory();
 });
}
function pushHistory(r: Run) {
  const runs = [r, ...loadHistory()].slice(0, 12);
  localStorage.setItem("runs", JSON.stringify(runs));
  renderHistory();
}
renderHistory();
// identity strip
function renderIdentity() {
  const strip = document.getElementById("idstrip");
  if (!strip) return;
  const card = (addr: string, key: string, role: string) => `
    <div class="idcard"><img src="${blobAvatar(addr, 40)}" width="40" height="40" alt="">
      <div><div class="idname" data-agent="${key}">${agentName(key)}</div><div class="idrole">${role}</div>
      <a class="idaddr" href="https://stellar.expert/explorer/testnet/account/${addr}" target="_blank" rel="noreferrer">${addr.slice(0, 6)}…${addr.slice(-4)}</a></div></div>`;
  strip.innerHTML = card(SESSION.pip.address, "pip", "autonomous buyer, pays confidentially") +
    card(SESSION.momo.address, "momo", "autonomous seller, verifies by decryption");
}
renderIdentity();
const ln = $("l-pip") as HTMLAnchorElement, lv = $("l-momo") as HTMLAnchorElement;
ln.href = `https://stellar.expert/explorer/testnet/account/${SESSION.pip.address}`;
ln.textContent = SESSION.pip.address;
lv.href = `https://stellar.expert/explorer/testnet/account/${SESSION.momo.address}`;
lv.textContent = SESSION.momo.address;

$("run").addEventListener("click", run);
$("b-print").addEventListener("click", () => window.print());
$("b-txt").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lastTxt], { type: "text/plain" }));
  a.download = `receipt-${lastTx.slice(0, 8)}.txt`;
  a.click();
});
