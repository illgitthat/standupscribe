const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");

const { AppRuntime, getDefaultAzureConfigDir } = require("./runtime");
const { StandupScribeStore } = require("./store");
const { exchangeSdpOffer, toErrorMessage } = require("./realtime/realtime-core");
const { runPlanner } = require("./planner");

// Per-session in-memory event log for the background planner.
// Keyed by session_id. Each entry: { seq, ts, type, ...data }.
const plannerSessions = new Map();
let plannerSeq = 0;
function plannerEmit(sessionId, event) {
  if (!sessionId) return;
  const list = plannerSessions.get(sessionId) ?? [];
  plannerSeq += 1;
  list.push({ seq: plannerSeq, ts: Date.now(), ...event });
  // Trim to last 200 events
  if (list.length > 200) list.splice(0, list.length - 200);
  plannerSessions.set(sessionId, list);
}

let realtimeCachedToken = null;

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

const API_PORT = parsePort(process.env.STANDUPSCRIBE_API_PORT, 12453);
const UI_PORT = parsePort(process.env.STANDUPSCRIBE_UI_PORT, 12454);
const ALLOWED_CORS_ORIGINS = new Set([
  `http://127.0.0.1:${UI_PORT}`,
  `http://localhost:${UI_PORT}`,
]);

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
};

const ADO_SETTING_KEYS = [
  "ado.enabled",
  "ado.organization",
  "ado.project",
  "ado.tenantId",
  "ado.mode",
  "ado.approval",
  "ado.azureConfigDir",
];
const AZURE_OPENAI_SETTING_KEYS = [
  "azure.openai.baseUrl",
  "azure.openai.apiKey",
  "azure.openai.realtimeDeployment",
  "azure.openai.transcriptionDeployment",
];
const CHAT_LLM_SETTING_KEYS = [
  "chat.llm.baseUrl",
  "chat.llm.apiKey",
  "chat.llm.apiKeyHeader",
  "chat.llm.model",
];

function pickSettings(settings, keys) {
  return Object.fromEntries(keys.map((key) => [key, settings?.[key]]));
}

function pickDefinedSettings(settings, keys) {
  return Object.fromEntries(
    keys
      .filter((key) => settings?.[key] !== undefined)
      .map((key) => [key, settings?.[key]]),
  );
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function sendResult(res, result, detail = null, statusCode = 200) {
  sendJson(res, statusCode, detail === null ? { result } : { detail, result });
}

function sendError(res, statusCode, detail, result = null) {
  sendResult(res, result, detail, statusCode);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function getAllowedCorsOrigin(req) {
  const origin = String(req.headers.origin ?? "").trim();
  return ALLOWED_CORS_ORIGINS.has(origin) ? origin : "";
}

function applyCorsHeaders(req, res) {
  const origin = getAllowedCorsOrigin(req);
  if (!origin) {
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
}

function serveStaticFile(uiDir, req, res) {
  const requestedPath = req.url === "/" ? "/index.html" : req.url;
  const safePath = requestedPath.split("?")[0];
  const resolvedPath = path.resolve(uiDir, `.${safePath}`);
  if (!resolvedPath.startsWith(path.resolve(uiDir))) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  let filePath = resolvedPath;
  if (!fs.existsSync(filePath)) {
    filePath = path.join(uiDir, "index.html");
  }
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
  });
  fs.createReadStream(filePath).pipe(res);
}

function maskSecret(value, visibleSuffixLength = 4) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= visibleSuffixLength) {
    return "*".repeat(text.length);
  }
  return `${"*".repeat(Math.max(4, text.length - visibleSuffixLength))}${text.slice(-visibleSuffixLength)}`;
}

function maskAzureOpenAiSettings(settings) {
  return {
    ...pickSettings(settings, AZURE_OPENAI_SETTING_KEYS),
    "azure.openai.apiKey": maskSecret(settings?.["azure.openai.apiKey"]),
  };
}

function maskChatLlmSettings(settings) {
  return {
    ...pickSettings(settings, CHAT_LLM_SETTING_KEYS),
    "chat.llm.apiKey": maskSecret(settings?.["chat.llm.apiKey"]),
  };
}

function parseBoolean(value, fallback = false) {
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
  return fallback;
}

function validateHttpUrl(value, label) {
  if (!value) {
    return `${label} is required.`;
  }
  try {
    const parsedUrl = new URL(value);
    if (!parsedUrl.protocol.startsWith("http")) {
      return `${label} must start with http:// or https://.`;
    }
  } catch {
    return `${label} is invalid.`;
  }
  return "";
}

function validateAzureOpenAiSettings(settings) {
  const baseUrl = String(settings?.["azure.openai.baseUrl"] ?? "").trim();
  const apiKey = String(settings?.["azure.openai.apiKey"] ?? "").trim();
  const urlError = validateHttpUrl(baseUrl, "Azure OpenAI base URL");
  if (urlError) {
    return urlError;
  }
  if (!apiKey) {
    return "Azure OpenAI API key is required.";
  }
  return "";
}

function validateAdoSettings(settings) {
  const enabled = parseBoolean(settings?.["ado.enabled"]);
  if (enabled && !String(settings?.["ado.project"] ?? "").trim()) {
    return "Azure DevOps project is required when the integration is enabled.";
  }
  return "";
}

function validateChatLlmSettings(settings) {
  const baseUrl = String(settings?.["chat.llm.baseUrl"] ?? "").trim();
  const apiKey = String(settings?.["chat.llm.apiKey"] ?? "").trim();
  const apiKeyHeader = String(settings?.["chat.llm.apiKeyHeader"] ?? "api-key").trim() || "api-key";
  const model = String(settings?.["chat.llm.model"] ?? "gpt-5-mini").trim() || "gpt-5-mini";
  const urlError = validateHttpUrl(baseUrl, "Chat LLM base URL");
  if (urlError) {
    return urlError;
  }
  if (!apiKey) {
    return "Chat LLM API key is required.";
  }
  if (!apiKeyHeader) {
    return "Chat LLM API key header is required.";
  }
  if (!model) {
    return "Chat LLM model is required.";
  }
  return "";
}

function resolveChatLlmSettings(settings) {
  return {
    "chat.llm.baseUrl": String(settings?.["chat.llm.baseUrl"] ?? "").trim() || String(process.env.STANDUPSCRIBE_LLM_BASE_URL ?? "").trim(),
    "chat.llm.apiKey": String(settings?.["chat.llm.apiKey"] ?? "").trim() || String(process.env.STANDUPSCRIBE_LLM_API_KEY ?? "").trim(),
    "chat.llm.apiKeyHeader": String(settings?.["chat.llm.apiKeyHeader"] ?? "api-key").trim() || String(process.env.STANDUPSCRIBE_LLM_API_KEY_HEADER ?? "api-key").trim() || "api-key",
    "chat.llm.model": String(settings?.["chat.llm.model"] ?? "gpt-5-mini").trim() || String(process.env.STANDUPSCRIBE_LLM_MODEL ?? "gpt-5-mini").trim() || "gpt-5-mini",
  };
}

function getAdoAzureConfigDir(dataDir, settings = {}) {
  const configured = String(settings?.["ado.azureConfigDir"] ?? "").trim();
  return configured || getDefaultAzureConfigDir(dataDir);
}

function createAzureCliEnv(azureConfigDir) {
  fs.mkdirSync(azureConfigDir, { recursive: true });
  return {
    ...process.env,
    AZURE_CONFIG_DIR: azureConfigDir,
  };
}

function spawnProcess(command, args, options = {}) {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", command, ...args], options);
  }
  return spawn(command, args, options);
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function parseAzureAccount(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return {
      account_email: String(parsed?.user?.name ?? "").trim() || null,
      tenant_id: String(parsed?.tenantId ?? "").trim() || null,
    };
  } catch {
    return {
      account_email: null,
      tenant_id: null,
    };
  }
}

async function getAzureCliStatus({ dataDir, settings }) {
  const azureConfigDir = getAdoAzureConfigDir(dataDir, settings);
  const env = createAzureCliEnv(azureConfigDir);
  const version = await runCommand("az", ["--version"], env).catch(() => null);
  if (!version || version.code !== 0) {
    return {
      installed: false,
      version: null,
      logged_in: false,
      account_email: null,
      tenant_id: null,
    };
  }
  const versionLine = String(version.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  const account = await runCommand("az", ["account", "show", "--output", "json"], env).catch(() => null);
  if (!account || account.code !== 0) {
    return {
      installed: true,
      version: versionLine,
      logged_in: false,
      account_email: null,
      tenant_id: null,
    };
  }
  const parsedAccount = parseAzureAccount(account.stdout);
  return {
    installed: true,
    version: versionLine,
    logged_in: true,
    account_email: parsedAccount.account_email,
    tenant_id: parsedAccount.tenant_id,
  };
}

function writeSseEvent(res, eventName, payload) {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseDeviceCodePrompt(rawLine) {
  const raw = String(rawLine ?? "").trim();
  if (!raw) {
    return null;
  }
  const match = raw.match(/(https:\/\/\S+)\s+and enter the code\s+([A-Z0-9-]+)/i);
  if (!match) {
    return null;
  }
  return {
    url: match[1],
    code: match[2].toUpperCase(),
    raw,
  };
}

// Translate the high-level propose_status_update args into a concrete MCP tool call.
// Returns { toolName, args } or { error } if it can't be translated.
function translateProposeStatusUpdate(args, adoSettings) {
  const action = String(args?.action ?? "").trim();
  const project = String(adoSettings?.project ?? "").trim();
  const workItemIdRaw = args?.work_item_id ?? args?.workItemId ?? args?.work_item ?? null;
  const workItemId = workItemIdRaw != null ? String(workItemIdRaw).replace(/^#/, "").trim() : "";
  if (!project) {
    return { error: "ADO project is not set in Settings — cannot route the call." };
  }
  if (action === "add_comment") {
    const comment = String(args?.comment ?? args?.summary ?? "").trim();
    if (!workItemId) return { error: "work_item_id is required for add_comment. Set it manually on the action card." };
    if (!comment) return { error: "comment text is empty." };
    return {
      toolName: "wit_add_work_item_comment",
      args: { project, workItemId: Number(workItemId), comment },
    };
  }
  if (action === "update_status" || action === "close_task") {
    if (!workItemId) return { error: `work_item_id is required for ${action}.` };
    const newState = action === "close_task"
      ? (String(args?.new_state ?? "").trim() || "Closed")
      : (String(args?.new_state ?? "").trim());
    if (!newState) return { error: "new_state is required for update_status." };
    return {
      toolName: "wit_update_work_item",
      args: {
        project,
        id: Number(workItemId),
        updates: [{ op: "add", path: "/fields/System.State", value: newState }],
      },
    };
  }
  if (action === "assign") {
    if (!workItemId) return { error: "work_item_id is required for assign." };
    const assignee = String(args?.assignee ?? "").trim();
    if (!assignee) return { error: "assignee is required." };
    return {
      toolName: "wit_update_work_item",
      args: {
        project,
        id: Number(workItemId),
        updates: [{ op: "add", path: "/fields/System.AssignedTo", value: assignee }],
      },
    };
  }
  if (action === "create_task") {
    const title = String(args?.summary ?? "").trim();
    if (!title) return { error: "summary (title) is required for create_task." };
    const updates = [{ op: "add", path: "/fields/System.Title", value: title }];
    const assignee = String(args?.assignee ?? "").trim();
    if (assignee) updates.push({ op: "add", path: "/fields/System.AssignedTo", value: assignee });
    return {
      toolName: "wit_create_work_item",
      args: { project, workItemType: "Task", updates },
    };
  }
  return { error: `Unknown propose_status_update action: ${action}` };
}

async function executeProposedAction({ id, resolvedStore, runtime, autoApplied = false }) {
  const existing = resolvedStore.getProposedAction(id);
  if (!existing) {
    return { status: 404, detail: "Proposed action not found." };
  }
  const toolName = String(existing.tool_name ?? "").trim();
  let toolArgs = {};
  try { toolArgs = existing.tool_args_json ? JSON.parse(existing.tool_args_json) : {}; } catch {}

  const adoSettings = runtime.getAdoSettings();

  // Built-in proposer: translate into a real MCP call if possible.
  if (toolName === "propose_status_update") {
    if (!adoSettings.enabled) {
      // No live ADO — just mark applied as a stub (preserves old behavior for demo / dry runs).
      const action = resolvedStore.updateProposedActionStatus(id, {
        decidedAt: Date.now(),
        appliedAt: Date.now(),
        status: autoApplied ? "auto_applied" : "applied",
        resultJson: { stub: true, note: "ADO not enabled — recorded as a proposal only" },
      });
      return { status: 200, action };
    }
    const adoMode = String(adoSettings.mode ?? "read-only").trim();
    if (adoMode === "read-only") {
      return { status: 403, detail: "ADO is in read-only mode; switch to read/write in Settings to apply this." };
    }
    const translated = translateProposeStatusUpdate(toolArgs, adoSettings);
    if (translated.error) {
      const action = resolvedStore.updateProposedActionStatus(id, {
        decidedAt: Date.now(),
        status: "failed",
        error: translated.error,
      });
      return { status: 400, detail: translated.error, action };
    }
    try {
      const bridge = await runtime.getAdoBridge({ start: true });
      if (!bridge) return { status: 500, detail: "ADO bridge is unavailable." };
      const result = await bridge.callTool(translated.toolName, translated.args);
      let adoItemUrl = null;
      try {
        const flat = JSON.stringify(result);
        const m = flat.match(/https?:\/\/[^\s"']*_workitems\/edit\/\d+/);
        if (m) adoItemUrl = m[0];
        else if (translated.args.id || translated.args.workItemId) {
          const wid = translated.args.id ?? translated.args.workItemId;
          adoItemUrl = `https://dev.azure.com/${adoSettings.organization}/${encodeURIComponent(adoSettings.project)}/_workitems/edit/${wid}`;
        }
      } catch {}
      const action = resolvedStore.updateProposedActionStatus(id, {
        decidedAt: Date.now(),
        appliedAt: Date.now(),
        status: autoApplied ? "auto_applied" : "applied",
        resultJson: { translated_to: translated.toolName, args: translated.args, mcp_result: result },
        adoItemUrl,
      });
      return { status: 200, action };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const action = resolvedStore.updateProposedActionStatus(id, {
        decidedAt: Date.now(),
        status: "failed",
        error: msg,
      });
      return { status: 502, detail: `Tool execution failed: ${msg}`, action };
    }
  }

  // Raw MCP tool — gate on enabled + read-only mode
  if (!adoSettings.enabled) {
    return { status: 400, detail: "Azure DevOps integration is not enabled." };
  }
  const adoMode = String(adoSettings.mode ?? "read-only").trim();
  // Use the bridge's own classifier for consistency
  const { isReadOnlyToolName } = require("./ado-mcp/ado-bridge");
  const looksMutating = !isReadOnlyToolName(toolName);
  if (adoMode === "read-only" && looksMutating) {
    return { status: 403, detail: "ADO is in read-only mode; switch to read/write in Settings to apply mutating tool calls." };
  }
  try {
    const bridge = await runtime.getAdoBridge({ start: true });
    if (!bridge) {
      return { status: 500, detail: "ADO bridge is unavailable." };
    }
    const result = await bridge.callTool(toolName, toolArgs);
    let adoItemUrl = null;
    try {
      const flat = JSON.stringify(result);
      const m = flat.match(/https?:\/\/[^\s"']*_workitems\/edit\/\d+/);
      if (m) adoItemUrl = m[0];
    } catch {}
    const action = resolvedStore.updateProposedActionStatus(id, {
      decidedAt: Date.now(),
      appliedAt: Date.now(),
      status: autoApplied ? "auto_applied" : "applied",
      resultJson: result,
      adoItemUrl,
    });
    return { status: 200, action };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const action = resolvedStore.updateProposedActionStatus(id, {
      decidedAt: Date.now(),
      status: "failed",
      error: msg,
    });
    return { status: 502, detail: `Tool execution failed: ${msg}`, action };
  }
}

// 5-minute in-memory cache for pre-fetched ADO work items per project
const workItemCache = new Map();
const WORK_ITEM_CACHE_TTL_MS = 5 * 60 * 1000;
const WORK_ITEM_PREFETCH_MAX = 30;

async function prefetchActiveWorkItems({ runtime, project, logger }) {
  const key = String(project ?? "").trim() || "_default_";
  const cached = workItemCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < WORK_ITEM_CACHE_TTL_MS) {
    return cached.items;
  }
  let items = [];
  try {
    const bridge = await runtime.getAdoBridge({ start: true });
    if (!bridge) return [];
    const projectArr = project ? [project] : undefined;
    // Use search_workitem with state filter. The MCP server requires non-empty searchText.
    // We seed with the project's leading token (e.g. "ACME" for "ACME-Project") which usefully
    // broadens the search to anything mentioning the project. If that returns nothing we fall back
    // to a single broad-letter probe ("a"). State filter keeps only items likely to be touched in a status call.
    const activeStates = ["Active", "New", "Committed", "In Progress", "Accepted", "Doing", "Approved", "To Do"];
    const seedTokens = [];
    if (project) {
      const head = project.split(/[-_\s]+/)[0];
      if (head && head.length >= 2) seedTokens.push(head);
    }
    seedTokens.push("a");
    let raw = null;
    for (const seed of seedTokens) {
      try {
        raw = await bridge.callTool("search_workitem", {
          searchText: seed,
          project: projectArr,
          state: activeStates,
          top: WORK_ITEM_PREFETCH_MAX,
        });
        const parsed = extractWorkItems(raw);
        if (parsed.length > 0) {
          items = parsed.slice(0, WORK_ITEM_PREFETCH_MAX);
          logger?.(`prefetched ${items.length} active work items (seed="${seed}", project="${project}")`);
          break;
        }
      } catch (e) {
        logger?.(`work-item prefetch attempt seed="${seed}" failed: ${e?.message || e}`);
      }
    }
  } catch (error) {
    logger?.(`work-item prefetch failed: ${error?.message || error}`);
  }
  workItemCache.set(key, { items, fetchedAt: Date.now() });
  return items;
}

function extractWorkItems(raw) {
  const out = [];
  const seen = new Set();
  function pickField(node, ...names) {
    if (!node || typeof node !== "object") return undefined;
    for (const n of names) {
      if (node[n] !== undefined && node[n] !== null && node[n] !== "") return node[n];
    }
    return undefined;
  }
  function looksLikeNumericId(value) {
    const s = String(value ?? "").trim();
    return /^\d+$/.test(s);
  }
  function visit(node) {
    if (!node) return;
    if (Array.isArray(node)) { for (const n of node) visit(n); return; }
    if (typeof node !== "object") return;
    const fields = node.fields ?? node;
    const id = pickField(node, "id", "workItemId", "workitem_id")
      ?? pickField(fields, "System.Id", "system.id");
    const title = pickField(fields, "System.Title", "system.title");
    const state = pickField(fields, "System.State", "system.state");
    const wtype = pickField(fields, "System.WorkItemType", "system.workitemtype");
    const assignee = pickField(fields, "System.AssignedTo", "system.assignedto");
    // Only treat as a work item if it has a numeric ID AND a title (or work-item-type field).
    // This filters out nested objects like {project:{id:<guid>, name:...}} which match a bare "id" key.
    if (looksLikeNumericId(id) && (title || wtype)) {
      const dedupeKey = `${id}:${title}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        let assigneeStr = null;
        if (typeof assignee === "string") {
          assigneeStr = assignee;
        } else if (assignee && typeof assignee === "object") {
          assigneeStr = assignee.displayName ?? assignee.uniqueName ?? null;
        }
        out.push({
          id: String(id),
          title: title ? String(title).slice(0, 140) : null,
          state: state ? String(state) : null,
          type: wtype ? String(wtype) : null,
          assignee: assigneeStr,
        });
      }
      return; // don't recurse into the matched node; otherwise we may re-extract nested project IDs
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") visit(v);
    }
  }
  if (raw?.content && Array.isArray(raw.content)) {
    for (const block of raw.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        try { visit(JSON.parse(block.text)); } catch { /* not JSON */ }
      } else {
        visit(block);
      }
    }
  } else {
    visit(raw);
  }
  return out;
}

function formatWorkItemsForPrompt(items) {
  if (!items || items.length === 0) return "";
  const lines = ["## Known active work items in this project (use these to resolve speaker references like 'the deploy bug' → a specific ID):"];
  for (const w of items.slice(0, WORK_ITEM_PREFETCH_MAX)) {
    const id = w.id ? `#${w.id}` : "(no id)";
    const title = w.title || "(no title)";
    const state = w.state ? ` [${w.state}]` : "";
    const type = w.type ? ` <${w.type}>` : "";
    const assignee = w.assignee ? ` — ${w.assignee}` : "";
    lines.push(`- ${id}${type}: ${title}${state}${assignee}`);
  }
  return lines.join("\n");
}

function sanitizeIncomingSettings(body, existingSettings) {
  // Defense: secret (API key) fields are write-only. The UI shows a placeholder
  // instead of the stored value, so an unchanged form submits either an empty
  // string or the literal mask placeholder. In both cases, preserve the existing
  // stored value rather than overwriting it.
  if (!body || typeof body !== "object") return body;
  const cleaned = { ...body };
  const secretKeys = ["azure.openai.apiKey", "chat.llm.apiKey"];
  for (const key of secretKeys) {
    if (!Object.prototype.hasOwnProperty.call(cleaned, key)) continue;
    const incoming = String(cleaned[key] ?? "");
    const isMasked = incoming.length > 0 && /^\*+/.test(incoming);
    const isEmpty = incoming.length === 0;
    if (isMasked || isEmpty) {
      const existing = existingSettings?.[key];
      if (existing != null && String(existing).length > 0) {
        cleaned[key] = existing;
      } else {
        delete cleaned[key];
      }
    }
  }
  return cleaned;
}

async function createApiHandler({
  dataDir,
  logger = () => {},
  store,
}) {
  const ownsStore = !store;
  const resolvedStore = store ?? new StandupScribeStore(dataDir);
  const runtime = new AppRuntime({
    dataDir,
    store: resolvedStore,
    logger,
  });
  let activeAdoLogin = null;

  async function handle(req, res) {
    applyCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      });
      res.end();
      return;
    }

    const requestUrl = new URL(req.url, `http://127.0.0.1:${API_PORT}`);
    const pathname = requestUrl.pathname;

    try {
      if (pathname === "/api/global/settings/" && req.method === "GET") {
        sendResult(res, resolvedStore.getSettings());
        return;
      }

      if (pathname === "/api/global/settings/" && req.method === "POST") {
        const rawBody = (await readJsonBody(req)) ?? {};
        const sanitized = sanitizeIncomingSettings(rawBody, resolvedStore.getSettings());
        const updatedSettings = resolvedStore.updateSettings(sanitized);
        await runtime.refreshAdoBridgeFromSettings("global-settings-updated");
        sendResult(res, updatedSettings);
        return;
      }

      if (pathname === "/api/settings/ado" && req.method === "GET") {
        sendResult(res, pickSettings(resolvedStore.getSettings(), ADO_SETTING_KEYS));
        return;
      }

      if (pathname === "/api/settings/ado" && req.method === "PUT") {
        const body = (await readJsonBody(req)) ?? {};
        const updatedSettings = resolvedStore.updateSettings(body);
        await runtime.refreshAdoBridgeFromSettings("ado-settings-updated");
        sendResult(res, pickSettings(updatedSettings, ADO_SETTING_KEYS));
        return;
      }

      if (pathname === "/api/settings/azure-openai" && req.method === "GET") {
        sendResult(res, maskAzureOpenAiSettings(resolvedStore.getSettings()));
        return;
      }

      if (pathname === "/api/settings/azure-openai" && req.method === "PUT") {
        const body = (await readJsonBody(req)) ?? {};
        const sanitized = sanitizeIncomingSettings(body, resolvedStore.getSettings());
        sendResult(res, maskAzureOpenAiSettings(resolvedStore.updateSettings(sanitized)));
        return;
      }

      if (pathname === "/api/settings/chat-llm" && req.method === "GET") {
        sendResult(res, maskChatLlmSettings(resolvedStore.getSettings()));
        return;
      }

      if (pathname === "/api/settings/chat-llm" && req.method === "PUT") {
        const body = (await readJsonBody(req)) ?? {};
        const sanitized = sanitizeIncomingSettings(body, resolvedStore.getSettings());
        sendResult(res, maskChatLlmSettings(resolvedStore.updateSettings(sanitized)));
        return;
      }

      if (pathname === "/api/azure-openai/test" && req.method === "POST") {
        const body = (await readJsonBody(req)) ?? {};
        const settings = {
          ...pickSettings(resolvedStore.getSettings(), AZURE_OPENAI_SETTING_KEYS),
          ...pickDefinedSettings(body, AZURE_OPENAI_SETTING_KEYS),
        };
        const validationError = validateAzureOpenAiSettings(settings);
        if (validationError) {
          sendError(res, 400, validationError);
          return;
        }
        sendResult(res, {
          detail: "Credentials look configured. Live Azure OpenAI realtime verification is still TODO.",
          ok: true,
        });
        return;
      }

      if (pathname === "/api/chat-llm/test" && req.method === "POST") {
        const body = (await readJsonBody(req)) ?? {};
        const settings = resolveChatLlmSettings({
          ...pickSettings(resolvedStore.getSettings(), CHAT_LLM_SETTING_KEYS),
          ...pickDefinedSettings(body, CHAT_LLM_SETTING_KEYS),
        });
        const validationError = validateChatLlmSettings(settings);
        if (validationError) {
          sendError(res, 400, validationError);
          return;
        }
        try {
          const response = await fetch(`${settings["chat.llm.baseUrl"].replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [settings["chat.llm.apiKeyHeader"]]: settings["chat.llm.apiKey"],
            },
            body: JSON.stringify({
              model: settings["chat.llm.model"],
              messages: [
                { role: "user", content: "Hello, respond with the word OK" },
              ],
              max_completion_tokens: 16,
            }),
          });
          if (!response.ok) {
            const errorText = await response.text();
            sendError(res, 502, `Chat LLM test failed: ${response.status} ${errorText.slice(0, 200)}`);
            return;
          }
          const data = await response.json();
          const content = String(data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "").trim();
          sendResult(res, {
            detail: content ? `Chat LLM responded: ${content}` : "Chat LLM request succeeded.",
            ok: true,
          });
        } catch (error) {
          sendError(res, 500, `Chat LLM test failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      if (pathname === "/api/realtime/connect" && req.method === "POST") {
        let rawBody = "";
        if (req.headers["content-type"]?.includes("application/sdp")) {
          rawBody = await new Promise((resolve, reject) => {
            const chunks = [];
            req.on("data", (chunk) => chunks.push(chunk));
            req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            req.on("error", reject);
          });
        }
        const payload = rawBody ? { sdp: rawBody } : ((await readJsonBody(req)) ?? {});
        const sdp = typeof payload.sdp === "string" ? payload.sdp : "";
        if (!sdp) {
          sendError(res, 400, "Missing 'sdp' field");
          return;
        }
        const settings = pickSettings(resolvedStore.getSettings(), AZURE_OPENAI_SETTING_KEYS);
        const baseUrl = String(settings["azure.openai.baseUrl"] ?? "").trim() || String(process.env.AZURE_OPENAI_BASE_URL ?? "").trim();
        const apiKey = String(settings["azure.openai.apiKey"] ?? "").trim() || String(process.env.AZURE_OPENAI_API_KEY ?? "").trim();
        const model = String(settings["azure.openai.realtimeDeployment"] ?? "").trim()
          || String(process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? "").trim()
          || "gpt-realtime-2";
        const transcriptionModel = String(settings["azure.openai.transcriptionDeployment"] ?? "").trim()
          || String(process.env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT_NAME ?? "").trim()
          || "gpt-realtime-whisper";
        try {
          const result = await exchangeSdpOffer({
            fetchImpl: fetch,
            baseUrl,
            credentials: {
              apiKey,
              tenantId: String(process.env.AZURE_TENANT_ID ?? "").trim(),
              clientId: String(process.env.AZURE_CLIENT_ID ?? "").trim(),
              clientSecret: String(process.env.AZURE_CLIENT_SECRET ?? "").trim(),
            },
            sessionOptions: {
              model,
              transcriptionModel,
              voice: typeof payload.voice === "string" && payload.voice ? payload.voice : "alloy",
              instructions:
                typeof payload.instructions === "string" && payload.instructions
                  ? payload.instructions
                  : "You are a passive meeting transcription assistant for engineering status calls. Stay silent unless the user explicitly addresses you.",
            },
            sdpOffer: sdp,
            cachedToken: realtimeCachedToken,
          });
          realtimeCachedToken = result.cachedToken;
          res.writeHead(201, { "Content-Type": "application/sdp" });
          res.end(result.sdpAnswer);
        } catch (error) {
          sendError(res, 500, toErrorMessage(error));
        }
        return;
      }

      if (pathname === "/api/listen/session-config" && req.method === "GET") {
        const settings = resolvedStore.getSettings();
        const adoEnabled = parseBoolean(settings["ado.enabled"]);
        const adoMode = String(settings["ado.mode"] ?? "read-only").trim() || "read-only";
        // Only ONE tool is exposed to the realtime model: dispatch_to_planner.
        // The realtime model identifies that something actionable was said and forwards
        // a brief intent string to the background planner agent. The planner then does
        // the actual ADO investigation (search work items, list comments, etc.) before
        // producing a concrete proposed action for the user to review.
        const tools = [
          {
            type: "function",
            name: "dispatch_to_planner",
            description:
              "Forward one or more actionable items from the meeting to the background planner agent. Call this when a speaker makes clear, present-tense commitments, status reports, blockers, assignments, or directives that should map to Azure DevOps work item changes. The planner will search ADO, look up candidates, and propose the concrete actions. Do NOT call for questions, aspirations, past context, or chit-chat. PREFER ONE DISPATCH PER TURN: when a single speaker bundles several distinct facts in one update (e.g. 'I finished X, please add a comment to Y, also reassign Z to Sam'), pass them all in a single intent — the planner will decompose into multiple proposals.",
            parameters: {
              type: "object",
              required: ["intent"],
              properties: {
                intent: {
                  type: "string",
                  description: "Verbatim or near-verbatim restatement of the actionable content the speaker just said. INCLUDE ALL DISTINCT ACTIONABLE ITEMS in the speaker's turn if they bundled several together — do NOT split into multiple dispatches. Preserve names, IDs, and keywords. Max ~600 chars.",
                },
                suspected_kinds: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["add_comment", "status_change", "new_task", "new_story", "assignment", "blocker", "unclear"],
                  },
                  description: "Your best guesses at what kind(s) of change(s) are being discussed — one entry per distinct item in the intent. Planner can override.",
                },
                participants_mentioned: {
                  type: "array",
                  items: { type: "string" },
                  description: "Any names the speaker mentioned as owners/assignees.",
                },
              },
            },
          },
        ];
        const instructionLines = [
          "You are the realtime LISTENER for StandupScribe — an Azure DevOps meeting copilot.",
          "Audio is a mix of the local user's microphone AND remote participants' speaker output.",
          "Your ONLY job is to identify actionable moments in the conversation and dispatch them to the background planner agent. You do NOT decide what ADO change to make — the planner handles that with real ADO data.",
          "",
          "Dispatch discipline (CRITICAL):",
          "  1. Call dispatch_to_planner whenever a speaker makes clear actionable statement(s): status reports ('I'll close that bug today'), blockers ('Sarah is stuck on the API'), directives ('Move ticket 1234 to Done', 'Add a comment'), new task/story requests, or assignments.",
          "  2. NEVER call on questions, aspirations ('we should maybe…'), past-tense context, or general discussion. When in doubt, stay silent.",
          "  3. **Bundle related items into ONE dispatch.** If a speaker bundles multiple actionable things in one turn ('I finished the login refactor, also add a comment that the design doc is linked in the description, and reassign the onboarding flow story to Sam'), pass ALL of them in a single `intent` string — the planner will decompose them into separate proposals. Do NOT fire multiple dispatches for the same turn.",
          "  4. Each *new turn* that introduces *new* actionable content warrants its own dispatch.",
          "  5. Pass the speaker's words verbatim in `intent` — the planner needs the original keywords to search ADO.",
          "",
          "Output discipline (CRITICAL): NEVER produce assistant text. NEVER speak. If no dispatch is warranted, produce an empty response and wait silently.",
        ];
        // Pre-fetch active work items if ADO is enabled and configured. Best-effort.
        let prefetchedItems = [];
        if (adoEnabled) {
          const project = String(settings["ado.project"] ?? "").trim();
          if (project) {
            prefetchedItems = await prefetchActiveWorkItems({
              runtime,
              project,
              logger,
            });
          }
        }
        const workItemBlock = formatWorkItemsForPrompt(prefetchedItems);
        const instructions = workItemBlock
          ? instructionLines.join("\n") + "\n\n" + workItemBlock
          : instructionLines.join("\n");
        sendResult(res, {
          tools,
          instructions,
          ado_enabled: adoEnabled,
          ado_mode: adoMode,
          ado_organization: String(settings["ado.organization"] ?? "").trim(),
          ado_project: String(settings["ado.project"] ?? "").trim(),
          prefetched_work_items: prefetchedItems,
        });
        return;
      }

      if (pathname === "/api/listen/sessions" && req.method === "POST") {
        const meeting = resolvedStore.createMeeting();
        runtime.setActiveMeeting(meeting.meeting_id);
        sendResult(res, { session_id: meeting.meeting_id, created_at: meeting.created_at ?? Date.now(), meeting });
        return;
      }

      if (pathname === "/api/listen/transcript" && req.method === "POST") {
        const body = (await readJsonBody(req)) ?? {};
        const sessionId = String(body.session_id ?? body.sessionId ?? "").trim();
        const text = String(body.text ?? "").trim();
        if (!sessionId) {
          sendError(res, 400, "session_id is required.");
          return;
        }
        if (!text) {
          sendError(res, 400, "Transcript text is required.");
          return;
        }
        if (!resolvedStore.getMeeting(sessionId)) {
          sendError(res, 404, "Session (meeting) not found.");
          return;
        }
        const transcript = resolvedStore.insertTranscript(
          sessionId,
          body.item_id ?? body.itemId ?? null,
          text,
          body.start_ms ?? body.startMs ?? null,
          body.end_ms ?? body.endMs ?? null,
          body.speaker_label ?? body.speakerLabel ?? null,
        );
        sendResult(res, transcript, null, 201);
        return;
      }

      if (pathname === "/api/listen/dispatch" && req.method === "POST") {
        const body = (await readJsonBody(req)) ?? {};
        const sessionId = String(body.session_id ?? body.sessionId ?? "").trim();
        const intent = String(body.intent ?? "").trim();
        const clientContext = String(body.transcript_context ?? body.transcriptContext ?? "").trim();
        if (!sessionId) { sendError(res, 400, "session_id is required."); return; }
        if (!intent) { sendError(res, 400, "intent is required."); return; }
        const meeting = resolvedStore.getMeeting(sessionId);
        if (!meeting) { sendError(res, 404, "Session (meeting) not found."); return; }
        const settings = resolvedStore.getSettings();
        // Pull full persisted transcript history from DB so the planner has real meeting context.
        const allTranscripts = resolvedStore.listTranscripts(sessionId) || [];
        // Sort chronologically (oldest first) and take a generous tail.
        allTranscripts.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
        const TAIL_LINES = 60; // ~last 2-4 minutes of conversation depending on speech rate
        const tail = allTranscripts.slice(-TAIL_LINES);
        const transcriptContext = tail.length > 0
          ? tail.map((t) => {
              const ts = t.created_at ? new Date(Number(t.created_at)).toISOString().slice(11, 19) : "";
              const text = String(t.text || "").trim();
              return ts ? `[${ts}] ${text}` : text;
            }).filter(Boolean).join("\n")
          : clientContext;
        // Also pull previously proposed/applied actions in this meeting so the planner can avoid duplicates.
        const priorActions = resolvedStore.listProposedActions({ meetingId: sessionId }) || [];
        const project = String(settings["ado.project"] ?? "").trim();
        const prefetchedItems = project ? (workItemCache.get(project)?.items ?? []) : [];
        const jobId = `job-${plannerSeq + 1}`;
        plannerEmit(sessionId, { type: "dispatch", job_id: jobId, intent, suspected_kind: body.suspected_kind, transcript_lines: tail.length });
        // Run planner asynchronously — return immediately so realtime model isn't blocked.
        Promise.resolve().then(async () => {
          try {
            await runPlanner({
              intent,
              transcriptContext,
              priorActions,
              meetingId: sessionId,
              meeting,
              prefetchedItems,
              runtime,
              store: resolvedStore,
              settings: pickSettings(settings, CHAT_LLM_SETTING_KEYS),
              onEvent: (evt) => plannerEmit(sessionId, { job_id: jobId, ...evt }),
            });
          } catch (error) {
            plannerEmit(sessionId, { job_id: jobId, type: "error", message: error?.message || String(error) });
          }
        });
        sendResult(res, { queued: true, job_id: jobId, session_id: sessionId, transcript_lines: tail.length }, null, 202);
        return;
      }

      if (pathname === "/api/listen/events" && req.method === "GET") {
        const sessionId = String(requestUrl.searchParams.get("session_id") ?? "").trim();
        const since = Number(requestUrl.searchParams.get("since") ?? 0) || 0;
        if (!sessionId) { sendError(res, 400, "session_id is required."); return; }
        const list = plannerSessions.get(sessionId) ?? [];
        const events = list.filter((e) => e.seq > since);
        const lastSeq = events.length > 0 ? events[events.length - 1].seq : (list.length > 0 ? list[list.length - 1].seq : since);
        sendResult(res, { events, cursor: lastSeq });
        return;
      }

      if (pathname === "/api/listen/proposed-action" && req.method === "POST") {
        const body = (await readJsonBody(req)) ?? {};
        const sessionId = String(body.session_id ?? body.sessionId ?? "").trim();
        const toolName = String(body.tool_name ?? body.toolName ?? "").trim();
        const args = body.args ?? {};
        if (!sessionId) {
          sendError(res, 400, "session_id is required.");
          return;
        }
        if (!toolName) {
          sendError(res, 400, "tool_name is required.");
          return;
        }
        if (!resolvedStore.getMeeting(sessionId)) {
          sendError(res, 404, "Session (meeting) not found.");
          return;
        }
        const action = resolvedStore.createProposedAction({
          meetingId: sessionId,
          transcriptItemId: body.transcript_item_id ?? body.transcriptItemId ?? null,
          transcriptSnippet: body.transcript_context ?? body.transcriptContext ?? body.transcript_snippet ?? "",
          toolName,
          toolArgs: args,
        });
        // Auto-apply path: if settings say auto-apply, execute immediately and return the applied row
        const settingsForAuto = resolvedStore.getSettings();
        const approvalMode = String(settingsForAuto["ado.approval"] ?? "confirm").trim();
        if (approvalMode === "auto-apply") {
          const result = await executeProposedAction({ id: action.id, resolvedStore, runtime, autoApplied: true });
          if (result.action) {
            sendResult(res, result.action, null, 201);
            return;
          }
          // Auto-apply blocked (e.g. read-only); fall through with the original pending row + a hint
          sendResult(res, { ...action, auto_apply_blocked: result.detail || null }, null, 201);
          return;
        }
        sendResult(res, action, null, 201);
        return;
      }

      if (pathname === "/api/ado/status" && req.method === "GET") {
        sendResult(res, await runtime.getAdoStatus());
        return;
      }

      if (pathname === "/api/ado/az-status" && req.method === "GET") {
        sendResult(res, await getAzureCliStatus({ dataDir, settings: resolvedStore.getSettings() }));
        return;
      }

      if (pathname === "/api/ado/login" && req.method === "POST") {
        if (activeAdoLogin?.child && !activeAdoLogin.child.killed) {
          sendError(res, 409, "Azure CLI login is already in progress.");
          return;
        }
        const settings = resolvedStore.getSettings();
        const tenantId = String(settings["ado.tenantId"] ?? "").trim();
        if (!tenantId) {
          sendError(res, 400, "Azure DevOps tenant ID is not configured.");
          return;
        }
        const azureConfigDir = getAdoAzureConfigDir(dataDir, settings);
        const child = spawnProcess("az", ["login", "--use-device-code", "--tenant", tenantId], {
          env: createAzureCliEnv(azureConfigDir),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        activeAdoLogin = { child };
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.flushHeaders?.();
        const closeLogin = () => {
          if (!child.killed) {
            child.kill("SIGTERM");
          }
        };
        req.on("aborted", closeLogin);
        res.on("close", closeLogin);
        let promptSent = false;
        const attachLineReader = (stream) => {
          const lineReader = readline.createInterface({ input: stream });
          lineReader.on("line", (line) => {
            const prompt = parseDeviceCodePrompt(line);
            if (prompt && !promptSent) {
              promptSent = true;
              writeSseEvent(res, "prompt", prompt);
            }
          });
        };
        attachLineReader(child.stdout);
        attachLineReader(child.stderr);
        child.on("error", (error) => {
          if (activeAdoLogin?.child === child) {
            activeAdoLogin = null;
          }
          writeSseEvent(res, "error", { message: error instanceof Error ? error.message : String(error) });
          res.end();
        });
        child.on("close", async (code) => {
          if (activeAdoLogin?.child === child) {
            activeAdoLogin = null;
          }
          if (res.writableEnded || res.destroyed) {
            return;
          }
          if (code === 0) {
            const status = await getAzureCliStatus({ dataDir, settings: resolvedStore.getSettings() });
            await runtime.stopAdoBridge("ado-login-refresh", { dispose: true });
            await runtime.getAdoBridge({ start: true }).catch(() => null);
            writeSseEvent(res, "success", {
              account_email: status.account_email,
              tenant_id: status.tenant_id,
            });
            res.end();
            return;
          }
          writeSseEvent(res, "error", { message: `Azure CLI login exited with code ${code}.` });
          res.end();
        });
        return;
      }

      if (pathname === "/api/ado/logout" && req.method === "POST") {
        const settings = resolvedStore.getSettings();
        const env = createAzureCliEnv(getAdoAzureConfigDir(dataDir, settings));
        const result = await runCommand("az", ["logout"], env).catch((error) => ({ code: -1, stderr: error instanceof Error ? error.message : String(error), stdout: "" }));
        if (result.code !== 0) {
          sendError(res, 500, `Azure CLI logout failed: ${String(result.stderr || result.stdout || "unknown error").trim()}`);
          return;
        }
        await runtime.stopAdoBridge("ado-logout", { dispose: true });
        sendResult(res, await getAzureCliStatus({ dataDir, settings: resolvedStore.getSettings() }));
        return;
      }

      if (pathname === "/api/ado/reload-bridge" && req.method === "POST") {
        await runtime.stopAdoBridge("ado-reload-bridge", { dispose: true });
        await runtime.getAdoBridge({ start: true }).catch(() => null);
        sendResult(res, await runtime.getAdoStatus());
        return;
      }

      if (pathname === "/api/ado/tools" && req.method === "GET") {
        sendResult(res, await runtime.listAdoTools());
        return;
      }

      if (pathname === "/api/ado/test" && req.method === "POST") {
        const body = (await readJsonBody(req)) ?? {};
        const settings = {
          ...pickSettings(resolvedStore.getSettings(), ADO_SETTING_KEYS),
          ...pickDefinedSettings(body, ADO_SETTING_KEYS),
        };
        const validationError = validateAdoSettings(settings);
        if (validationError) {
          sendError(res, 400, validationError);
          return;
        }
        const updatedSettings = resolvedStore.updateSettings(settings);
        await runtime.refreshAdoBridgeFromSettings("ado-test");
        if (!parseBoolean(updatedSettings["ado.enabled"])) {
          sendError(res, 400, "Azure DevOps integration must be enabled to run the connection test.");
          return;
        }
        sendResult(res, await runtime.testAdoConnection());
        return;
      }

      if (pathname === "/api/meeting/" && req.method === "GET") {
        sendResult(res, resolvedStore.getMeetings());
        return;
      }

      if (pathname === "/api/meeting/" && req.method === "POST") {
        const meeting = resolvedStore.createMeeting();
        runtime.setActiveMeeting(meeting.meeting_id);
        sendResult(res, meeting);
        return;
      }

      let match = pathname.match(/^\/api\/meeting\/([^/]+)$/);
      if (match && req.method === "GET") {
        const meeting = resolvedStore.getMeeting(match[1]);
        if (!meeting) {
          sendError(res, 404, "Meeting not found.");
          return;
        }
        sendResult(res, meeting);
        return;
      }

      match = pathname.match(/^\/api\/meeting\/([^/]+)$/);
      if (match && req.method === "PUT") {
        const meeting = resolvedStore.updateMeeting(match[1], (await readJsonBody(req)) ?? {});
        if (!meeting) {
          sendError(res, 404, "Meeting not found.");
          return;
        }
        sendResult(res, meeting);
        return;
      }

      match = pathname.match(/^\/api\/meeting\/([^/]+)$/);
      if (match && req.method === "DELETE") {
        runtime.clearActiveMeeting(match[1]);
        const meeting = resolvedStore.deleteMeeting(match[1]);
        if (!meeting) {
          sendError(res, 404, "Meeting not found.");
          return;
        }
        sendResult(res, meeting);
        return;
      }

      match = pathname.match(/^\/api\/meeting\/([^/]+)\/transcripts$/);
      if (match && req.method === "GET") {
        const meeting = resolvedStore.getMeeting(match[1]);
        if (!meeting) {
          sendError(res, 404, "Meeting not found.");
          return;
        }
        sendResult(res, resolvedStore.listTranscripts(match[1]));
        return;
      }

      match = pathname.match(/^\/api\/meeting\/([^/]+)\/transcripts$/);
      if (match && req.method === "POST") {
        const meeting = resolvedStore.getMeeting(match[1]);
        if (!meeting) {
          sendError(res, 404, "Meeting not found.");
          return;
        }
        const body = (await readJsonBody(req)) ?? {};
        const text = String(body.text ?? "").trim();
        if (!text) {
          sendError(res, 400, "Transcript text is required.");
          return;
        }
        const transcript = resolvedStore.insertTranscript(
          match[1],
          body.item_id ?? body.itemId ?? null,
          text,
          body.start_ms ?? body.startMs ?? null,
          body.end_ms ?? body.endMs ?? null,
          body.speaker_label ?? body.speakerLabel ?? null,
        );
        sendResult(res, transcript, null, 201);
        return;
      }

      match = pathname.match(/^\/api\/meeting\/([^/]+)\/transcripts\/([^/]+)$/);
      if (match && req.method === "GET") {
        const transcript = resolvedStore.getTranscript(match[1], match[2]);
        if (!transcript) {
          sendError(res, 404, "Transcript not found.");
          return;
        }
        sendResult(res, transcript);
        return;
      }

      match = pathname.match(/^\/api\/meeting\/([^/]+)\/transcripts\/([^/]+)$/);
      if (match && req.method === "PUT") {
        const transcript = resolvedStore.updateTranscript(match[1], match[2], (await readJsonBody(req)) ?? {});
        if (!transcript) {
          sendError(res, 404, "Transcript not found.");
          return;
        }
        sendResult(res, transcript);
        return;
      }

      match = pathname.match(/^\/api\/meeting\/([^/]+)\/summary$/);
      if (match && req.method === "POST") {
        const meetingId = match[1];
        const meeting = resolvedStore.getMeeting(meetingId);
        if (!meeting) {
          sendError(res, 404, "Meeting not found.");
          return;
        }
        const transcripts = resolvedStore.listTranscripts(meetingId) || [];
        if (transcripts.length === 0) {
          sendError(res, 400, "No transcripts to summarize.");
          return;
        }
        const appSettings = resolvedStore.getSettings();
        const llmSettings = resolveChatLlmSettings(pickSettings(appSettings, CHAT_LLM_SETTING_KEYS));
        const llmBaseUrl = llmSettings["chat.llm.baseUrl"];
        const llmApiKey = llmSettings["chat.llm.apiKey"];
        const llmKeyHeader = llmSettings["chat.llm.apiKeyHeader"];
        const llmModel = llmSettings["chat.llm.model"];
        if (!llmBaseUrl || !llmApiKey) {
          sendError(res, 400, "Chat completions LLM is not configured in Settings or STANDUPSCRIBE_LLM_BASE_URL/STANDUPSCRIBE_LLM_API_KEY.");
          return;
        }
        const transcriptText = transcripts
          .map((t) => String(t.text || "").trim())
          .filter(Boolean)
          .join("\n");
        const systemPrompt = "You summarize engineering status meetings. Produce a concise markdown summary with these sections, omitting any that have no content:\n\n## Decisions\n## Action items (with owner if mentioned)\n## Blockers\n## Open questions\n\nBe terse. Use bullet points. Do not invent facts. If a section has no content, omit it entirely.";
        try {
          const completionUrl = llmBaseUrl.replace(/\/+$/, "") + "/chat/completions";
          const response = await fetch(completionUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [llmKeyHeader]: llmApiKey,
            },
            body: JSON.stringify({
              model: llmModel,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: "Meeting transcript:\n\n" + transcriptText },
              ],
              max_completion_tokens: 800,
            }),
          });
          if (!response.ok) {
            const errText = await response.text();
            sendError(res, 502, `LLM call failed: ${response.status} ${errText.slice(0, 200)}`);
            return;
          }
          const data = await response.json();
          const summary = String(
            data?.choices?.[0]?.message?.content
            ?? data?.choices?.[0]?.text
            ?? ""
          ).trim();
          if (!summary) {
            sendError(res, 502, "LLM returned no content.");
            return;
          }
          resolvedStore.updateMeeting(meetingId, { summary });
          sendResult(res, { summary, model: llmModel, transcript_count: transcripts.length });
        } catch (error) {
          sendError(res, 500, "Summary generation failed: " + (error instanceof Error ? error.message : String(error)));
        }
        return;
      }

      match = pathname.match(/^\/api\/meeting\/([^/]+)\/chat$/);
      if (match && req.method === "POST") {
        const meetingId = match[1];
        const meeting = resolvedStore.getMeeting(meetingId);
        if (!meeting) {
          sendError(res, 404, "Meeting not found.");
          return;
        }
        const body = (await readJsonBody(req)) ?? {};
        const userMessage = String(body.message ?? "").trim();
        const history = Array.isArray(body.history) ? body.history : [];
        if (!userMessage) {
          sendError(res, 400, "message is required.");
          return;
        }
        const appSettings = resolvedStore.getSettings();
        const llmSettings = resolveChatLlmSettings(pickSettings(appSettings, CHAT_LLM_SETTING_KEYS));
        const llmBaseUrl = llmSettings["chat.llm.baseUrl"];
        const llmApiKey = llmSettings["chat.llm.apiKey"];
        const llmKeyHeader = llmSettings["chat.llm.apiKeyHeader"];
        const llmModel = llmSettings["chat.llm.model"];
        if (!llmBaseUrl || !llmApiKey) {
          sendError(res, 400, "Chat LLM is not configured in Settings.");
          return;
        }
        const transcripts = (resolvedStore.listTranscripts(meetingId) || [])
          .slice()
          .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
        const transcriptText = transcripts
          .map((t) => String(t.text || "").trim())
          .filter(Boolean)
          .join("\n");
        const actions = resolvedStore.listProposedActions({ meetingId }) || [];
        const actionsBlock = actions.map((a) => {
          const argsStr = (() => {
            try { return JSON.stringify(a.tool_args ?? {}); } catch { return "{}"; }
          })();
          const labelMap = {
            applied: "Taken", auto_applied: "Auto-taken",
            rejected: "Dismissed", failed: "Failed", pending: "Proposed",
          };
          const label = a.undone_at ? "Reverted" : (labelMap[a.status] || a.status);
          return `- [${label}] ${a.tool_name}(${argsStr})`;
        }).join("\n");
        const project = String(appSettings["ado.project"] ?? "").trim();
        const activeItems = project ? (workItemCache.get(project)?.items ?? []) : [];
        const activeItemsBlock = activeItems.map((w) => {
          const type = w.type ? ` <${w.type}>` : "";
          const state = w.state ? ` [${w.state}]` : "";
          const assignee = w.assignee ? ` — ${w.assignee}` : "";
          return `- #${w.id}${type}: ${w.title || "(untitled)"}${state}${assignee}`;
        }).join("\n");
        const systemPrompt = [
          "You are an assistant that answers questions about a specific engineering status meeting.",
          "Below is everything you know: title, full transcript, any proposed/applied actions, any prior summary, and any cached active Azure DevOps work items.",
          "Answer the user's question concisely. If the meeting transcript doesn't contain the answer, say so plainly — do not invent facts.",
          "If the user asks about active work items or active user stories and the cached active work items list contains matching items, answer from that list.",
          "When summarizing or listing, use markdown bullet points.",
        ].join(" ");
        const contextText = [
          `# Meeting`,
          `Title: ${meeting.title || "(untitled)"}`,
          meeting.start_at ? `Started: ${new Date(Number(meeting.start_at) * 1000).toISOString()}` : "",
          meeting.end_at ? `Ended: ${new Date(Number(meeting.end_at) * 1000).toISOString()}` : "",
          "",
          meeting.summary ? "## Existing summary\n" + meeting.summary + "\n" : "",
          activeItemsBlock ? "## Cached active Azure DevOps work items\n" + activeItemsBlock + "\n" : "",
          actionsBlock ? "## Actions in this meeting\n" + actionsBlock + "\n" : "",
          "## Transcript",
          transcriptText || "(no transcript yet)",
        ].filter(Boolean).join("\n");
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: contextText },
          // Multi-turn history from the client (last N messages already in {role, content} form)
          ...history.filter((h) => h && typeof h.role === "string" && typeof h.content === "string").slice(-10),
          { role: "user", content: userMessage },
        ];
        try {
          const completionUrl = llmBaseUrl.replace(/\/+$/, "") + "/chat/completions";
          const response = await fetch(completionUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [llmKeyHeader]: llmApiKey,
            },
            body: JSON.stringify({
              model: llmModel,
              messages,
              max_completion_tokens: 1000,
            }),
          });
          if (!response.ok) {
            const errText = await response.text();
            sendError(res, 502, `Chat LLM call failed: ${response.status} ${errText.slice(0, 200)}`);
            return;
          }
          const data = await response.json();
          const reply = String(
            data?.choices?.[0]?.message?.content
            ?? data?.choices?.[0]?.text
            ?? ""
          ).trim();
          if (!reply) {
            sendError(res, 502, "LLM returned no content.");
            return;
          }
          sendResult(res, { reply, model: llmModel });
        } catch (error) {
          sendError(res, 500, "Chat call failed: " + (error instanceof Error ? error.message : String(error)));
        }
        return;
      }

      match = pathname.match(/^\/api\/meetings\/([^/]+)\/proposed-actions$/);
      if (match && req.method === "GET") {
        const meeting = resolvedStore.getMeeting(match[1]);
        if (!meeting) {
          sendError(res, 404, "Meeting not found.");
          return;
        }
        const status = String(requestUrl.searchParams.get("status") ?? "").trim();
        sendResult(res, resolvedStore.listProposedActions({
          meetingId: match[1],
          status: status || undefined,
        }));
        return;
      }

      match = pathname.match(/^\/api\/proposed-actions\/([^/]+)\/approve$/);
      if (match && req.method === "POST") {
        const id = match[1];
        const result = await executeProposedAction({ id, resolvedStore, runtime, autoApplied: false });
        if (result.status === 200 && result.action) {
          sendResult(res, result.action);
        } else if (result.action) {
          sendError(res, result.status, result.detail || "Failed", result.action);
        } else {
          sendError(res, result.status, result.detail || "Failed");
        }
        return;
      }

      match = pathname.match(/^\/api\/proposed-actions\/([^/]+)\/reject$/);
      if (match && req.method === "POST") {
        const action = resolvedStore.updateProposedActionStatus(match[1], {
          decidedAt: Date.now(),
          status: "rejected",
        });
        if (!action) {
          sendError(res, 404, "Proposed action not found.");
          return;
        }
        sendResult(res, action);
        return;
      }

      match = pathname.match(/^\/api\/proposed-actions\/([^/]+)\/undo$/);
      if (match && req.method === "POST") {
        const id = match[1];
        const existing = resolvedStore.getProposedAction(id);
        if (!existing) {
          sendError(res, 404, "Proposed action not found.");
          return;
        }
        if (!["applied", "auto_applied"].includes(existing.status)) {
          sendError(res, 400, `Cannot undo an action in status '${existing.status}'.`);
          return;
        }
        if (existing.undone_at) {
          sendError(res, 400, "Action is already undone.");
          return;
        }
        const toolName = String(existing.tool_name ?? "").trim();
        const existingResult = (existing.result && typeof existing.result === "object" && !Array.isArray(existing.result))
          ? existing.result
          : {};
        // Built-in stub: no real ADO mutation happened, so just flag undone.
        if (toolName === "propose_status_update") {
          const action = resolvedStore.updateProposedActionStatus(id, {
            undoneAt: Date.now(),
            resultJson: {
              ...existingResult,
              undone: true,
              undone_at: Date.now(),
            },
          });
          sendResult(res, action);
          return;
        }
        // Real MCP tool: we don't yet know how to invert arbitrary mutations.
        // Best we can do is mark undone in our DB and surface a note to the user.
        const action = resolvedStore.updateProposedActionStatus(id, {
          undoneAt: Date.now(),
          resultJson: {
            ...existingResult,
            undone: true,
            undone_at: Date.now(),
            note: "Local undo only. The underlying ADO change (if any) was NOT reversed automatically — open the work item link to revert manually.",
          },
        });
        sendResult(res, action);
        return;
      }

      sendError(res, 404, `Unhandled route: ${req.method} ${pathname}`);
    } catch (error) {
      if (res.headersSent || res.writableEnded || res.destroyed) {
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
        return;
      }
      sendError(res, 500, error instanceof Error ? error.message : "Unexpected server error.");
    }
  }

  return {
    async close() {
      if (activeAdoLogin?.child && !activeAdoLogin.child.killed) {
        activeAdoLogin.child.kill("SIGTERM");
      }
      await runtime.shutdown();
      if (ownsStore) {
        resolvedStore.close();
      }
    },
    handle,
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startServers({ uiDir, dataDir, logger = () => {}, store }) {
  logger(`starting servers uiDir=${uiDir} dataDir=${dataDir}`);
  const api = await createApiHandler({
    dataDir,
    logger,
    store,
  });
  const apiServer = http.createServer((req, res) => {
    void api.handle(req, res);
  });
  const uiServer = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${UI_PORT}`);
      // Redirect root to the realtime listen page (settings remains at /index.html)
      if (url.pathname === "/" || url.pathname === "") {
        res.writeHead(302, { Location: "/realtime-test.html" });
        res.end();
        return;
      }
    } catch {}
    serveStaticFile(uiDir, req, res);
  });

  await Promise.all([
    new Promise((resolve, reject) => {
      apiServer.once("error", reject);
      apiServer.listen(API_PORT, "127.0.0.1", () => {
        logger(`api listening on 127.0.0.1:${API_PORT}`);
        resolve();
      });
    }),
    new Promise((resolve, reject) => {
      uiServer.once("error", reject);
      uiServer.listen(UI_PORT, "127.0.0.1", () => {
        logger(`ui listening on 127.0.0.1:${UI_PORT}`);
        resolve();
      });
    }),
  ]);

  return {
    async close() {
      await Promise.allSettled([
        api.close(),
        closeServer(apiServer),
        closeServer(uiServer),
      ]);
    },
  };
}

module.exports = {
  API_PORT,
  UI_PORT,
  startServers,
};
