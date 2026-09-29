const assert = require("assert");
const paginate = require("./paginate.js");
const xs = ["a", "b", "c", "d", "e"];
assert.deepStrictEqual(paginate(xs, 1, 2), ["a", "b"]);
assert.deepStrictEqual(paginate(xs, 3, 2), ["e"]);
assert.deepStrictEqual(paginate(xs, 4, 2), []);
assert.deepStrictEqual(paginate(xs, 0, 2), []);
assert.deepStrictEqual(paginate(xs, -1, 2), []);
console.log("hidden check passed");
