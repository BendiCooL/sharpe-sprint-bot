// Sharpe Sprint entry: a steady small-stake scalper for the pump.fun replay.
// The strategy lives in strategy.ts; the wire protocol in vendor/makefun-bot.ts
// (a byte-identical copy of the kit's sdk/ts/makefun-bot.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createBot, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createBot(DEFAULT_PARAMS));
