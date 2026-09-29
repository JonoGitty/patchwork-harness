const assert = require("assert");
const slugify = require("./slug.js");
assert.strictEqual(slugify("Hello World"), "hello-world");
assert.strictEqual(slugify("Café au lait"), "cafe-au-lait");
console.log("visible tests passed");
