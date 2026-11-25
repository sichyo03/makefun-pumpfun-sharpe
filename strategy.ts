// Proven-demand scalper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// The score is the hourly Sharpe ratio of the equity curve, and a prize needs a net PnL above
// holding cash, so this bot trades small and often: many short round trips whose gains land
// evenly across hours, instead of a few large bets whose mark-to-market swings dominate an
// hour.
//
// Entry idea: most pump.fun curves spike and die within minutes, and buying the spike pays
// the top. Instead the bot waits until a curve is ~100 slots old and only buys when the first
// slots already proved broad, heavy demand — at least 15 distinct buyers and at least 20 SOL
// of net inflow since creation. Coins that clear that bar are the small minority that keep
// trading instead of collapsing, so a modest take-profit is reachable before the curve fades.
//
// Exits are mechanical: sell the whole position when its liquidation value reaches +15% over
// cost, when it falls 24% under cost, or after 1200 slots held, whichever comes first.
// Buys carry a tight 300 bps slippage cap: orders fill two slots after the decision, and the
// cap refuses fills whose price ran away during that latency, so entries never chase a spike
// that has already happened. Sells go out at 10000 bps so exits always fill.
//
// Fees set the bar: a round trip pays ~2.5% in curve fees plus two tx fees, so the take-profit
// sits well above that. Small fixed stakes (0.1 SOL, at most 0.6 SOL at cost at once) keep the
// drawdown far from the 50% guardrail cap.
//
// Guardrails: the run needs round trips of at least 0.01 SOL on at least 20 distinct coins.
// The strategy normally clears the coin count on its own; a pacing fallback opens tiny probe
// round trips on the most liquid curve only when the count lags the pace needed to reach 20
// within the first hours of block time.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration is over
// insertion-ordered maps fed by the batch stream, and ties break on the mint string.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots since the CreateEvent before a coin may be evaluated for entry. */
  entryAge: number;
  /** Slots since creation after which a coin is no longer considered. */
  maxEntryAge: number;
  /** Distinct non-creator buyers since creation required at entry. */
  minBuyers: number;
  /** Net SOL inflow (buys minus sells) since creation required at entry. */
  minNetSol: number;
  /** Curve real SOL reserve bounds at entry (SOL). */
  minRqSol: number;
  maxRqSol: number;
  /** Price now over price at creation, minus 1: largest run-up still allowed. */
  maxRunup: number;
  /** SOL per position (before the 1%-of-reserve cap). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage tolerance on buys (bps); sells always go out at 10000 so exits fill. */
  buySlipBps: number;
  /** Sell when liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Sell when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop: sell when value falls to peak * (1 - trail); arms at cost * (1 + trailArm).
   *  trailArm of 100 keeps the trailing stop effectively off. */
  trail: number;
  trailArm: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most SOL at cost across all positions at once (drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: aim for targetCoins round trips within paceSecs of block time. */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
}

export const DEFAULT_PARAMS: Params = {
  entryAge: 100,
  maxEntryAge: 400,
  minBuyers: 15,
  minNetSol: 20,
  minRqSol: 3,
  maxRqSol: 80,
  maxRunup: 100,
  stakeSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 300,
  takeProfit: 0.15,
  stopLoss: 0.24,
  trail: 0.15,
  trailArm: 100,
  maxHold: 1200,
  cooldown: 300,
  maxEntries: 1,
  maxExposureSol: 0.6,
  targetCoins: 24,
  paceSecs: 5 * 3600,
  probeSol: 0.011,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Coin {
  created: number;
  creator: string;
  createPrice: number;
  buyers: Set<string>;
  net: number;
  entries: number;
  lastExit: number;
  decided: boolean;
}

interface Held {
  opened: number;
  peak: number;
  exiting: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight: mint -> true once its sell has been sent. */
  const probes = new Map<Pubkey, boolean>();
  /** Mints with a completed round trip whose buys spent >= 0.01 SOL (guardrail count). */
  const doneCoins = new Set<Pubkey>();
  const tripSpend = new Map<Pubkey, number>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status !== 'filled') continue;
        if (f.side === 'buy' && !f.client_id.startsWith('_')) {
          tripSpend.set(f.mint, (tripSpend.get(f.mint) ?? 0) + Number(f.quote_lamports) / LAMPORTS);
        } else if (!state.positions.has(f.mint)) {
          // Any closing fill (ours, or a harness close) ends the round trip.
          if ((tripSpend.get(f.mint) ?? 0) >= 0.01) doneCoins.add(f.mint);
          tripSpend.delete(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            created: e.slot,
            creator: e.creator,
            createPrice: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
            buyers: new Set(),
            net: 0,
            entries: 0,
            lastExit: -1e12,
            decided: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = Number(e.sol_amount) / LAMPORTS;
          c.net += e.is_buy ? sol : -sol;
          if (e.is_buy && e.user !== c.creator) c.buyers.add(e.user);
          traded.add(e.mint);
        }
      }
      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const cur = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') cur.buy = true;
        else cur.sell = true;
        pendingByMint.set(po.order.mint, cur);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: every held position is valued at what closing it now would pay.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coins.get(mint);
            if (c !== undefined) c.lastExit = now;
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peak) h.peak = value;
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peak >= cost * (1 + p.trailArm) && value <= h.peak * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened >= p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.get(mint)?.sell) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe exits: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries: rank this batch's qualifying curves by net inflow, strongest first.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const mint of held.keys()) {
        const pos = state.positions.get(mint);
        if (pos !== undefined) exposure += Number(pos.cost_lamports) / LAMPORTS;
      }
      const candidates: { mint: Pubkey; score: number }[] = [];
      for (const mint of traded) {
        const c = coins.get(mint);
        if (c === undefined || c.decided) continue;
        const age = now - c.created;
        if (age < p.entryAge) continue;
        if (age > p.maxEntryAge) {
          c.decided = true;
          continue;
        }
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
        if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rq = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rq < p.minRqSol || rq > p.maxRqSol) continue;
        if (c.buyers.size < p.minBuyers || c.net < p.minNetSol) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (c.createPrice > 0 && price / c.createPrice - 1 > p.maxRunup) continue;
        candidates.push({ mint, score: c.net });
      }
      candidates.sort((a, b) => b.score - a.score || (a.mint < b.mint ? -1 : 1));
      for (const { mint } of candidates) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(p.stakeSol, capSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peak: 0, exiting: false });
        const c = coins.get(mint)!;
        c.entries++;
        c.decided = true;
        slotsLeft--;
      }

      // Guardrail pacing: a probe only when completed coins lag the pace to 20+ round trips.
      if (probes.size === 0 && slotsLeft > 0 && firstTime !== null && lastTime !== null && orders.length < cap) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const covered = doneCoins.size + held.size + probes.size;
        if (covered < Math.ceil(p.targetCoins * pace)) {
          let best: Pubkey | null = null;
          let bestRq = 0;
          for (const mint of traded) {
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint) || doneCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const rq = Number(curve.real_quote_reserves) / LAMPORTS;
            if (rq > bestRq) {
              bestRq = rq;
              best = mint;
            }
          }
          if (best !== null && free >= p.probeSol + 2 * tx && Number(state.maxBuyLamports(best)) / LAMPORTS >= p.probeSol) {
            orders.push({ side: 'buy', mint: best, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(best, false);
          }
        }
      }
      return orders;
    },
  };
}
