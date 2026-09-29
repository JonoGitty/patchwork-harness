// parseDuration("1h30m") -> 5400. See SPEC.md.
module.exports = function parseDuration(s) {
  const t = String(s);
  if (!t) throw new Error("empty duration");
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m) throw new Error(`bad duration: ${s}`);
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
};
