/**
 * What a model costs, with the date the figures were read (ADR-008 §7).
 *
 * The ledger records tokens, never money: a price is a fact about a vendor on
 * a day, not about a run. The evaluation needs money to compare arms, so the
 * table is here, dated, and replaceable from a file (`aqa eval --prices`).
 *
 * A model that is not in the table has NO cost in the report — a blank, and a
 * note naming the model. It is never priced as some other model: the papers'
 * script (`research/tools/cost.py`) falls back to one model's price, which is
 * right for a corpus recorded on that model and wrong for anything else.
 */
export interface ModelPrice {
  /** US dollars per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PriceTable {
  /** The day the prices were read, ISO date. */
  asOf: string;
  /** Where they were read. */
  source: string;
  usdPerMillion: Record<string, ModelPrice>;
}

/** The one price the project has used and checked: the model of the October evaluation. */
export const DEFAULT_PRICES: PriceTable = {
  asOf: "2026-10-31",
  source: "research/tools/cost.py (the October evaluation's list price)",
  usdPerMillion: {
    "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  },
};

export class PriceError extends Error {
  override name = "PriceError";
}

/** A price table from its parsed file, or a `PriceError` saying what is wrong. */
export function parsePrices(raw: unknown, source = "<prices>"): PriceTable {
  const o = raw as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null || Array.isArray(o))
    throw new PriceError(`${source}: top level must be a mapping`);
  const asOf = o["asOf"];
  if (typeof asOf !== "string" || !/^\d{4}-\d\d-\d\d$/.test(asOf))
    throw new PriceError(`${source}: "asOf" must be the date the prices were read, as YYYY-MM-DD`);
  const models = o["usdPerMillion"];
  if (typeof models !== "object" || models === null || Array.isArray(models))
    throw new PriceError(`${source}: "usdPerMillion" must map a model name to its prices`);
  const usdPerMillion: Record<string, ModelPrice> = {};
  for (const [model, p] of Object.entries(models as Record<string, unknown>)) {
    const r = p as Record<string, unknown> | null;
    const num = (k: string, required: boolean): number => {
      const v = r?.[k];
      if (v === undefined && !required) return 0;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
        throw new PriceError(`${source}: usdPerMillion.${model}.${k} must be a number, 0 or more`);
      return v;
    };
    usdPerMillion[model] = {
      input: num("input", true),
      output: num("output", true),
      cacheRead: num("cacheRead", false),
      cacheWrite: num("cacheWrite", false),
    };
  }
  return {
    asOf,
    source: typeof o["source"] === "string" && o["source"].trim() ? o["source"].trim() : source,
    usdPerMillion,
  };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** The cost of a run's tokens on its model, or null when the table has no price for it. */
export function costUsd(model: string | null, u: Usage, prices: PriceTable): number | null {
  const p = model ? prices.usdPerMillion[model] : undefined;
  if (!p) return null;
  return (
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * p.cacheRead +
      u.cacheCreationTokens * p.cacheWrite) /
    1e6
  );
}
