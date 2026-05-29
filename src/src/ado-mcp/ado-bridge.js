const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { McpClient } = require("./mcp-client");

const DEFAULT_DOMAINS = ["core", "work", "work-items", "search"];
const DEFAULT_ORGANIZATION = "";
const DEFAULT_TENANT_ID = "";
const READ_ONLY_ALLOW_PREFIXES = ["search_", "list_", "get_", "read_", "query_"];
const READ_ONLY_BLOCK_PREFIXES = [
  "create_",
  "update_",
  "delete_",
  "add_",
  "remove_",
  "link_",
  "unlink_",
  "assign_",
  "move_",
  "close_",
  "comment_",
];
const SAFE_TOOL_NAME_PRIORITY = [
  "list_projects",
  "list_project",
  "get_projects",
  "get_project",
  "search_workitem",
  "search_workitems",
  "query_work_items",
  "query_workitems",
];

function normalizeMode(mode) {
  return String(mode ?? "read-only").trim().toLowerCase() === "read-write" ? "read-write" : "read-only";
}

function normalizeDomains(domains) {
  const values = Array.isArray(domains) ? domains : DEFAULT_DOMAINS;
  return values
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
}

function normalizeConfig(config = {}) {
  const organization = String(config.organization ?? DEFAULT_ORGANIZATION).trim() || DEFAULT_ORGANIZATION;
  const tenantId = String(config.tenantId ?? DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID;
  const authMethod = String(config.authMethod ?? "azcli").trim() || "azcli";
  const azureConfigDir = String(config.azureConfigDir ?? path.join(process.cwd(), "local-data", "az-standupscribe")).trim();
  const project = String(config.project ?? "").trim();
  return {
    authMethod,
    azureConfigDir,
    domains: normalizeDomains(config.domains),
    logger: typeof config.logger === "function" ? config.logger : () => {},
    mode: normalizeMode(config.mode),
    organization,
    project,
    tenantId,
  };
}

function normalizeToolDefinition(tool) {
  return {
    description: String(tool?.description ?? "").trim(),
    inputSchema: tool?.inputSchema ?? { type: "object", properties: {} },
    name: String(tool?.name ?? "").trim(),
  };
}

const READ_ONLY_ACTION_VERBS = [
  "search", "list", "get", "read", "query", "my",
  "list_my", "by_id", "by_ids", "by_wiql",
];
const MUTATING_ACTION_VERBS = [
  "create", "update", "delete", "add", "remove", "assign",
  "move", "close", "set", "link", "unlink", "import", "import_",
];

function looksReadOnly(name) {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return false;
  // Any mutating verb anywhere in the snake/kebab-cased name disqualifies it.
  for (const verb of MUTATING_ACTION_VERBS) {
    if (n === verb || n.startsWith(verb + "_") || n.includes("_" + verb + "_") || n.endsWith("_" + verb)) {
      return false;
    }
  }
  // Allow if any read-only verb appears anywhere as a segment.
  for (const verb of READ_ONLY_ACTION_VERBS) {
    if (n === verb || n.startsWith(verb + "_") || n.includes("_" + verb + "_") || n.endsWith("_" + verb)) {
      return true;
    }
  }
  // Unknown verb pattern: conservative — exclude in read-only mode.
  return false;
}

function isReadOnlyToolName(name) {
  return looksReadOnly(name);
}

function filterToolsForMode(tools, mode) {
  if (normalizeMode(mode) === "read-write") {
    return tools.map(normalizeToolDefinition);
  }
  return tools
    .map(normalizeToolDefinition)
    .filter((tool) => isReadOnlyToolName(tool.name));
}

function parseDispatchArgs(rawArgs) {
  if (rawArgs === undefined || rawArgs === null || rawArgs === "") {
    return {};
  }
  if (typeof rawArgs === "string") {
    const parsed = JSON.parse(rawArgs);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }
  if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    return { ...rawArgs };
  }
  throw new Error("ADO tool arguments must be an object or JSON object string.");
}

function getRequiredFields(tool) {
  return Array.isArray(tool?.inputSchema?.required)
    ? tool.inputSchema.required.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
}

function buildSafeToolArgs(tool, { project = "" } = {}) {
  const args = {};
  const properties = tool?.inputSchema?.properties ?? {};
  for (const fieldName of getRequiredFields(tool)) {
    const definition = properties[fieldName] ?? {};
    if (/project/i.test(fieldName)) {
      if (!project) {
        throw new Error(`Tool ${tool.name} requires an Azure DevOps project.`);
      }
      args[fieldName] = project;
      continue;
    }
    if (/query|search/i.test(fieldName)) {
      args[fieldName] = "";
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(definition, "default")) {
      args[fieldName] = definition.default;
      continue;
    }
    if (definition.type === "boolean") {
      args[fieldName] = false;
      continue;
    }
    if (definition.type === "number" || definition.type === "integer") {
      args[fieldName] = 0;
      continue;
    }
    if (definition.type === "array") {
      args[fieldName] = [];
      continue;
    }
    if (definition.type === "object") {
      args[fieldName] = {};
      continue;
    }
    args[fieldName] = "";
  }
  return args;
}

function getSafeToolSortKey(tool) {
  const toolName = String(tool?.name ?? "").trim().toLowerCase();
  const priorityIndex = SAFE_TOOL_NAME_PRIORITY.indexOf(toolName);
  const requiredFields = getRequiredFields(tool);
  return {
    name: toolName,
    priority: priorityIndex === -1 ? SAFE_TOOL_NAME_PRIORITY.length : priorityIndex,
    requiredFieldCount: requiredFields.length,
    requiresOnlySafeInputs: requiredFields.every((fieldName) => /project|query|search/i.test(fieldName)),
  };
}

function buildSafeToolInvocation(tools, { project = "" } = {}) {
  const safeTools = filterToolsForMode(tools, "read-only");
  if (safeTools.length === 0) {
    return null;
  }

  const sortedTools = [...safeTools].sort((left, right) => {
    const leftKey = getSafeToolSortKey(left);
    const rightKey = getSafeToolSortKey(right);
    if (leftKey.priority !== rightKey.priority) {
      return leftKey.priority - rightKey.priority;
    }
    if (leftKey.requiresOnlySafeInputs !== rightKey.requiresOnlySafeInputs) {
      return leftKey.requiresOnlySafeInputs ? -1 : 1;
    }
    if (leftKey.requiredFieldCount !== rightKey.requiredFieldCount) {
      return leftKey.requiredFieldCount - rightKey.requiredFieldCount;
    }
    return leftKey.name.localeCompare(rightKey.name);
  });

  for (const tool of sortedTools) {
    try {
      return {
        args: buildSafeToolArgs(tool, { project }),
        name: tool.name,
      };
    } catch {
    }
  }

  return null;
}

function resolveNpxCommand() {
  return "npx";
}

class AdoBridge extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = normalizeConfig(config);
    this.client = null;
    this.lastError = "";
    this.retryCount = 0;
    this.retryTimer = null;
    this.running = false;
    this.startPromise = null;
    this.stopping = false;
    this.toolCache = [];
    this.toolCount = 0;
    this.wantsRunning = false;
  }

  async start() {
    if (this.running) {
      return this;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.wantsRunning = true;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async startInternal() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopping = false;
    this.lastError = "";
    fs.mkdirSync(this.config.azureConfigDir, { recursive: true });

    const client = new McpClient();
    client.on("notification", (notification) => {
      this.emit("notification", notification);
    });
    client.on("error", (error) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.lastError = normalizedError.message;
      this.emit("error", normalizedError);
    });
    client.on("exit", (event) => {
      const wasUnexpected = !this.stopping && this.wantsRunning;
      this.running = false;
      this.emit("exit", event);
      if (wasUnexpected) {
        const exitError = new Error("Azure DevOps MCP server exited unexpectedly.");
        this.lastError = exitError.message;
        this.emit("error", exitError);
        this.scheduleRetry();
      }
    });

    const spawnOptions = {
      args: [
        "-y",
        "@azure-devops/mcp",
        this.config.organization,
        "-a",
        this.config.authMethod,
        "-t",
        this.config.tenantId,
        "-d",
        ...this.config.domains,
      ],
      command: resolveNpxCommand(),
      env: {
        ...process.env,
        AZURE_CONFIG_DIR: this.config.azureConfigDir,
      },
    };

    try {
      await client.start(spawnOptions);
      this.client = client;
      this.running = true;
      this.retryCount = 0;
      this.config.logger(`ado bridge started organization=${this.config.organization} mode=${this.config.mode}`);
      return this;
    } catch (error) {
      this.client = null;
      this.running = false;
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.lastError = normalizedError.message;
      this.emit("error", normalizedError);
      throw normalizedError;
    }
  }

  scheduleRetry() {
    if (!this.wantsRunning || this.retryCount >= 1 || this.retryTimer) {
      return;
    }
    this.retryCount += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start().catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    }, 5000);
    this.retryTimer.unref?.();
  }

  async getTools({ mode } = {}) {
    await this.start();
    const tools = await this.client.listTools();
    this.toolCache = tools.map(normalizeToolDefinition);
    const effectiveMode = normalizeMode(mode ?? this.config.mode);
    const filteredTools = filterToolsForMode(this.toolCache, effectiveMode);
    this.toolCount = filteredTools.length;
    this.config.logger(`ado bridge tools mode=${effectiveMode} count=${filteredTools.length} names=${filteredTools.map((tool) => tool.name).join(", ")}`);
    return filteredTools;
  }

  async callTool(name, args = {}) {
    await this.start();
    const effectiveMode = normalizeMode(this.config.mode);
    if (effectiveMode === "read-only" && !isReadOnlyToolName(name)) {
      throw new Error(`Azure DevOps bridge is in read-only mode; refusing tool call: ${name}`);
    }
    const parsedArgs = parseDispatchArgs(args);
    this.emit("tool-called", {
      args: parsedArgs,
      mode: effectiveMode,
      name,
      timestamp: new Date().toISOString(),
    });
    return this.client.callTool(name, parsedArgs);
  }

  async dispatchToolCall(toolCall) {
    return dispatchToolCall(this, toolCall);
  }

  async stop() {
    this.wantsRunning = false;
    this.running = false;
    this.stopping = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;

    const activeClient = this.client;
    this.client = null;
    if (!activeClient) {
      this.stopping = false;
      return;
    }

    try {
      await activeClient.stop();
      this.config.logger("ado bridge stopped");
    } finally {
      this.stopping = false;
    }
  }
}

async function dispatchToolCall(bridge, toolCall) {
  if (!(bridge instanceof AdoBridge)) {
    throw new Error("AdoBridge instance is required for Azure DevOps tool dispatch.");
  }
  const candidate = toolCall ?? {};
  const name = String(
    candidate.name
    ?? candidate.tool
    ?? candidate.toolName
    ?? candidate.function?.name
    ?? "",
  ).trim();
  if (!name) {
    throw new Error("Azure DevOps tool call is missing a tool name.");
  }
  const args = parseDispatchArgs(
    candidate.args
    ?? candidate.arguments
    ?? candidate.toolArguments
    ?? candidate.function?.arguments,
  );
  const result = await bridge.callTool(name, args);
  return {
    args,
    name,
    result,
  };
}

module.exports = {
  AdoBridge,
  DEFAULT_CONFIG: {
    authMethod: "azcli",
    azureConfigDir: "",
    domains: DEFAULT_DOMAINS,
    mode: "read-only",
    organization: DEFAULT_ORGANIZATION,
    tenantId: DEFAULT_TENANT_ID,
  },
  DEFAULT_DOMAINS,
  DEFAULT_ORGANIZATION,
  DEFAULT_TENANT_ID,
  buildSafeToolInvocation,
  dispatchToolCall,
  filterToolsForMode,
  isReadOnlyToolName,
  normalizeMode,
};
