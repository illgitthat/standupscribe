const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, Menu, dialog, shell, session, desktopCapturer } = require("electron");

const { loadDotEnvFiles } = require("./env");
const { resolveDataDir } = require("./paths");
const { startServers, UI_PORT } = require("./server");

app.setName("Standup Scribe");

const APP_DIR = path.join(__dirname, "..");
const DATA_DIR = resolveDataDir({ appDir: APP_DIR, isPackaged: app.isPackaged });
const UI_DIR = path.join(APP_DIR, "ui");
const WINDOW_ICON_PATH = path.join(UI_DIR, "assets", "standup-scribe-icon-256.png");
const ELECTRON_USER_DATA_DIR = path.join(DATA_DIR, "electron-user-data");
const ELECTRON_SESSION_DATA_DIR = path.join(DATA_DIR, "electron-session-data");

function configureElectronStoragePaths() {
  fs.mkdirSync(ELECTRON_USER_DATA_DIR, { recursive: true });
  fs.mkdirSync(ELECTRON_SESSION_DATA_DIR, { recursive: true });
  app.setPath("userData", ELECTRON_USER_DATA_DIR);
  app.setPath("sessionData", ELECTRON_SESSION_DATA_DIR);
}

configureElectronStoragePaths();

let mainWindow = null;
let servers = null;
let serverClosePromise = null;
let logFilePath = null;
let consoleLogEnabled = false;
let brokenPipeLogged = false;

function disableConsoleLoggingOnBrokenPipe(error) {
  if (error?.code === "EPIPE") {
    consoleLogEnabled = false;
  }
}

process.stdout?.on?.("error", disableConsoleLoggingOnBrokenPipe);
process.stderr?.on?.("error", disableConsoleLoggingOnBrokenPipe);

function handleBrokenPipe(error, message) {
  if (error?.code !== "EPIPE") {
    return false;
  }
  disableConsoleLoggingOnBrokenPipe(error);
  if (!brokenPipeLogged) {
    brokenPipeLogged = true;
    logLine(message);
  }
  return true;
}

function shouldLogToConsole() {
  const configured = String(process.env.STANDUPSCRIBE_LOG_TO_STDOUT ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(configured)) {
    return true;
  }
  if (["0", "false", "off", "no"].includes(configured)) {
    return false;
  }
  return !app.isPackaged;
}

function writeConsoleLine(stream, line) {
  if (!consoleLogEnabled || !stream?.writable || stream.destroyed) {
    return;
  }
  try {
    stream.write(`${line}\n`);
  } catch {
    consoleLogEnabled = false;
  }
}

function logLine(message, error) {
  try {
    const timestamp = new Date().toISOString();
    const suffix = error ? ` ${error instanceof Error ? error.stack ?? error.message : String(error)}` : "";
    const line = `[${timestamp}] ${message}`;
    if (consoleLogEnabled) {
      writeConsoleLine(error ? process.stderr : process.stdout, `${line}${suffix}`);
    }
    if (logFilePath) {
      fs.appendFileSync(logFilePath, `${line}${suffix}\n`, "utf8");
    }
  } catch {
  }
}

process.on("uncaughtException", (error) => {
  if (handleBrokenPipe(error, "stdout/stderr pipe closed; disabling console mirroring")) {
    return;
  }
  logLine("uncaughtException", error);
});

process.on("unhandledRejection", (error) => {
  if (handleBrokenPipe(error, "stdout/stderr pipe closed during rejection handling; disabling console mirroring")) {
    return;
  }
  logLine("unhandledRejection", error);
});

async function closeServers(reason = "shutdown") {
  if (!servers) {
    return;
  }
  if (serverClosePromise) {
    return serverClosePromise;
  }
  const activeServers = servers;
  servers = null;
  serverClosePromise = activeServers.close().catch((error) => {
    logLine(`failed to close local services during ${reason}`, error);
    throw error;
  }).finally(() => {
    serverClosePromise = null;
  });
  return serverClosePromise;
}

function createWindow() {
  logLine("creating browser window");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    autoHideMenuBar: true,
    backgroundColor: "#f7efe4",
    icon: fs.existsSync(WINDOW_ICON_PATH) ? WINDOW_ICON_PATH : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url && (url.startsWith("https://") || url.startsWith("http://"))) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  Menu.setApplicationMenu(null);

  try {
    mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
        if (sources.length === 0) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: "loopback" });
      }).catch((error) => {
        logLine("setDisplayMediaRequestHandler failed", error);
        callback({});
      });
    }, { useSystemPicker: false });
  } catch (error) {
    logLine("could not install displayMedia handler", error);
  }

  void mainWindow.loadURL(`http://127.0.0.1:${UI_PORT}/realtime-test.html`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function boot() {
  consoleLogEnabled = !app.isPackaged;
  const loadedEnvFiles = loadDotEnvFiles({
    appDir: APP_DIR,
    dataDir: DATA_DIR,
    logger: (message, error) => logLine(message, error),
  });
  consoleLogEnabled = shouldLogToConsole();
  logFilePath = path.join(DATA_DIR, "standupscribe-startup.log");
  logLine("booting StandupScribe");
  logLine(`resolved appDir=${APP_DIR}`);
  logLine(`resolved uiDir=${UI_DIR}`);
  logLine(`resolved dataDir=${DATA_DIR}`);
  logLine(`resolved electron userData=${app.getPath("userData")}`);
  logLine(`resolved electron sessionData=${app.getPath("sessionData")}`);
  logLine(`log file=${logFilePath}`);
  if (loadedEnvFiles.length > 0) {
    logLine(`loaded env files: ${loadedEnvFiles.join(", ")}`);
  } else {
    logLine("loaded env files: none");
  }
  logLine(
    [
      `llm base url=${process.env.STANDUPSCRIBE_LLM_BASE_URL || "(unset)"}`,
      `llm api style=${process.env.STANDUPSCRIBE_LLM_API_STYLE || "(unset)"}`,
      `llm model=${process.env.STANDUPSCRIBE_LLM_MODEL || "(unset)"}`,
      `llm key header=${process.env.STANDUPSCRIBE_LLM_API_KEY_HEADER || "(unset)"}`,
      `llm api key configured=${process.env.STANDUPSCRIBE_LLM_API_KEY ? "yes" : "no"}`,
    ].join(" | "),
  );

  try {
    servers = await startServers({
      uiDir: UI_DIR,
      dataDir: DATA_DIR,
      openPath: (targetPath) => shell.openPath(targetPath),
      logger: (message) => logLine(message),
    });
    logLine("local services started");
  } catch (error) {
    logLine("failed to start local StandupScribe services", error);
    await dialog.showMessageBox({
      type: "error",
      title: "Standup Scribe",
      message: "Failed to start local Standup Scribe services.",
      detail: error instanceof Error ? error.message : String(error),
    });
    app.quit();
    return;
  }

  createWindow();
}

app.whenReady().then(boot);

app.on("before-quit", () => {
  logLine("before-quit");
  void closeServers("before-quit");
});

app.on("window-all-closed", async () => {
  logLine("window-all-closed");
  await closeServers("window-all-closed");
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
