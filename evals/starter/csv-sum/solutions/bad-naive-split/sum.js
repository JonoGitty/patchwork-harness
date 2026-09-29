const fs = require("fs");
const lines = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter((l) => l.trim());
const header = lines[0].split(",");
const col = header.findIndex((h) => h.trim().toLowerCase() === "amount");
const total = lines.slice(1).reduce((sum, l) => sum + Number(l.split(",")[col]), 0);
console.log(total.toFixed(2));
