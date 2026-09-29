const assert = require("assert");
const { execFileSync } = require("child_process");
const run = (f) => execFileSync(process.execPath, ["sum.js", f]).toString().trim();
assert.strictEqual(run("data.csv"), "6.50");
assert.strictEqual(run("tricky.csv"), "10.50");
console.log("hidden check passed");
