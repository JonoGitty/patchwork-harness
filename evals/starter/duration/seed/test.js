const assert = require("assert");
const parseDuration = require("./duration.js");
assert.strictEqual(parseDuration("1h30m"), 5400);
assert.strictEqual(parseDuration("45s"), 45);
console.log("visible tests passed");
