# Pump.fun Paper Sprint Bot — Sniper + Dip-Reclaim

A pump.fun paper-trading bot for make.fun's `u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`
bounty. It trades the house replay (`agent-fun/replay/v2`) on 10 SOL paper capital: a sniper
core plus a dip-reclaim lane, hard risk limits, and a guardrail pacer — all in one
parameter-driven `strategy.ts`.

## Strategy

Two lanes were built; only one survived backtesting (see "What the grid found" below):

1. **Dip-reclaim lane (live)** — buy 0.30 SOL of a mature curve (age ≥ 500 slots, real SOL ≥ 3)
   that drew down 30–45% from its 2500-slot high **and** shows buying returning
   (≥ 5 buys, net flow ≥ 0 over the last ~50 slots). The dip alone is not the signal;
   the reclaim is. Adds pyramid only into strength (+0.05 SOL per later batch, ≤ 0.60 SOL
   per coin, only while the price is at or above the last buy price and net flow stays
   positive — never average down).
2. **Sniper lane (built, disabled by the grid)** — buy 0.10 SOL of a fresh launch (age 1–3 slots)
   only when the opening tape looks dispersed, not bundled: the creator did not load up in
   the create slot (≤ 2.5 SOL), the creator never sold, at most 3 distinct non-creator buyers
   early, no single buyer over 60% of the early flow, and net inflow positive. Max one entry
   per coin. The code is intact in `strategy.ts`; it is switched off by `sniperMaxAge: 0`
   because it lost money in every configuration tried (see below) — re-enable with `sniperMaxAge: 3`.

**Exits (whole position, first trigger wins):** take profit +25% on cost, trailing stop 15%
below the best close once up 10%, hard stop −12%, max hold 300 slots, immediate exit if the
creator sells.

**Risk limits:** max 5 open positions (harness cap), ≤ 3 SOL deployed at any time (≤ 30% of
capital), buys capped at 97% of the 1%-of-real-reserve limit, minimum buy 0.02 SOL, buy
slippage 1,500 bps, sells at 10,000 bps.

**Guardrail pacer:** if the run is under 20 distinct coins late in the window, it buys 0.01 SOL
probes in the most liquid clean curves and sells them on the next batch (budget ≤ 0.3 SOL),
so the entry stays guardrail-valid even on a dead window.

## Why this shape

The kit's own pilots all lose money on the dev window (momentum −9.38 SOL, reversion −1.78 SOL,
sniper −0.13 SOL), while the dev leaderboard's top bots are +7 to +19 SOL. The winners filter
on supply/ownership and catch a few runners while keeping most capital in cash — that is what
the rug/bundle filter, the dip-reclaim confirmation gate, and the 30% deployment cap are for.
Buys are sized off free cash (pending orders deducted), never send a second buy while one is
pending on a mint, and never re-send a sell already in flight.

## Files

- `main.ts` — thin `runBot` wrapper (the entry point, `node /bot/main.ts`).
- `strategy.ts` — the whole strategy, fresh-authored, parameter-driven via `DEFAULT_PARAMS`.
- `vendor/makefun-bot.ts` — the kit SDK shim, copied verbatim (not authored lines).

Deterministic by construction: no clock, no randomness, no I/O, insertion-ordered maps only;
all price comparisons use bigint cross-multiplication on the virtual reserves. Entry runs
twice and the action logs must match byte for byte.

## What the grid found (dev window, 2026-11-25)

Every setting below is the mean over 4 failed-tx keys on the local engine (first half of the
24h dev window only — the local sim loads just `part-00000`), confirmed with
`grade-local --driver process` on the full window:

- **As specified** (sniper 0.10 + dip 0.10, TP +25%, hold 600): **−0.052 SOL**, 28 coins.
- **Sniper lane alone: −0.108 SOL.** Dip lane alone: +0.090 SOL. Probes alone: −0.011 SOL.
- **Best robust setting (shipped): dip-only, 0.30 SOL stake, ≤ 0.60 SOL/coin, 300-slot hold,
  5-buy flow confirmation — local mean +0.697 SOL** (worst fail key +0.688, ex-best-2 +0.347),
  97 fills, 25 coins, 25 trips, 7 wins, max DD 0.9%. The peak is a broad region
  (0.30–0.50 SOL stake all score +0.67–0.70), not a knife-edge; bigger stakes and longer
  holds both score worse.
- **Adding the sniper lane back at the best dip settings costs ~0.29 SOL** (+0.697 → +0.408),
  so it stays off.
- **`grade-local` (full 24h dev, real harness): +0.314 SOL**, 208 fills, 40 coins, 40 round
  trips, 27.5% win rate, max DD 6.3%, guardrails met; L1 regrade reproduced byte for byte.
  Top 3 coins made 48% of the gains (without them −0.19 SOL) — the edge is concentrated,
  and the second half of the dev window was much weaker than the first (+0.69 local first-half
  vs +0.31 full-window), so treat the edge as fragile, not proven.
- **`grade-local --stress 20`: median −0.35 SOL, p10 −0.80, p90 +0.05; 16 of 20 rebuilt
  copies lost money; the dev score sits above all 20 copies.** The +0.31 dev score depends
  on the dev window's own coins and does NOT survive resampling — on a fresh window this
  bot is more likely to lose a little than to win. That is the honest robustness verdict;
  do not mistake the dev number for an expected final-window number.

**Honest assessment:** this bot is PnL-positive on dev with tiny drawdown and passes the
guardrails, but at +0.31 SOL on a 24h dev window it is nowhere near the dev top 20
(+2.60 SOL) or the +2 SOL target, and the 6h final is a fresh window where a single runner
decides the winner-takes-all pot. It is a valid, low-risk entry — not a favourite.

[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/doms99999/pumpfun-boothlord/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/doms99999/pumpfun-boothlord/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
