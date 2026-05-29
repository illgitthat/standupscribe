const fs = require("node:fs");
const path = require("node:path");

const unpackedDir = path.join(__dirname, "..", "dist", "win-unpacked");

if (!fs.existsSync(unpackedDir)) {
  process.exit(0);
}

fs.rmSync(unpackedDir, { recursive: true, force: true });
console.log(`Removed ${unpackedDir}`);
