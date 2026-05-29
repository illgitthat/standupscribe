const path = require("node:path");

const LOCAL_DATA_DIR_NAME = "local-data";
const PACKAGED_APP_DIR_NAME = "Standup Scribe";

function resolveConfiguredDataDir() {
  const configuredDir = String(process.env.STANDUPSCRIBE_DATA_DIR ?? "").trim();
  return configuredDir ? path.resolve(configuredDir) : "";
}

function resolvePackagedBaseDir() {
  const portableExecutableDir = String(process.env.PORTABLE_EXECUTABLE_DIR ?? "").trim();
  if (portableExecutableDir) {
    return path.resolve(portableExecutableDir);
  }

  const localAppDataDir = String(process.env.LOCALAPPDATA ?? "").trim();
  if (localAppDataDir) {
    return path.join(localAppDataDir, PACKAGED_APP_DIR_NAME);
  }

  const roamingAppDataDir = String(process.env.APPDATA ?? "").trim();
  if (roamingAppDataDir) {
    return path.join(roamingAppDataDir, PACKAGED_APP_DIR_NAME);
  }

  return path.dirname(process.execPath);
}

function resolveDataDir({ appDir, isPackaged }) {
  const configuredDir = resolveConfiguredDataDir();
  if (configuredDir) {
    return configuredDir;
  }
  const baseDir = isPackaged ? resolvePackagedBaseDir() : appDir;
  return path.join(baseDir, LOCAL_DATA_DIR_NAME);
}

module.exports = {
  LOCAL_DATA_DIR_NAME,
  resolveDataDir,
};
