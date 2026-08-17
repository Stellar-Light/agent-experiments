/**
 * The 7-day fuse, defused.
 *
 * Soroban RPC retains ~121k ledgers (~7 days). Replaying Momo's history from
 * a pinned genesis ledger therefore breaks once that ledger ages out. The
 * fix is the SDK's own design: a StateStore checkpoint. Momo persists its
 * AccountState { spendable, receiving, lastLedger } and every rebuild
 * resumes from lastLedger, so the replay window is "since last checkpoint",
 * never "since genesis".
 *
 * The checkpoint is committed to the repo (public/checkpoint.json) and
 * refreshed by a scheduled job. It contains openings, which anyone holding
 * Momo's (published, testnet) key could derive anyway; nothing new leaks.
 */
import { reviveState, bigintReplacer } from "stellar-confidential-token-sdk";

export const CHECKPOINT_URL = "https://confidential-agent-commerce.vercel.app/checkpoint.json";

export type Checkpoint = { address: string; state: any; inbound: any[]; savedAt: string; savedAtLedger: number };

export async function loadCheckpoint(address: string): Promise<Checkpoint | null> {
  try {
    const r = await fetch(CHECKPOINT_URL, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    const entry = j?.agents ? Object.values(j.agents).find((a: any) => a?.address === address) as any : (j?.address === address ? j : null);
    if (!entry?.state) return null;
    // reviveState keeps only openings + lastLedger; carry the compact inbound list alongside
    return { ...entry, state: reviveState(entry.state), inbound: entry.state.inbound ?? [] };
  } catch { return null; }
}

export function serializeCheckpoint(address: string, state: any, savedAtLedger: number): string {
  return JSON.stringify({ address, state, savedAt: new Date().toISOString(), savedAtLedger }, bigintReplacer, 2);
}

/** How many ledgers of headroom the replay floor has above RPC's oldest retained ledger. */
export async function replayHeadroom(rpc: string, floor: number) {
  const post = (m: string) => fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m }) }).then((r) => r.json());
  const [h, l] = await Promise.all([post("getHealth"), post("getLatestLedger")]);
  const oldest = h.result?.oldestLedger ?? 0, latest = l.result?.sequence ?? 0;
  return { floor, oldest, latest, headroomLedgers: floor - oldest, headroomHours: +(((floor - oldest) * 5) / 3600).toFixed(1), degraded: floor <= oldest };
}
