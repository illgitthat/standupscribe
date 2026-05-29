const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const {
  DEFAULT_SETTINGS,
} = require("./defaults");
const { generateOpaqueId } = require("./ids");

function nowSeconds() {
  return Math.round(Date.now()) / 1000;
}

function nowMilliseconds() {
  return Date.now();
}

function formatDefaultMeetingTitle(timestampSeconds = nowSeconds()) {
  const meetingDate = new Date(Number(timestampSeconds) * 1000);
  const dateLabel = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(meetingDate);
  const timeLabel = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(meetingDate);
  return `${dateLabel} at ${timeLabel}`;
}

function parseJsonValue(value, fallback = null) {
  const text = String(value ?? "").trim();
  if (!text) {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toJsonString(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

function toText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function toBoolean(value, fallback = false) {
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

function dedupeTextList(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = toText(value);
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(text);
  }
  return result;
}

function normalizePostProcessPresets(values) {
  const defaults = Array.isArray(DEFAULT_SETTINGS.post_process_presets)
    ? DEFAULT_SETTINGS.post_process_presets.map((preset) => ({ ...preset }))
    : [];
  const merged = new Map(defaults.map((preset) => [preset.id, preset]));
  for (const value of Array.isArray(values) ? values : []) {
    const id = toText(value?.id);
    const name = toText(value?.name);
    const instructions = String(value?.instructions ?? "");
    if (!id || !name) {
      continue;
    }
    merged.set(id, { id, name, instructions });
  }
  return [...merged.values()];
}

function normalizeSettings(settings = {}) {
  const adoMode = toText(settings["ado.mode"], DEFAULT_SETTINGS["ado.mode"]) || DEFAULT_SETTINGS["ado.mode"];
  const adoApproval = toText(settings["ado.approval"], DEFAULT_SETTINGS["ado.approval"]) || DEFAULT_SETTINGS["ado.approval"];
  return {
    "ado.approval": adoMode === "read-write"
      ? (["confirm", "auto-apply"].includes(adoApproval) ? adoApproval : DEFAULT_SETTINGS["ado.approval"])
      : "confirm",
    "ado.azureConfigDir": toText(settings["ado.azureConfigDir"], DEFAULT_SETTINGS["ado.azureConfigDir"]),
    "ado.enabled": toBoolean(settings["ado.enabled"], DEFAULT_SETTINGS["ado.enabled"]),
    "ado.mode": ["read-only", "read-write"].includes(adoMode) ? adoMode : DEFAULT_SETTINGS["ado.mode"],
    "ado.organization": toText(settings["ado.organization"], DEFAULT_SETTINGS["ado.organization"]) || DEFAULT_SETTINGS["ado.organization"],
    "ado.project": toText(settings["ado.project"]),
    "ado.tenantId": toText(settings["ado.tenantId"], DEFAULT_SETTINGS["ado.tenantId"]) || DEFAULT_SETTINGS["ado.tenantId"],
    "azure.openai.apiKey": toText(settings["azure.openai.apiKey"]),
    "azure.openai.baseUrl": toText(settings["azure.openai.baseUrl"]),
    "azure.openai.realtimeDeployment": toText(settings["azure.openai.realtimeDeployment"], DEFAULT_SETTINGS["azure.openai.realtimeDeployment"]) || DEFAULT_SETTINGS["azure.openai.realtimeDeployment"],
    "azure.openai.transcriptionDeployment": toText(settings["azure.openai.transcriptionDeployment"], DEFAULT_SETTINGS["azure.openai.transcriptionDeployment"]) || DEFAULT_SETTINGS["azure.openai.transcriptionDeployment"],
    "chat.llm.apiKey": toText(settings["chat.llm.apiKey"]),
    "chat.llm.apiKeyHeader": toText(settings["chat.llm.apiKeyHeader"], DEFAULT_SETTINGS["chat.llm.apiKeyHeader"]) || DEFAULT_SETTINGS["chat.llm.apiKeyHeader"],
    "chat.llm.baseUrl": toText(settings["chat.llm.baseUrl"]),
    "chat.llm.model": toText(settings["chat.llm.model"], DEFAULT_SETTINGS["chat.llm.model"]) || DEFAULT_SETTINGS["chat.llm.model"],
    custom_words: dedupeTextList(settings.custom_words),
    default_summary_prompt: toText(settings.default_summary_prompt, DEFAULT_SETTINGS.default_summary_prompt) || DEFAULT_SETTINGS.default_summary_prompt,
    filler_words: dedupeTextList(settings.filler_words),
    onboarding_completed: toBoolean(settings.onboarding_completed, DEFAULT_SETTINGS.onboarding_completed),
    post_process_presets: normalizePostProcessPresets(settings.post_process_presets),
    selected_post_process_preset_id: toText(settings.selected_post_process_preset_id, DEFAULT_SETTINGS.selected_post_process_preset_id) || DEFAULT_SETTINGS.selected_post_process_preset_id,
  };
}

class StandupScribeStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, "standupscribe.db");
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    const legacySettings = this.readLegacySettings();
    this.dropLegacyTables();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meetings (
        meeting_id TEXT PRIMARY KEY,
        title TEXT,
        notes TEXT,
        start_at REAL NOT NULL,
        end_at REAL,
        summary TEXT
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        id TEXT PRIMARY KEY,
        meeting_id TEXT,
        item_id TEXT,
        speaker_label TEXT,
        text TEXT NOT NULL,
        start_ms INTEGER,
        end_ms INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (meeting_id) REFERENCES meetings(meeting_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_transcripts_meeting
      ON transcripts(meeting_id, created_at);
      CREATE TABLE IF NOT EXISTS proposed_actions (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        transcript_item_id TEXT,
        transcript_snippet TEXT,
        tool_name TEXT NOT NULL,
        tool_args_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','applied','auto_applied','failed')),
        result_json TEXT,
        error TEXT,
        decided_at INTEGER,
        applied_at INTEGER,
        undone_at INTEGER,
        ado_item_url TEXT,
        FOREIGN KEY (meeting_id) REFERENCES meetings(meeting_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_proposed_actions_meeting
      ON proposed_actions (meeting_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_proposed_actions_status
      ON proposed_actions (status);
    `);
    // Migration: add undone_at column if it doesn't exist (older DBs)
    try {
      const columns = this.db.prepare("PRAGMA table_info(proposed_actions)").all();
      if (!columns.some((c) => c.name === "undone_at")) {
        this.db.exec("ALTER TABLE proposed_actions ADD COLUMN undone_at INTEGER");
      }
    } catch {
      /* table might not exist yet on a totally fresh DB; the CREATE above handles it */
    }
    this.ensureSettingsRow({
      ...DEFAULT_SETTINGS,
      ...(legacySettings ?? {}),
    });
    this.seedAzureOpenAiSettingsFromEnv();
    this.seedChatLlmSettingsFromEnv();
  }

  close() {
    this.db.close();
  }

  readLegacySettings() {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    if (!tables.some((row) => row.name === "app_state")) {
      return null;
    }
    const row = this.db.prepare("SELECT value_json FROM app_state WHERE key = ?").get("settings");
    return parseJsonValue(row?.value_json, null);
  }

  dropLegacyTables() {
    const explicitNames = new Set([
      "app_state",
      "speakers",
      "recording_chunks",
      "recordings",
      "audio_chunks",
      "chunks",
      "transcriptions",
      "transcription_jobs",
      "transcription_results",
      "model_download_state",
      "diarization_state",
    ]);
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    for (const row of rows) {
      const name = String(row.name ?? "").trim();
      if (!name || name.startsWith("sqlite_")) {
        continue;
      }
      if (
        explicitNames.has(name)
        || name.startsWith("speaker_")
        || name.includes("diarization")
        || name.includes("model_download")
      ) {
        const escapedName = name.replace(/"/g, '""');
        this.db.exec(`DROP TABLE IF EXISTS "${escapedName}"`);
      }
    }
  }

  ensureSettingsRow(value) {
    this.db
      .prepare("INSERT OR IGNORE INTO settings (key, value_json) VALUES (?, ?)")
      .run("settings", JSON.stringify(normalizeSettings(value)));
  }

  getSettings() {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get("settings");
    return normalizeSettings(parseJsonValue(row?.value_json, DEFAULT_SETTINGS));
  }

  updateSettings(nextSettings) {
    const merged = normalizeSettings({
      ...this.getSettings(),
      ...(nextSettings ?? {}),
    });
    this.db
      .prepare(`
        INSERT INTO settings (key, value_json)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `)
      .run("settings", JSON.stringify(merged));
    return merged;
  }

  seedAzureOpenAiSettingsFromEnv() {
    const currentSettings = this.getSettings();
    const patch = {};
    const looksMasked = (v) => typeof v === "string" && v.length > 0 && /^\*+/.test(v);
    if (!currentSettings["azure.openai.baseUrl"] && process.env.AZURE_OPENAI_BASE_URL) {
      patch["azure.openai.baseUrl"] = process.env.AZURE_OPENAI_BASE_URL;
    }
    // Re-seed from env if stored value is empty OR was corrupted with a mask placeholder
    if ((!currentSettings["azure.openai.apiKey"] || looksMasked(currentSettings["azure.openai.apiKey"])) && process.env.AZURE_OPENAI_API_KEY) {
      patch["azure.openai.apiKey"] = process.env.AZURE_OPENAI_API_KEY;
    }
    if (!currentSettings["azure.openai.realtimeDeployment"] && process.env.AZURE_OPENAI_DEPLOYMENT_NAME) {
      patch["azure.openai.realtimeDeployment"] = process.env.AZURE_OPENAI_DEPLOYMENT_NAME;
    }
    if (!currentSettings["azure.openai.transcriptionDeployment"] && process.env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT_NAME) {
      patch["azure.openai.transcriptionDeployment"] = process.env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT_NAME;
    }
    if (Object.keys(patch).length > 0) {
      this.updateSettings(patch);
    }
  }

  seedChatLlmSettingsFromEnv() {
    const currentSettings = this.getSettings();
    const patch = {};
    const looksMasked = (v) => typeof v === "string" && v.length > 0 && /^\*+/.test(v);
    if (!currentSettings["chat.llm.baseUrl"] && process.env.STANDUPSCRIBE_LLM_BASE_URL) {
      patch["chat.llm.baseUrl"] = process.env.STANDUPSCRIBE_LLM_BASE_URL;
    }
    if ((!currentSettings["chat.llm.apiKey"] || looksMasked(currentSettings["chat.llm.apiKey"])) && process.env.STANDUPSCRIBE_LLM_API_KEY) {
      patch["chat.llm.apiKey"] = process.env.STANDUPSCRIBE_LLM_API_KEY;
    }
    if (!currentSettings["chat.llm.apiKeyHeader"] && process.env.STANDUPSCRIBE_LLM_API_KEY_HEADER) {
      patch["chat.llm.apiKeyHeader"] = process.env.STANDUPSCRIBE_LLM_API_KEY_HEADER;
    }
    if (!currentSettings["chat.llm.model"] && process.env.STANDUPSCRIBE_LLM_MODEL) {
      patch["chat.llm.model"] = process.env.STANDUPSCRIBE_LLM_MODEL;
    }
    if (Object.keys(patch).length > 0) {
      this.updateSettings(patch);
    }
  }

  createMeeting() {
    const meetingId = generateOpaqueId();
    const startedAt = nowSeconds();
    this.db
      .prepare(`
        INSERT INTO meetings (meeting_id, title, notes, start_at, end_at, summary)
        VALUES (?, ?, NULL, ?, NULL, NULL)
      `)
      .run(meetingId, formatDefaultMeetingTitle(startedAt), startedAt);
    return this.getMeeting(meetingId);
  }

  getMeetings() {
    return this.db
      .prepare(`
        SELECT
          m.meeting_id,
          m.title,
          m.notes,
          m.start_at,
          m.end_at,
          m.summary,
          (
            SELECT COUNT(*)
            FROM transcripts t
            WHERE t.meeting_id = m.meeting_id
          ) AS transcript_count,
          (
            SELECT MAX(t.created_at)
            FROM transcripts t
            WHERE t.meeting_id = m.meeting_id
          ) AS last_activity_at
        FROM meetings m
        ORDER BY m.start_at DESC, m.meeting_id DESC
      `)
      .all()
      .map((row) => this.rowToMeeting(row));
  }

  getMeeting(meetingId) {
    const row = this.db
      .prepare(`
        SELECT
          m.meeting_id,
          m.title,
          m.notes,
          m.start_at,
          m.end_at,
          m.summary,
          (
            SELECT COUNT(*)
            FROM transcripts t
            WHERE t.meeting_id = m.meeting_id
          ) AS transcript_count,
          (
            SELECT MAX(t.created_at)
            FROM transcripts t
            WHERE t.meeting_id = m.meeting_id
          ) AS last_activity_at
        FROM meetings m
        WHERE m.meeting_id = ?
      `)
      .get(meetingId);
    return row ? this.rowToMeeting(row) : null;
  }

  updateMeeting(meetingId, patch = {}) {
    const current = this.getMeeting(meetingId);
    if (!current) {
      return null;
    }
    this.db
      .prepare(`
        UPDATE meetings
        SET title = ?, notes = ?, end_at = ?, summary = ?
        WHERE meeting_id = ?
      `)
      .run(
        Object.prototype.hasOwnProperty.call(patch, "title") ? patch.title : current.title,
        Object.prototype.hasOwnProperty.call(patch, "notes") ? patch.notes : current.notes,
        Object.prototype.hasOwnProperty.call(patch, "end_at") ? patch.end_at : current.end_at,
        Object.prototype.hasOwnProperty.call(patch, "summary") ? patch.summary : current.summary,
        meetingId,
      );
    return this.getMeeting(meetingId);
  }

  deleteMeeting(meetingId) {
    const current = this.getMeeting(meetingId);
    if (!current) {
      return null;
    }
    this.db.prepare("DELETE FROM meetings WHERE meeting_id = ?").run(meetingId);
    return current;
  }

  insertTranscript(meetingId, itemId, text, startMs, endMs, speakerLabel = null) {
    const transcriptId = generateOpaqueId();
    this.db
      .prepare(`
        INSERT INTO transcripts (id, meeting_id, item_id, speaker_label, text, start_ms, end_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        transcriptId,
        meetingId ?? null,
        toText(itemId) || null,
        toText(speakerLabel) || null,
        String(text ?? "").trim(),
        Number.isFinite(Number(startMs)) ? Number(startMs) : null,
        Number.isFinite(Number(endMs)) ? Number(endMs) : null,
        nowMilliseconds(),
      );
    return this.getTranscript(meetingId, transcriptId);
  }

  listTranscripts(meetingId) {
    return this.db
      .prepare(`
        SELECT id, meeting_id, item_id, speaker_label, text, start_ms, end_ms, created_at
        FROM transcripts
        WHERE meeting_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .all(meetingId)
      .map((row) => this.rowToTranscript(row));
  }

  getTranscript(meetingId, transcriptId) {
    const row = this.db
      .prepare(`
        SELECT id, meeting_id, item_id, speaker_label, text, start_ms, end_ms, created_at
        FROM transcripts
        WHERE meeting_id = ? AND id = ?
      `)
      .get(meetingId, transcriptId);
    return row ? this.rowToTranscript(row) : null;
  }

  updateTranscript(meetingId, transcriptId, patch = {}) {
    const current = this.getTranscript(meetingId, transcriptId);
    if (!current) {
      return null;
    }
    this.db
      .prepare(`
        UPDATE transcripts
        SET item_id = ?, speaker_label = ?, text = ?, start_ms = ?, end_ms = ?
        WHERE meeting_id = ? AND id = ?
      `)
      .run(
        Object.prototype.hasOwnProperty.call(patch, "item_id") ? patch.item_id : current.item_id,
        Object.prototype.hasOwnProperty.call(patch, "speaker_label") ? patch.speaker_label : current.speaker_label,
        Object.prototype.hasOwnProperty.call(patch, "text") ? patch.text : current.text,
        Object.prototype.hasOwnProperty.call(patch, "start_ms") ? patch.start_ms : current.start_ms,
        Object.prototype.hasOwnProperty.call(patch, "end_ms") ? patch.end_ms : current.end_ms,
        meetingId,
        transcriptId,
      );
    return this.getTranscript(meetingId, transcriptId);
  }

  createProposedAction({ meetingId, transcriptItemId, transcriptSnippet, toolName, toolArgs } = {}) {
    const actionId = generateOpaqueId();
    this.db
      .prepare(`
        INSERT INTO proposed_actions (
          id, meeting_id, created_at, transcript_item_id, transcript_snippet,
          tool_name, tool_args_json, status, result_json, error, decided_at,
          applied_at, ado_item_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL)
      `)
      .run(
        actionId,
        meetingId,
        nowMilliseconds(),
        transcriptItemId ?? null,
        transcriptSnippet ?? null,
        toText(toolName),
        toJsonString(toolArgs, {}),
      );
    return this.getProposedAction(actionId);
  }

  listProposedActions({ meetingId, status } = {}) {
    const filters = [];
    const values = [];
    if (meetingId) {
      filters.push("meeting_id = ?");
      values.push(meetingId);
    }
    if (status) {
      filters.push("status = ?");
      values.push(status);
    }
    const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    return this.db
      .prepare(`
        SELECT
          id,
          meeting_id,
          created_at,
          transcript_item_id,
          transcript_snippet,
          tool_name,
          tool_args_json,
          status,
          result_json,
          error,
          decided_at,
          applied_at,
          undone_at,
          ado_item_url
        FROM proposed_actions
        ${whereClause}
        ORDER BY created_at DESC, id DESC
      `)
      .all(...values)
      .map((row) => this.rowToProposedAction(row));
  }

  getProposedAction(id) {
    const row = this.db
      .prepare(`
        SELECT
          id,
          meeting_id,
          created_at,
          transcript_item_id,
          transcript_snippet,
          tool_name,
          tool_args_json,
          status,
          result_json,
          error,
          decided_at,
          applied_at,
          undone_at,
          ado_item_url
        FROM proposed_actions
        WHERE id = ?
      `)
      .get(id);
    return row ? this.rowToProposedAction(row) : null;
  }

  updateProposedActionStatus(id, patch = {}) {
    const current = this.getProposedAction(id);
    if (!current) {
      return null;
    }
    this.db
      .prepare(`
        UPDATE proposed_actions
        SET status = ?, result_json = ?, error = ?, ado_item_url = ?, decided_at = ?, applied_at = ?, undone_at = ?
        WHERE id = ?
      `)
      .run(
        toText(patch.status, current.status) || current.status,
        Object.prototype.hasOwnProperty.call(patch, "resultJson")
          ? (patch.resultJson === null ? null : toJsonString(patch.resultJson, {}))
          : current.result_json,
        Object.prototype.hasOwnProperty.call(patch, "error") ? patch.error : current.error,
        Object.prototype.hasOwnProperty.call(patch, "adoItemUrl") ? patch.adoItemUrl : current.ado_item_url,
        Object.prototype.hasOwnProperty.call(patch, "decidedAt") ? patch.decidedAt : current.decided_at,
        Object.prototype.hasOwnProperty.call(patch, "appliedAt") ? patch.appliedAt : current.applied_at,
        Object.prototype.hasOwnProperty.call(patch, "undoneAt") ? patch.undoneAt : current.undone_at,
        id,
      );
    return this.getProposedAction(id);
  }

  rowToMeeting(row) {
    return {
      meeting_id: row.meeting_id,
      title: row.title,
      notes: row.notes,
      start_at: row.start_at,
      end_at: row.end_at,
      summary: row.summary,
      transcript_count: Number(row.transcript_count ?? 0) || 0,
      last_activity_at: row.last_activity_at ?? null,
    };
  }

  rowToTranscript(row) {
    return {
      id: row.id,
      meeting_id: row.meeting_id,
      item_id: row.item_id ?? null,
      speaker_label: row.speaker_label ?? null,
      text: row.text,
      start_ms: row.start_ms ?? null,
      end_ms: row.end_ms ?? null,
      created_at: row.created_at,
    };
  }

  rowToProposedAction(row) {
    return {
      ado_item_url: row.ado_item_url ?? null,
      applied_at: row.applied_at ?? null,
      undone_at: row.undone_at ?? null,
      created_at: row.created_at,
      decided_at: row.decided_at ?? null,
      error: row.error ?? null,
      id: row.id,
      meeting_id: row.meeting_id,
      result: parseJsonValue(row.result_json),
      result_json: row.result_json ?? null,
      status: row.status,
      tool_args: parseJsonValue(row.tool_args_json, {}),
      tool_args_json: row.tool_args_json,
      tool_name: row.tool_name,
      transcript_item_id: row.transcript_item_id ?? null,
      transcript_snippet: row.transcript_snippet ?? null,
    };
  }
}

module.exports = {
  StandupScribeStore,
};
