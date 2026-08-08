import { round } from '../util/stats.js';

/**
 * Weighted-moving-average inventory ledger.
 *
 * Walking every ingredient's history once gives us three things that would
 * otherwise need separate passes:
 *
 *   1. the unit cost in force on any given day (purchases change it),
 *   2. the money value of each day's usage,
 *   3. the theoretical ("book") stock on hand at the close of each day.
 *
 * Costing is weighted average rather than FIFO: kitchens restock the same
 * items constantly and nobody tracks which crate a tomato came from, so the
 * average is both cheaper to compute and closer to how a chef reasons about it.
 *
 * Negative book stock is possible when a delivery was never keyed in. We keep
 * the negative number instead of clamping it — it is a signal worth surfacing,
 * and the stock report flags it.
 */
export function buildLedger({ ingredients, purchases = [], usage = [] }) {
  const byIngredient = new Map();

  for (const ing of ingredients) {
    byIngredient.set(ing.id, {
      ingredient: ing,
      events: new Map(), // day -> { purchases: [], used: number }
      days: new Map(), // day -> entry
      closing: null,
    });
  }

  const eventFor = (ingredientId, day) => {
    const rec = byIngredient.get(ingredientId);
    if (!rec) return null;
    let ev = rec.events.get(day);
    if (!ev) {
      ev = { purchases: [], used: 0, hasUsage: false };
      rec.events.set(day, ev);
    }
    return ev;
  };

  for (const p of purchases) {
    const ev = eventFor(p.ingredient_id, p.day);
    if (ev) ev.purchases.push({ qty: Number(p.qty) || 0, unitCost: Number(p.unit_cost) || 0 });
  }

  for (const u of usage) {
    const ev = eventFor(u.ingredient_id, u.day);
    if (ev) {
      ev.used += Number(u.qty) || 0;
      ev.hasUsage = true;
    }
  }

  for (const rec of byIngredient.values()) {
    const ing = rec.ingredient;
    let stock = Number(ing.opening_stock) || 0;
    let avgCost = Number(ing.default_unit_cost) || 0;
    let value = stock * avgCost;

    const days = [...rec.events.keys()].sort();
    for (const day of days) {
      const ev = rec.events.get(day);

      let purchasedQty = 0;
      let purchasedCost = 0;
      for (const p of ev.purchases) {
        purchasedQty += p.qty;
        purchasedCost += p.qty * p.unitCost;
      }

      if (purchasedQty > 0) {
        stock += purchasedQty;
        value += purchasedCost;
        // Only re-derive the average while stock is positive; a negative book
        // stock would otherwise invert the cost.
        if (stock > 1e-9) avgCost = value / stock;
        else avgCost = purchasedCost / purchasedQty;
      }

      const usedQty = ev.used;
      const usedCost = usedQty * avgCost;
      stock -= usedQty;
      value -= usedCost;
      if (stock <= 1e-9) value = stock * avgCost; // keep value consistent at/below zero

      rec.days.set(day, {
        day,
        purchasedQty: round(purchasedQty, 4),
        purchasedCost: round(purchasedCost, 4),
        usedQty: round(usedQty, 4),
        usedCost: round(usedCost, 4),
        unitCost: round(avgCost, 4),
        closingStock: round(stock, 4),
        hasUsage: ev.hasUsage,
      });
    }

    rec.closing = {
      stock: round(stock, 4),
      unitCost: round(avgCost, 4),
      value: round(stock * avgCost, 2),
      lastDay: days.length ? days[days.length - 1] : null,
    };
  }

  return {
    /** Ledger entry for one ingredient on one day, or null. */
    entry(ingredientId, day) {
      return byIngredient.get(ingredientId)?.days.get(day) ?? null;
    },
    /** Money value of an ingredient's usage on a day. */
    cost(ingredientId, day) {
      return byIngredient.get(ingredientId)?.days.get(day)?.usedCost ?? 0;
    },
    /** Unit cost in force on a day (walks back to the last known price). */
    unitCostOn(ingredientId, day) {
      const rec = byIngredient.get(ingredientId);
      if (!rec) return 0;
      const hit = rec.days.get(day);
      if (hit) return hit.unitCost;
      let best = Number(rec.ingredient.default_unit_cost) || 0;
      for (const [d, entry] of rec.days) {
        if (d <= day) best = entry.unitCost;
        else break;
      }
      return best;
    },
    /** Book stock at the close of `day` (walks back to the last movement). */
    stockOn(ingredientId, day) {
      const rec = byIngredient.get(ingredientId);
      if (!rec) return 0;
      let stock = Number(rec.ingredient.opening_stock) || 0;
      for (const [d, entry] of rec.days) {
        if (d <= day) stock = entry.closingStock;
        else break;
      }
      return stock;
    },
    closing(ingredientId) {
      return byIngredient.get(ingredientId)?.closing ?? { stock: 0, unitCost: 0, value: 0, lastDay: null };
    },
    ingredientIds() {
      return [...byIngredient.keys()];
    },
  };
}
