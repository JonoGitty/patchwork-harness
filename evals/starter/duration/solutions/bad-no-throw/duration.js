// parseDuration("1h30m") -> 5400. See SPEC.md.
module.exports = function parseDuration(s) {
  const t = String(s).trim();
  if (/^\d+$/.test(t)) return Number(t);
  let total = 0;
  for (const [, n, u] of t.matchAll(/(\d+)\s*([a-z])/gi)) {
    total += Number(n) * ({ h: 3600, m: 60, s: 1 }[u.toLowerCase()] ?? 0);
  }
  return total;
};
