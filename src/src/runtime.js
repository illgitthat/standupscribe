const path = require("node:path");

const {
  AdoBridge,
  DEFAULT_DOMAINS: DEFAULT_ADO_DOMAINS,
  DEFAULT_ORGANIZATION: DEFAULT_ADO_ORGANIZATION,
  DEFAULT_TENANT_ID: DEFAULT_ADO_TENANT_ID,
  buildSafeToolInvocation,
} = require("./ado-mcp/ado-bridge");

function readSettingValue(settings, keyPath, fallback = undefined) {
  if (!settings || typeof settings !== "object") {
    return fallback;
  }
  if (Object.prototype.hasOwnProperty.call(settings, keyPath)) {
    const directValue = settings[keyPath];
    return directValue === undefined ? fallback : directValue;
  }
  const segments = String(keyPath ?? "").split(".").filter(Boolean);
  let current = settings;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return fallback;
    }
    current = current[segment];
  }
  return current === undefined ? fallback : current;
}

function readStringSetting(settings, keyPath, fallback = "") {
  const value = readSettingValue(settings, keyPath, fallback);
  const normalized = String(value ?? "").trim();
  return normalized || String(fallback ?? "").trim();
}

function readBooleanSetting(settings, keyPath, fallback = false) {
  const value = readSettingValue(settings, keyPath, fallback);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return Boolean(fallback);
}

function normalizeAdoMode(mode) {
  return String(mode ?? "read-only").trim().toLowerCase() === "read-write" ? "read-write" : "read-only";
}

function getDefaultAzureConfigDir(dataDir) {
  return path.join(dataDir, "az-standupscribe");
}

function buildAdoBridgeConfig({ dataDir, logger = () => {}, settings = {} }) {
  return {
    authMethod: "azcli",
    azureConfigDir: readStringSetting(settings, "ado.azureConfigDir", getDefaultAzureConfigDir(dataDir)),
    domains: DEFAULT_ADO_DOMAINS,
    logger,
    mode: normalizeAdoMode(readStringSetting(settings, "ado.mode", "read-only")),
    organization: readStringSetting(settings, "ado.organization", DEFAULT_ADO_ORGANIZATION),
    project: readStringSetting(settings, "ado.project", ""),
    tenantId: readStringSetting(settings, "ado.tenantId", DEFAULT_ADO_TENANT_ID),
  };
}

function serializeAdoBridgeConfig(config) {
  return JSON.stringify({
    authMethod: String(config?.authMethod ?? ""),
    azureConfigDir: String(config?.azureConfigDir ?? ""),
    domains: Array.isArray(config?.domains) ? config.domains : [],
    mode: normalizeAdoMode(config?.mode),
    organization: String(config?.organization ?? ""),
    project: String(config?.project ?? ""),
    tenantId: String(config?.tenantId ?? ""),
  });
}

class AppRuntime {
  constructor({ dataDir, store, logger = () => {} }) {
    this.dataDir = dataDir;
    this.store = store;
    this.logger = logger;
    this.activeMeetingId = null;
    this.adoBridge = null;
    this.adoBridgeConfigKey = "";
  }

  getAdoSettings() {
    const settings = this.store.getSettings() ?? {};
    return {
      azureConfigDir: readStringSetting(settings, "ado.azureConfigDir", getDefaultAzureConfigDir(this.dataDir)),
      enabled: readBooleanSetting(settings, "ado.enabled", false),
      mode: normalizeAdoMode(readStringSetting(settings, "ado.mode", "read-only")),
      organization: readStringSetting(settings, "ado.organization", DEFAULT_ADO_ORGANIZATION),
      project: readStringSetting(settings, "ado.project", ""),
      tenantId: readStringSetting(settings, "ado.tenantId", DEFAULT_ADO_TENANT_ID),
    };
  }

  createAdoBridge(config) {
    return new AdoBridge(config);
  }

  async getAdoBridge({ start = false } = {}) {
    const settings = this.store.getSettings() ?? {};
    if (!readBooleanSetting(settings, "ado.enabled", false)) {
      await this.stopAdoBridge("ado-disabled", { dispose: true });
      return null;
    }

    const config = buildAdoBridgeConfig({
      dataDir: this.dataDir,
      logger: (message) => this.logger(message),
      settings,
    });
    const configKey = serializeAdoBridgeConfig(config);

    if (!this.adoBridge || this.adoBridgeConfigKey !== configKey) {
      await this.stopAdoBridge("ado-config-updated", { dispose: true });
      this.adoBridge = this.createAdoBridge(config);
      this.adoBridgeConfigKey = configKey;
    }

    if (start) {
      await this.adoBridge.start();
    }

    return this.adoBridge;
  }

  async refreshAdoBridgeFromSettings(reason = "settings-updated") {
    const adoSettings = this.getAdoSettings();
    if (!adoSettings.enabled) {
      await this.stopAdoBridge(reason, { dispose: true });
      return null;
    }
    const bridge = await this.getAdoBridge();
    if (this.getActiveMeeting()) {
      await bridge?.start();
    }
    return bridge;
  }

  async stopAdoBridge(reason = "ado-stopped", { dispose = false } = {}) {
    const bridge = this.adoBridge;
    if (!bridge) {
      return;
    }
    this.logger(`ado bridge stopping reason=${reason}`);
    if (dispose) {
      this.adoBridge = null;
      this.adoBridgeConfigKey = "";
    }
    await bridge.stop();
  }

  async ensureAdoBridgeForActiveMeeting(reason = "meeting-started") {
    if (!this.getActiveMeeting()) {
      await this.stopAdoBridge(reason);
      return null;
    }
    return this.getAdoBridge({ start: true });
  }

  async getAdoStatus() {
    const adoSettings = this.getAdoSettings();
    if (!adoSettings.enabled) {
      return {
        enabled: false,
        mode: adoSettings.mode,
        running: false,
        toolCount: 0,
      };
    }
    const bridge = await this.getAdoBridge();
    const status = {
      enabled: true,
      mode: bridge?.config.mode ?? adoSettings.mode,
      running: Boolean(bridge?.running),
      toolCount: Number(bridge?.toolCount ?? 0),
    };
    if (bridge?.lastError) {
      status.error = bridge.lastError;
    }
    return status;
  }

  async listAdoTools() {
    const bridge = await this.getAdoBridge({ start: true });
    if (!bridge) {
      return [];
    }
    return bridge.getTools();
  }

  async testAdoConnection() {
    const bridge = await this.getAdoBridge({ start: true });
    if (!bridge) {
      throw new Error("Azure DevOps integration is disabled.");
    }
    const tools = await bridge.getTools();
    const safeTool = buildSafeToolInvocation(tools, { project: bridge.config.project });
    if (!safeTool) {
      throw new Error("No safe read-only Azure DevOps MCP tool is available for connection testing.");
    }
    const result = await bridge.callTool(safeTool.name, safeTool.args);
    return {
      args: safeTool.args,
      mode: bridge.config.mode,
      ok: true,
      result,
      tool: safeTool.name,
      toolCount: tools.length,
    };
  }

  setActiveMeeting(meetingId) {
    const meeting = this.store.getMeeting(meetingId);
    this.activeMeetingId = meeting ? meeting.meeting_id : null;
    if (meeting) {
      void this.ensureAdoBridgeForActiveMeeting("meeting-started");
    }
    return meeting;
  }

  getActiveMeeting() {
    if (!this.activeMeetingId) {
      return null;
    }
    const meeting = this.store.getMeeting(this.activeMeetingId);
    if (!meeting) {
      this.activeMeetingId = null;
      return null;
    }
    return meeting;
  }

  clearActiveMeeting(meetingId) {
    if (this.activeMeetingId === meetingId) {
      this.activeMeetingId = null;
      void this.stopAdoBridge("meeting-ended");
    }
  }

  async activateMeeting(meetingId) {
    const meeting = this.store.getMeeting(meetingId);
    if (!meeting) {
      return null;
    }
    this.activeMeetingId = meetingId;
    await this.ensureAdoBridgeForActiveMeeting("meeting-activated");
    return meeting;
  }

  async shutdown() {
    await this.stopAdoBridge("runtime-shutdown", { dispose: true });
  }
}

module.exports = {
  AppRuntime,
  getDefaultAzureConfigDir,
};
