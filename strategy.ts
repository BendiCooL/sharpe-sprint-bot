// Sharpe Sprint bot: a launch scalper for the pump.fun bonding-curve replay.
//
// What the dev window's own tape teaches: a new coin's price is made in its first few slots.
// A launch opens with a burst of buys, and the burst is usually the creator's own cluster
// buying in to paint the chart before it dumps — the more wallets pile in at launch, and the
// bigger the creator's own buy, the harder the dump that follows. Coins that open quietly, with
// at most a couple of outside buyers and a creator who has not sold, are the only ones whose
// opening burst sometimes keeps running. So this bot watches every coin from its CreateEvent,
// reads its opening tape for at most three slots, and buys only the quiet launches: at most
// one outside buyer, a small creator buy, no selling yet. It stakes up to 0.1 SOL (the 1%
// reserve cap usually binds first), takes profit fast at +50%, cuts at -20%, never holds past
// 4 slots, and leaves at once if the creator sells. One trip per coin, never a pyramid, at
// most 5 open at once.
//
// That keeps the equity curve built from many small, short, roughly independent scalps instead
// of a few big bets, which is what an hourly Sharpe ratio rewards — and it keeps the drawdown
// tiny (about 1% on the dev window), far inside the 50% guardrail. The pilot momentum bot, by
// contrast, pyramids into strength and loses 94% of its capital on the same window.
//
// Deterministic by construction: no clock, no environment, no randomness; iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the opening tape: at most this much SOL. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys and sells (bps); wide open, the burst moves faster than any tight cap. */
  buySlipBps: number;
  sellSlipBps: number;
  /** Take profit: sell when the position's net value is this far above cost. */
  takeProfit: number;
  /** Stop loss: sell when the position's net value is this far below cost. */
  stopLoss: number;
  /** Never hold past this many slots. */
  maxHoldSlots: number;
  /** Leave at once when the creator sells. */
  exitOnDevSell: boolean;
}

/** The settings this entry trades with. */
export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeSol: 0.1,
  minBuySol: 0.01,
  minRealSol: 0.3,
  maxRealSol: 30,
  maxDevBuySol: 2.5,
  maxBuyers: 1,
  skipDevSold: true,
  buySlipBps: 10000,
  sellSlipBps: 10000,
  takeProfit: 0.5,
  stopLoss: 0.2,
  maxHoldSlots: 4,
  exitOnDevSell: true,
};

const LAMPORTS = 1e9;
/** Protocol + creator curve fee on a trade, as a share of the quote. */
const CURVE_FEE = 0.0125;
/** A buy also pays this many lamports of transaction fee; a sell pays it too. */
const TX_FEE_SOL = 105000 / LAMPORTS;

interface Coin {
  /** Slot of the CreateEvent. */
  createSlot: number;
  /** The coin's creator. */
  creator: string;
  /** Price (SOL per token) at creation. */
  createPrice: number;
  /** SOL the creator bought in the opening tape. */
  devBuySol: number;
  /** Distinct non-creator wallets that bought in the opening tape. */
  buyers: Set<string>;
  /** The creator sold at least once. */
  devSold: boolean;
  /** A non-creator wallet sold at least once. */
  soldByOthers: boolean;
  /** A buy has been sent for this coin; only one trip per coin. */
  entered: boolean;
  /** Slot the buy was decided on. */
  entrySlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  /** A sell is in flight for this coin. */
  sellPending: boolean;
}

/** Current price of a curve in SOL per token, from its virtual reserves. */
function priceOf(state: BotState, mint: Pubkey): number {
  const c = state.curves.get(mint);
  if (c === undefined) return 0;
  const vt = Number(c.virtual_token_reserves);
  const vq = Number(c.virtual_quote_reserves);
  if (vt <= 0 || vq <= 0) return 0;
  return vq / vt;
}

/** Net SOL a full sell of `tokens` would return now, after curve fees and the tx fee. */
function netSellValue(state: BotState, mint: Pubkey, tokens: bigint): number {
  const p = priceOf(state, mint);
  if (p <= 0) return 0;
  // priceOf is lamports per token base unit, so tokens * price is lamports.
  const grossLamports = Number(tokens) * p;
  return (grossLamports * (1 - CURVE_FEE)) / LAMPORTS - TX_FEE_SOL;
}

export function createBot(p: Params): Bot {
  const coins = new Map<Pubkey, Coin>();

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const txFee = Number(state.txFeeLamports()) / LAMPORTS;

      // Read this batch's tape into the coins watched from their CreateEvent.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const vt = Number(e.virtual_token_reserves);
          const vq = Number(e.virtual_sol_reserves);
          if (vt > 0 && vq > 0) {
            coins.set(e.mint, {
              createSlot: e.slot,
              creator: e.creator,
              createPrice: vq / vt,
              devBuySol: 0,
              buyers: new Set<string>(),
              devSold: false,
              soldByOthers: false,
              entered: false,
              entrySlot: 0,
              done: false,
              sellPending: false,
            });
          }
          continue;
        }
        if (e.event !== 'TradeEvent') continue;
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = Number(e.sol_amount) / LAMPORTS;
        if (e.user === c.creator) {
          if (e.is_buy) c.devBuySol += sol;
          else c.devSold = true;
        } else {
          if (e.is_buy) c.buyers.add(e.user);
          else c.soldByOthers = true;
        }
      }

      // A buy that came back rejected or failed frees its coin for another try
      // while it is still young enough.
      for (const f of batch.fills) {
        if (f.side === 'buy' && f.status !== 'filled') {
          const c = coins.get(f.mint);
          if (c !== undefined) c.entered = false;
        }
        if (f.side === 'sell' && f.status === 'filled') {
          const c = coins.get(f.mint);
          if (c !== undefined) {
            c.sellPending = false;
            c.done = true;
          }
        }
      }

      // Exits: every held position is checked against its profit target, stop
      // loss, time limit, and whether its creator just sold.
      for (const [mint, holding] of state.positions) {
        const c = coins.get(mint);
        if (c === undefined || c.sellPending) continue;
        const cost = Number(holding.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        const value = netSellValue(state, mint, holding.token_amount);
        const ret = value / cost - 1;
        const timedOut = state.slot - c.entrySlot >= p.maxHoldSlots;
        if (
          ret >= p.takeProfit ||
          ret <= -p.stopLoss ||
          timedOut ||
          (p.exitOnDevSell && c.devSold)
        ) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: p.sellSlipBps,
          });
          c.sellPending = true;
        }
      }

      // Entries: only coins still in their first few slots that pass the rug
      // filter — few outside buyers, a small creator buy, no selling yet.
      let slots = 5 - state.committedPositionCount();
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      for (const [mint, c] of coins) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (c.done || c.entered) continue;
        const age = state.slot - c.createSlot;
        if (age < p.minAge || age > p.maxAge) {
          if (age > p.maxAge) c.done = true;
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) {
          c.done = true;
          continue;
        }
        if (c.buyers.size > p.maxBuyers) continue;
        if (c.devBuySol > p.maxDevBuySol) continue;
        if (p.skipDevSold && c.devSold) continue;
        if (c.soldByOthers) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (realSol < p.minRealSol || realSol > p.maxRealSol) continue;
        if (slots <= 0) continue;
        const cap = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        const amount = Math.min(p.stakeSol, cap);
        if (amount < p.minBuySol || free < amount + txFee) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        c.entered = true;
        c.entrySlot = state.slot;
        free -= amount + txFee;
        slots -= 1;
      }
      return orders;
    },
  };
}
