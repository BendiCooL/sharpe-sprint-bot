# Pump.fun Sharpe Sprint — Launch Scalper

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/BendiCooL/sharpe-sprint-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/BendiCooL/sharpe-sprint-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Entry for the [make.fun bounty "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins"](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).

## Strategy

A launch scalper for the 6-hour pump.fun forward replay. Places go by hourly
Sharpe ratio, not wild PnL — so this bot trades for a steady equity curve built
from many small, short, roughly independent scalps.

It watches every coin from its `CreateEvent`, reads the opening tape for at most
3 slots, and buys only the quiet launches:

- at most **1 outside buyer** in the opening tape,
- creator's own buy at most **2.5 SOL**,
- creator has **not sold** yet.

It stakes up to **0.1 SOL** per coin, takes profit fast at **+50%**, cuts at
**−20%**, never holds past **4 slots**, and leaves at once if the creator sells.
One trip per coin, no pyramiding, at most 5 open positions.

## Dev-window backtest (kit sim, 24 h)

- Net **−0.0093 SOL** over 53 trips, 21% win rate, drawdown **0.003**
- Hourly-Sharpe proxy **−0.06**; per 6 h block: +0.021 / −0.023 / +0.005 / −0.012 SOL
- At 2× fee: −0.0497 SOL

Near-breakeven with tiny volatility is exactly what hourly-Sharpe ranking
rewards. For comparison, the kit's own momentum pilot loses −9.38 SOL
(95% drawdown) on the same window.

## Files

- `main.ts` — entry point (Node 22, stdlib only, deterministic, no network).
- `strategy.ts` — the scalper logic and its final parameters.
- `vendor/makefun-bot.ts` — byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`.
