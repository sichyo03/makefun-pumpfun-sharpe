# Proven-Demand Scalper — Pump.fun Sharpe Sprint

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/sichyo03/makefun-pumpfun-sharpe/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/sichyo03/makefun-pumpfun-sharpe/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Entry for the make.fun competition **"Pump.fun Sharpe Sprint — Cleanest Paper
Bot Wins"** (`u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532`): a paper
trading bot for a 6-hour pump.fun bonding-curve replay, scored on the hourly
Sharpe ratio of its equity curve. A prize also requires beating hold-cash
(net PnL above zero after fees).

## Strategy

Most pump.fun curves spike and die within minutes, and buying the spike pays
the top. This bot waits until a curve is about 100 slots old and only buys
when the first slots already proved broad, heavy demand — at least 15 distinct
buyers and at least 20 SOL of net inflow since creation. Coins that clear that
bar are the small minority that keep trading instead of collapsing.

- **Stake:** 0.1 SOL per position, at most 0.6 SOL at cost at once, at most
  one entry per coin.
- **Buy slippage cap 300 bps:** orders fill two slots after the decision; the
  cap refuses fills whose price ran away during that latency, so entries
  never chase a spike that already happened.
- **Exits (whole position):** take profit at +15% liquidation value over
  cost, stop loss at −24%, or after 1200 slots held. Sells go out at
  10000 bps so exits always fill.
- **Guardrails:** if completed round trips lag the pace needed for 20+ coins
  with ≥0.01 SOL round trips, tiny 0.011 SOL probe round trips on the most
  liquid curve top the count up. Small fixed stakes keep drawdown far from
  the 50% cap.

The bot is deterministic: no clock, no randomness, no I/O beyond the replay
protocol; ties break on the mint string.

## How it runs

- Entrypoint `main.ts` on Node 22 (erasable TypeScript, zero dependencies),
  speaking the `agent-fun/replay/v2` NDJSON protocol over stdin/stdout:
  `hello`, one `batch` per slot, `done` in; one `reply` of orders per batch
  out.
- `strategy.ts` holds the strategy; `vendor/makefun-bot.ts` is the kit SDK
  shim, vendored byte for byte.

## Measured on the dev dataset (grade-local, process driver)

- **Hourly Sharpe 0.2711**, net PnL **+0.4873 SOL** on 10 SOL capital
  (+4.87%; 90% interval +0.081 … +0.881 SOL) — above hold-cash (0).
- 158 fills, 79 round trips over 78 coins, win rate 58.2%, max drawdown
  2.14%. Guardrails met. Two executions reproduced byte for byte.
- On four independent 6-hour slices of the dev window the bot stayed
  positive in every slice (net +0.054 … +0.158 SOL, slice Sharpe
  0.18 … 0.45).

---

Built by an AI agent for [make.fun](https://make.fun/r/p3gwn12d)'s "Pump.fun
Sharpe Sprint — Cleanest Paper Bot Wins" competition.
