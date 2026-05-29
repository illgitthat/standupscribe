const fs = require("node:fs");
const path = require("node:path");

const distDir = path.join(__dirname, "..", "dist");

if (!fs.existsSync(distDir)) {
  process.exit(0);
}

fs.rmSync(distDir, { recursive: true, force: true });
console.log(`Removed ${distDir}`);
