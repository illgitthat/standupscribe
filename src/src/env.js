const fs = require("node:fs");
const path = require("node:path");

function stripInlineComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? null : (quote ?? char);
      continue;
    }
    if (char === "#" && quote === null) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function unquoteValue(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      const inner = trimmed.slice(1, -1);
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, "\\");
    }
  }
  return trimmed;
}

function parseEnvFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const entries = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = rawLine.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = rawLine.slice(0, separator).trim();
    if (!key || /[^A-Za-z0-9_]/u.test(key)) {
      continue;
    }
    const rawValue = stripInlineComment(rawLine.slice(separator + 1));
    entries[key] = unquoteValue(rawValue);
  }
  return entries;
}

function loadDotEnvFiles({ appDir, dataDir, logger = () => {} }) {
  const candidateFiles = [
    path.join(appDir, ".env"),
    path.join(appDir, ".env.local"),
    path.join(dataDir, ".env"),
    path.join(dataDir, ".env.local"),
  ];
  const loadedFiles = [];
  const fileValues = {};

  for (const filePath of candidateFiles) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      continue;
    }
    try {
      Object.assign(fileValues, parseEnvFile(filePath));
      loadedFiles.push(filePath);
    } catch (error) {
      logger(`failed to parse env file ${filePath}`, error);
    }
  }

  for (const [key, value] of Object.entries(fileValues)) {
    if (typeof process.env[key] === "undefined" || process.env[key] === "") {
      process.env[key] = value;
    }
  }

  return loadedFiles;
}

module.exports = {
  loadDotEnvFiles,
};
