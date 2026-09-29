const fs = require("fs");
// Split one CSV line, honouring double-quoted fields that contain commas.
function parseLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
const lines = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter((l) => l.trim());
const col = parseLine(lines[0]).findIndex((h) => h.trim().toLowerCase() === "amount");
const total = lines.slice(1).reduce((sum, l) => sum + Number(parseLine(l)[col]), 0);
console.log(total.toFixed(2));
