const assert = require("assert");
const { execFileSync } = require("child_process");
const out = execFileSync(process.execPath, ["sum.js", "data.csv"]).toString().trim();
assert.strictEqual(out, "6.50");
console.log("visible tests passed");
