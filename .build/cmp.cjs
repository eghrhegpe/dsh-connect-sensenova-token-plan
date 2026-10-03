const fs = require("fs");
const a = fs.readFileSync("client.js","utf8").split("\n");
const b = fs.readFileSync("tmp/package/client.js","utf8").split("\n");
console.log("local lines:", a.length, "| npm lines:", b.length);
let diffs = 0;
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) {
    diffs++;
    if (diffs <= 6) {
      console.log("\n--- line " + (i+1) + " ---");
      console.log("local:", JSON.stringify(a[i] == null ? "<EOF>" : a[i]).slice(0,200));
      console.log("npm  :", JSON.stringify(b[i] == null ? "<EOF>" : b[i]).slice(0,200));
    }
  }
}
console.log("\ntotal differing line positions:", diffs);
