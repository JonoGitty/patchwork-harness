/**
 * One price source for every provider adapter: config/models.yml is the
 * catalog of record, the adapters' hard-coded tables are the fallback for
 * ids the catalog does not list (e.g. dated snapshots). Before 7 Sept 2026
 * each adapter carried its own stale table, so a model missing from it
 * (claude-opus-5, gpt-5.6-*) reported no cost and the bedrock never moved.
 *
 * Longest matching catalog id wins so `gpt-5.6-sol` beats `gpt-5.6`.
 * A catalog entry whose price is `unknown` yields null: no spend recorded,
 * and the executor logs that the model's price is unknown.
 */
import { loadModels } from "../config.js";

export interface Price {
  in: number;
  out: number;
}

let catalog: Array<{ id: string; in: number | null; out: number | null }> | null = null;

function loadCatalog(): NonNullable<typeof catalog> {
  if (catalog) return catalog;
  try {
    catalog = loadModels().models.map((m) => ({
      id: m.id,
      in: m.cost_per_m_in,
      out: m.cost_per_m_out,
    }));
  } catch {
    catalog = [];
  }
  return catalog;
}

/** Test seam. */
export function resetPricingCache(): void {
  catalog = null;
}

/**
 * Price for a model id: exact catalog match, then the longest catalog id
 * that is a prefix of `model` (dated snapshots), then the adapter's own
 * table by prefix. `null` when the price is unknown everywhere.
 */
export function priceForModel(model: string, fallback: Record<string, Price> = {}): Price | null {
  const cat = loadCatalog();
  const exact = cat.find((c) => c.id === model);
  const hit =
    exact ?? cat.filter((c) => model.startsWith(c.id)).sort((a, b) => b.id.length - a.id.length)[0];
  if (hit) return hit.in === null || hit.out === null ? null : { in: hit.in, out: hit.out };
  const keys = Object.keys(fallback).sort((a, b) => b.length - a.length);
  for (const k of keys) if (model.startsWith(k)) return fallback[k]!;
  return null;
}

export function costUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
  fallback?: Record<string, Price>,
): number | undefined {
  const p = priceForModel(model, fallback);
  if (!p) return undefined;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}
