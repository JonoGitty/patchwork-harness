const assert = require("assert");
const paginate = require("./paginate.js");
assert.deepStrictEqual(paginate(["a", "b", "c", "d", "e"], 1, 2), ["a", "b"]);
console.log("visible tests passed");
