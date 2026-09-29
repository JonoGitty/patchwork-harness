// parseDuration("1h30m") -> 5400. See SPEC.md.
module.exports = function parseDuration(s) {
  const t = String(s).trim();
  if (!t) throw new Error("empty duration");
  if (/^\d+$/.test(t)) return Number(t);
  const re = /(\d+)\s*([hms])\s*/giy;
  let total = 0;
  let used = 0;
  let m;
  while ((m = re.exec(t))) {
    total += Number(m[1]) * { h: 3600, m: 60, s: 1 }[m[2].toLowerCase()];
    used = re.lastIndex;
  }
  if (used !== t.length) throw new Error(`bad duration: ${s}`);
  return total;
};
