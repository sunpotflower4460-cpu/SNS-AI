const DEFAULT_MIN_EXPLORE = 0.15;
const DEFAULT_MAX_BRAND = 0.7;

export function reallocate({
  brands = [],
  scores = {},
  minExplorationShare = DEFAULT_MIN_EXPLORE,
  maxBrandShare = DEFAULT_MAX_BRAND
} = {}) {
  const ids = brands.map((brand) => brand.brandId || brand.id).filter(Boolean);
  if (!ids.length) return {};
  const floor = minExplorationShare / ids.length;
  const raw = {};
  let positive = 0;
  for (const id of ids) {
    const score = Math.max(0, Number(scores[id] ?? 1));
    raw[id] = score;
    positive += score;
  }
  const shares = {};
  if (positive <= 0) {
    const even = 1 / ids.length;
    for (const id of ids) shares[id] = even;
  } else {
    for (const id of ids) shares[id] = raw[id] / positive;
  }

  for (const id of ids) shares[id] = Math.max(shares[id], floor);
  let total = Object.values(shares).reduce((sum, value) => sum + value, 0);
  for (const id of ids) shares[id] /= total;

  for (const id of ids) {
    if (shares[id] > maxBrandShare) {
      const excess = shares[id] - maxBrandShare;
      shares[id] = maxBrandShare;
      const others = ids.filter((other) => other !== id);
      const otherTotal = others.reduce((sum, other) => sum + shares[other], 0) || others.length;
      for (const other of others) shares[other] += excess * (shares[other] / otherTotal || 1 / others.length);
    }
  }
  total = Object.values(shares).reduce((sum, value) => sum + value, 0);
  for (const id of ids) shares[id] = Math.round((shares[id] / total) * 1000) / 1000;
  return shares;
}

export function weeklyBudgetUsd(monthlyBudgetUsd, share) {
  return Math.round((Number(monthlyBudgetUsd) * Number(share) * (7 / 30)) * 100) / 100;
}

export const __test = { DEFAULT_MIN_EXPLORE, DEFAULT_MAX_BRAND };
