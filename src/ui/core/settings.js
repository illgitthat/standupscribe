const DEFAULT_POST_PROCESS_PRESET_ID = "preset-none";
const DEFAULT_SUMMARY_PROMPT =
  "Summarize this meeting with key discussion points, decisions made, action items with owners, and any unresolved questions or risks.";

export const DEFAULT_POST_PROCESS_PRESETS = [
  {
    id: "preset-none",
    name: "None",
    instructions: "",
  },
  {
    id: "preset-clean-transcript",
    name: "Clean transcript",
    instructions:
      "Clean this transcript:\n1. Fix spelling, capitalization, and punctuation errors\n2. Convert number words to digits (twenty-five → 25, ten percent → 10%, five dollars → $5)\n3. Replace spoken punctuation with symbols (period → ., comma → ,, question mark → ?)\n4. Remove filler words (um, uh, like as filler)\n5. Keep the language in the original version (if it was french, keep it in french for example)\n\nPreserve exact meaning and word order. Do not paraphrase or reorder content.",
  },
];

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
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return fallback;
    }
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function dedupeTextList(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? "").trim();
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

function normalizeNameCorrections(values) {
  const items = [];
  for (const value of Array.isArray(values) ? values : []) {
    const from = toText(value?.from ?? value?.source);
    const to = toText(value?.to ?? value?.target);
    if (!from || !to) {
      continue;
    }
    items.push({ from, to });
  }
  return items;
}

function normalizePostProcessPresets(values) {
  const rawPresets =
    Array.isArray(values) && values.length > 0
      ? values
      : DEFAULT_POST_PROCESS_PRESETS;
  const byId = new Map();

  for (const preset of rawPresets) {
    const id = toText(preset?.id);
    const name = toText(preset?.name ?? preset?.title);
    const instructions = toText(preset?.instructions ?? preset?.prompt);
    if (!id || !name || !instructions) {
      continue;
    }
    byId.set(id, { id, name, instructions });
  }

  for (const preset of DEFAULT_POST_PROCESS_PRESETS) {
    if (!byId.has(preset.id)) {
      byId.set(preset.id, { ...preset });
    }
  }

  return [...byId.values()];
}

export function normalizeStandupScribeSettings(settings = {}) {
  const adoMode = toText(settings["ado.mode"], "read-only") || "read-only";
  const adoApproval = toText(settings["ado.approval"], "confirm") || "confirm";
  return {
    "ado.approval": adoMode === "read-write"
      ? (["confirm", "auto-apply"].includes(adoApproval) ? adoApproval : "confirm")
      : "confirm",
    "ado.azureConfigDir": toText(settings["ado.azureConfigDir"]),
    "ado.enabled": toBoolean(settings["ado.enabled"]),
    "ado.mode": ["read-only", "read-write"].includes(adoMode) ? adoMode : "read-only",
    "ado.organization": toText(settings["ado.organization"], "") || "",
    "ado.project": toText(settings["ado.project"]),
    "ado.tenantId": toText(settings["ado.tenantId"], "") || "",
    "azure.openai.apiKey": toText(settings["azure.openai.apiKey"]),
    "azure.openai.baseUrl": toText(settings["azure.openai.baseUrl"]),
    "azure.openai.realtimeDeployment": toText(settings["azure.openai.realtimeDeployment"], "gpt-realtime-2") || "gpt-realtime-2",
    "azure.openai.transcriptionDeployment": toText(settings["azure.openai.transcriptionDeployment"], "gpt-realtime-whisper") || "gpt-realtime-whisper",
    "chat.llm.apiKey": toText(settings["chat.llm.apiKey"]),
    "chat.llm.apiKeyHeader": toText(settings["chat.llm.apiKeyHeader"], "api-key") || "api-key",
    "chat.llm.baseUrl": toText(settings["chat.llm.baseUrl"]),
    "chat.llm.model": toText(settings["chat.llm.model"], "gpt-5-mini") || "gpt-5-mini",
    custom_words: dedupeTextList(settings.custom_words),
    default_summary_prompt:
      toText(settings.default_summary_prompt, DEFAULT_SUMMARY_PROMPT) ||
      DEFAULT_SUMMARY_PROMPT,
    filler_words: dedupeTextList(settings.filler_words),
    name_corrections: normalizeNameCorrections(settings.name_corrections),
    onboarding_completed: toBoolean(settings.onboarding_completed),
    post_process_presets: normalizePostProcessPresets(
      settings.post_process_presets,
    ),
    selected_post_process_preset_id:
      toText(
        settings.selected_post_process_preset_id,
        DEFAULT_POST_PROCESS_PRESET_ID,
      ) || DEFAULT_POST_PROCESS_PRESET_ID,
  };
}

export function getSelectedPostProcessPreset(settings = {}) {
  const presets = normalizePostProcessPresets(settings.post_process_presets);
  const selectedId = toText(
    settings.selected_post_process_preset_id,
    DEFAULT_POST_PROCESS_PRESET_ID,
  );
  return (
    presets.find((preset) => preset.id === selectedId) ??
    presets[0] ??
    DEFAULT_POST_PROCESS_PRESETS[0]
  );
}
