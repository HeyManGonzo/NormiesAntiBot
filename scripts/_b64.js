// One-off helper: read source files and emit base64 to ./scripts/_out/*.b64
// Used to prepare payloads for the GitHub Contents API.
const fs = require("fs");
const path = require("path");

const FILES = [
  ".gitignore",
  "package.json",
  "package-lock.json",
  "server.js",
  "public/index.html",
  "public/app.js",
];

const outDir = path.join(__dirname, "_out");
fs.mkdirSync(outDir, { recursive: true });

for (const f of FILES) {
  const abs = path.join(__dirname, "..", f);
  if (!fs.existsSync(abs)) {
    console.log("MISSING", f);
    continue;
  }
  const buf = fs.readFileSync(abs);
  const safe = f.replace(/[\\/]/g, "__");
  fs.writeFileSync(path.join(outDir, safe + ".b64"), buf.toString("base64"));
  console.log("OK", f, buf.length, "bytes");
}
