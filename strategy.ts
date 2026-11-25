// Pump.fun paper-trading bot: sniper core + dip-reclaim lane + hard risk limits.
//
// Idea (from the dev-window research): the kit pilots chase price moves and lose money;
// the leaderboard winners filter on supply/ownership and catch a few runners while keeping
// most capital in cash. So this bot does two small, selective things and nothing else:
//
//   1. Sniper lane: buy a fresh launch (age 1-3 slots) only when the opening tape looks
//      dispersed, not bundled — creator did not load up in the create slot, creator never
//      sold, at most 3 distinct non-creator buyers early, no single buyer dominating the
//      early flow — and net inflow is positive.
//   2. Dip-reclaim lane: buy a mature curve (age >= 500 slots, real SOL >= 3) that drew
//      down 30-45% from its 2500-slot high AND shows buying returning ( >= 3 buys, net
//      flow >= 0 over the last ~50 slots). The dip alone is not the signal; the reclaim is.
//
// Exits are whole-position, first trigger wins: take profit, trailing stop once up 10%,
// hard stop, max hold, or the creator selling. Adds pyramid only into strength (price at
// or above the last buy price, net flow positive) — never average down. A guardrail pacer
// fires cheap 0.01 SOL probes late in the window if the 20-coin minimum is at risk.
//
// Everything is a pure function of the batches the harness sends: no clock, no randomness,
// no I/O, insertion-ordered maps only, so the two graded executions produce byte-identical
// action logs. All decisions use bigint cross-multiplication on the virtual reserves
// (marginal price = virtual quote / virtual tokens); never float division.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Sniper lane: youngest / oldest age (slots since create) at which a first buy may be decided. */
  sniperMinAge: number;
  sniperMaxAge: number;
  /** Lamports to aim for per coin on a first buy (each reply still capped at 1% of real SOL). */
  sniperStakeLamports: number;
  /** Dip lane: stake per first buy, minimum age, minimum real SOL, drawdown band (bps). */
  dipStakeLamports: number;
  dipMinAge: number;
  dipMinRealSol: number;
  dipDdMinBps: number;
  dipDdMaxBps: number;
  /** Lookback (slots) for the window high the dip drawdown is measured from. */
  dipHighWindow: number;
  /** Dip flow confirmation: window (slots), minimum buys, minimum net flow (lamports). */
  dipFlowWindow: number;
  dipMinBuys: number;
  dipMinNetFlow: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time for sniper entries (lamports). */
  sniperMinRealSol: number;
  sniperMaxRealSol: number;
  /** Creator's own buys in the create slot: at most this (lamports). */
  maxDevBuy: number;
  /** Distinct non-creator buyers before a sniper entry: at least / at most. */
  sniperMinBuyers: number;
  sniperMaxBuyers: number;
  /** Largest single early buyer as bps of early non-creator buy SOL, at most. */
  maxLargestBuyerBps: number;
  /** Pyramid adds: lamports per add, most lamports per coin in total, delay after last buy (slots). */
  addLamports: number;
  maxPositionLamports: number;
  addDelay: number;
  /** Slippage allowed on buys (bps); sells always accept anything. */
  buySlippageBps: number;
  /** Exits (whole position, first trigger wins): take profit / trailing / hard stop (bps). */
  tpBps: number;
  trailArmBps: number;
  trailBps: number;
  slBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Most lamports deployed across all positions at once (<= 30% of the 10 SOL capital). */
  maxDeployedLamports: number;
  /** Guardrail pacer: window length (seconds of block time), probe size, probe budget. */
  windowSeconds: number;
  probeBuyLamports: number;
  probeBudgetLamports: number;
  probeMinRealSol: number;
}

// Shipped settings, chosen by a grid over the dev window scored as the mean over 4
// failed-tx keys (never one lucky draw), keeping the most robust point, not the highest:
// dip stake 0.30 SOL / max 0.60 SOL per coin, 300-slot hold, 5-buy flow confirmation.
// The peak is a broad region (0.30-0.50 SOL stake all score 0.67-0.70), not a knife-edge.
// NOTE: sniperMaxAge 0 disables the sniper lane on purpose. The lane was built and
// ablated on dev: sniper-only scored -0.108 SOL, and adding it to the best dip settings
// cost ~0.29 SOL (0.697 -> 0.408) in every configuration tried. The code is intact;
// re-enable it with sniperMaxAge 3 if a later window favours launches again.
export const DEFAULT_PARAMS: Params = {
  sniperMinAge: 1,
  sniperMaxAge: 0,
  sniperStakeLamports: 100_000_000,
  dipStakeLamports: 300_000_000,
  dipMinAge: 500,
  dipMinRealSol: 3_000_000_000,
  dipDdMinBps: 3000,
  dipDdMaxBps: 4500,
  dipHighWindow: 2500,
  dipFlowWindow: 50,
  dipMinBuys: 5,
  dipMinNetFlow: 0,
  minBuyLamports: 20_000_000,
  sniperMinRealSol: 300_000_000,
  sniperMaxRealSol: 30_000_000_000,
  maxDevBuy: 2_500_000_000,
  sniperMinBuyers: 2,
  sniperMaxBuyers: 3,
  maxLargestBuyerBps: 6000,
  addLamports: 50_000_000,
  maxPositionLamports: 600_000_000,
  addDelay: 2,
  buySlippageBps: 1500,
  tpBps: 2500,
  trailArmBps: 1000,
  trailBps: 1500,
  slBps: 1200,
  maxHold: 300,
  exitOnDevSell: true,
  maxDeployedLamports: 3_000_000_000,
  windowSeconds: 21600,
  probeBuyLamports: 10_000_000,
  probeBudgetLamports: 300_000_000,
  probeMinRealSol: 3_000_000_000,
};

const BPS = 10_000n;
/** Curve fees on a sell: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time virtual reserves: the reference price for run-up checks. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  /** Distinct non-creator buyers seen (all time; small on fresh launches). */
  buyers: Set<Pubkey>;
  /** Non-creator buy SOL while age <= 3 slots, and per-buyer split of it. */
  earlyBuyTotal: bigint;
  earlyBuyerSol: Map<Pubkey, bigint>;
  /** Non-creator buy / sell SOL totals (all time). */
  bought: bigint;
  soldByOthers: bigint;
  lastTradeSlot: number;
  /** Recent trade ticks, pruned to the last 600 slots. */
  recent: Tick[];
  /** Window-high price (vq, vt) and the slot it was set; reset when older than dipHighWindow. */
  hiVq: bigint;
  hiVt: bigint;
  hiSlot: number;
  /** A first buy was sent and not rejected/failed: at most one entry per coin. */
  entered: boolean;
  /** Never trade this coin again (exited, hard-filtered, or completed). */
  done: boolean;
  complete: boolean;
  /** Decision price (vq, vt) and slot of the last buy sent; lamports filled into this coin. */
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  spentFilled: bigint;
  buysFilled: number;
}

interface Held {
  openedSlot: number;
  /** Tx fees paid on this position's fills so far (buy + failed sell attempts). */
  txPaid: bigint;
  /** Best liquidation value seen since opening. */
  best: bigint;
  /** Guardrail probe: sell on the first batch the position is visible. */
  probe: boolean;
  devSoldAtOpen: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/**
 * What selling `tokens` against (vq, vt) would pay after curve fees (protocol + creator).
 * Liquidation value = tokens*vq/(vt+tokens) minus ceil(q*125/10000).
 */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

/** The per-reply buy cap, with a 97% safety margin: the harness checks the 1% cap against
 * reserves shifted by our own earlier flow on the coin, which can sit below the recorded ones. */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight: never send a second sell for one. */
  const selling = new Set<Pubkey>();
  /** Mints whose in-flight buy is a guardrail probe. */
  const probePending = new Set<Pubkey>();
  /** Distinct mints with a buy fill of at least 0.01 SOL (the guardrail's round-trip buys). */
  const coinsTraded = new Set<Pubkey>();
  let firstTime: number | null = null;
  let nowTime = 0;
  let probeSent = 0n;

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          devSold: false,
          buyers: new Set(),
          earlyBuyTotal: 0n,
          earlyBuyerSol: new Map(),
          bought: 0n,
          soldByOthers: 0n,
          lastTradeSlot: e.slot,
          recent: [],
          hiVq: BigInt(e.virtual_quote_reserves),
          hiVt: BigInt(e.virtual_token_reserves),
          hiSlot: e.slot,
          entered: false,
          done: false,
          complete: false,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          lastBuySlot: 0,
          spentFilled: 0n,
          buysFilled: 0,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        const isDev = e.user === c.creator;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        if (e.is_buy) {
          if (isDev) {
            if (e.slot === c.createSlot) c.devBuy += sol;
          } else {
            c.bought += sol;
            c.buyers.add(e.user);
            if (e.slot - c.createSlot <= 3) {
              c.earlyBuyTotal += sol;
              c.earlyBuyerSol.set(e.user, (c.earlyBuyerSol.get(e.user) ?? 0n) + sol);
            }
          }
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
        }
        // Window-high price from the post-trade reserves.
        const vq = BigInt(e.virtual_quote_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        if (vq * c.hiVt > c.hiVq * vt) {
          c.hiVq = vq;
          c.hiVt = vt;
          c.hiSlot = e.slot;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold, buy count and distinct non-creator buyers over the last
   * `window` slots; drops ticks older than 600 slots as it goes. */
  function flow(c: Coin, slot: number, window: number): { net: bigint; buys: number; buyers: number } {
    const pruneBefore = slot - 600;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= pruneBefore) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    const from = slot - window;
    let net = 0n;
    let buys = 0;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.slot <= from) continue;
      if (t.isBuy) {
        net += t.sol;
        buys += 1;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buys, buyers: buyers.size };
  }

  /** Drawdown of the current price below the window high, in bps (0 when at or above the high).
   * A high older than the window is forgotten first, so a stale high cannot gate entries. */
  function drawdownBps(c: Coin, vq: bigint, vt: bigint, slot: number): bigint {
    if (slot - c.hiSlot > P.dipHighWindow) {
      c.hiVq = vq;
      c.hiVt = vt;
      c.hiSlot = slot;
      return 0n;
    }
    // price < hi  <=>  vq*hiVt < hiVq*vt
    if (vq * c.hiVt >= c.hiVq * vt) return 0n;
    const num = (c.hiVq * vt - vq * c.hiVt) * BPS;
    const den = c.hiVq * vt;
    return num / den;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  /** Lamports deployed right now: held costs plus in-flight buy amounts. */
  function deployed(state: BotState): bigint {
    let total = 0n;
    for (const pos of state.positions.values()) total += pos.cost_lamports;
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') total += BigInt(p.order.quote_lamports);
    }
    return total;
  }

  /** Hard rug/bundle rejections that are final once true (create-slot facts, creator sells,
   * or a buyer set that only grows). Returns true when the coin must never be bought. */
  function hardRejected(c: Coin): boolean {
    if (c.devSold) return true;
    if (c.devBuy > BigInt(P.maxDevBuy)) return true;
    if (c.buyers.size > P.sniperMaxBuyers) return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const minBuy = BigInt(P.minBuyLamports);

      // --- Fold fills in: held meta, per-coin spend, probe flags, retry-after-reject. ---
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // Harness close (complete / flatten / writeoff): the position is gone.
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const c = coins.get(f.mint);
        if (f.side === 'buy') {
          if (f.status === 'filled') {
            if (BigInt(f.quote_lamports) >= 10_000_000n) coinsTraded.add(f.mint);
            if (c !== undefined) {
              c.spentFilled += BigInt(f.quote_lamports);
              c.buysFilled += 1;
            }
            let h = held.get(f.mint);
            if (h === undefined) {
              h = {
                openedSlot: f.slot,
                txPaid: BigInt(f.tx_fee_lamports),
                best: 0n,
                probe: probePending.has(f.mint),
                devSoldAtOpen: c?.devSold ?? false,
              };
              held.set(f.mint, h);
            } else {
              h.txPaid += BigInt(f.tx_fee_lamports);
            }
            probePending.delete(f.mint);
          } else {
            // Rejected or failed: the entry never happened, so the coin may be tried again
            // while its lane window is still open.
            if (c !== undefined) c.entered = false;
            probePending.delete(f.mint);
          }
        } else {
          // Sell fill.
          const h = held.get(f.mint);
          if (f.status === 'filled') {
            held.delete(f.mint);
            selling.delete(f.mint);
          } else if (f.status === 'rejected') {
            selling.delete(f.mint);
          } else if (h !== undefined) {
            // Failed sell: the position stays, but the tx fee is gone for good.
            h.txPaid += BigInt(f.tx_fee_lamports);
          }
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // --- Exits first: whole position, first trigger wins. ---
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, probe: probePending.has(mint), devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (h.probe) {
          // Guardrail probe: sell on the first batch the position is visible.
          exit = true;
        } else if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined && P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // --- Entries, adds and probes. ---
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let deploy = deployed(state);
      const open = state.committedPositionCount();

      const tryBuy = (mint: Pubkey, want: bigint, isProbe: boolean): void => {
        if (orders.length >= cap) return;
        if (hasPendingBuy(state, mint)) return;
        const amount = want < buyCap(state, mint) ? want : buyCap(state, mint);
        // Guardrail probes are exactly 0.01 SOL by design; they bypass the lane min-buy.
        if (amount < (isProbe ? BigInt(P.probeBuyLamports) : minBuy)) return;
        if (free < amount + tx) return;
        if (deploy + amount > BigInt(P.maxDeployedLamports)) return;
        const c = coins.get(mint);
        if (c === undefined) return;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        deploy += amount;
        c.entered = true;
        c.lastBuyVq = state.curves.get(mint)?.virtual_quote_reserves ?? 0n;
        c.lastBuyVt = state.curves.get(mint)?.virtual_token_reserves ?? 1n;
        c.lastBuySlot = state.slot;
        if (isProbe) {
          probePending.add(mint);
          probeSent += amount;
        }
      };

      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const age = state.slot - c.createSlot;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const rq = curve.real_quote_reserves;

        // Pyramid add: only into strength, never average down.
        if (c.buysFilled > 0 && state.positions.has(c.mint) && !selling.has(c.mint) && !hasPendingBuy(state, c.mint)) {
          const room = BigInt(P.maxPositionLamports) - c.spentFilled;
          if (room >= minBuy && state.slot - c.lastBuySlot >= P.addDelay && c.lastBuyVt > 0n) {
            // Price now at or above the last buy's decision price, and net flow positive.
            if (vq * c.lastBuyVt >= c.lastBuyVq * vt && flow(c, state.slot, 10).net >= 0n) {
              const want = BigInt(P.addLamports) < room ? BigInt(P.addLamports) : room;
              tryBuy(c.mint, want, false);
            }
          }
          continue;
        }
        if (c.entered || c.buysFilled > 0) continue;
        if (open + orders.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) continue;

        // Sniper lane: fresh launch, dispersed opening tape, net inflow positive.
        // NOTE: a failed sniper screen must NOT mark the coin done — the same coin may
        // still qualify for the dip lane hundreds of slots later (its early buyer count
        // or create-slot creator buy says nothing about a later dip-reclaim setup).
        if (age >= P.sniperMinAge && age <= P.sniperMaxAge) {
          if (hardRejected(c)) continue;
          if (rq < BigInt(P.sniperMinRealSol) || rq > BigInt(P.sniperMaxRealSol)) continue;
          if (c.buyers.size < P.sniperMinBuyers) continue;
          // No single early buyer dominating the flow.
          if (c.earlyBuyTotal > 0n) {
            let largest = 0n;
            for (const s of c.earlyBuyerSol.values()) if (s > largest) largest = s;
            if (largest * BPS > c.earlyBuyTotal * BigInt(P.maxLargestBuyerBps)) continue;
          }
          if (c.bought - c.soldByOthers <= 0n) continue;
          tryBuy(c.mint, BigInt(P.sniperStakeLamports), false);
          continue;
        }

        // Dip-reclaim lane: mature curve, 30-45% off its window high, buying returning.
        if (age >= P.dipMinAge) {
          if (c.devSold) continue;
          if (rq < BigInt(P.dipMinRealSol)) continue;
          const dd = drawdownBps(c, vq, vt, state.slot);
          if (dd < BigInt(P.dipDdMinBps) || dd > BigInt(P.dipDdMaxBps)) continue;
          const fl = flow(c, state.slot, P.dipFlowWindow);
          if (fl.buys < P.dipMinBuys || fl.net < BigInt(P.dipMinNetFlow)) continue;
          tryBuy(c.mint, BigInt(P.dipStakeLamports), false);
        }
      }

      // --- Guardrail pacer: late in the window, if under 20 coins, buy 0.01 SOL probes
      // in the most liquid clean curves and sell them on the next batch. ---
      if (firstTime !== null && coinsTraded.size < 20 && probeSent < BigInt(P.probeBudgetLamports)) {
        const elapsed = nowTime - firstTime;
        if (elapsed * 4 >= P.windowSeconds * 3) {
          // Most liquid first: scan for the largest real SOL reserve among eligible coins.
          const picked: Pubkey[] = [];
          for (let n = 0; n < 3 && orders.length < cap; n++) {
            let bestMint: Pubkey | null = null;
            let bestRq = -1n;
            for (const c of coins.values()) {
              if (c.done || c.complete || c.entered || picked.includes(c.mint)) continue;
              if (state.positions.has(c.mint) || hasPendingBuy(state, c.mint)) continue;
              if (c.devSold || c.devBuy > BigInt(P.maxDevBuy)) continue;
              const curve = state.curves.get(c.mint);
              if (curve === undefined || curve.complete) continue;
              if (curve.real_quote_reserves < BigInt(P.probeMinRealSol)) continue;
              if (curve.real_quote_reserves > bestRq) {
                bestRq = curve.real_quote_reserves;
                bestMint = c.mint;
              }
            }
            if (bestMint === null) break;
            const before = orders.length;
            tryBuy(bestMint, BigInt(P.probeBuyLamports), true);
            if (orders.length === before) break;
            picked.push(bestMint);
          }
        }
      }

      return orders;
    },
  };
}
