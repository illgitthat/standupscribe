const DEFAULT_SUMMARY_PROMPT = "Summarize this meeting with key discussion points, decisions made, action items with owners, and any unresolved questions or risks.";

const DEFAULT_POST_PROCESS_PRESETS = [
  {
    id: "preset-none",
    name: "None",
    instructions: "",
  },
  {
    id: "preset-clean-transcript",
    name: "Clean transcript",
    instructions: "Clean this transcript:\n1. Fix spelling, capitalization, and punctuation errors\n2. Convert number words to digits (twenty-five → 25, ten percent → 10%, five dollars → $5)\n3. Replace spoken punctuation with symbols (period → ., comma → ,, question mark → ?)\n4. Remove filler words (um, uh, like as filler)\n5. Keep the language in the original version (if it was french, keep it in french for example)\n\nPreserve exact meaning and word order. Do not paraphrase or reorder content.",
  },
];

const DEFAULT_SETTINGS = {
  "ado.approval": "confirm",
  "ado.azureConfigDir": "",
  "ado.enabled": false,
  "ado.mode": "read-only",
  "ado.organization": "",
  "ado.project": "",
  "ado.tenantId": "",
  "azure.openai.apiKey": "",
  "azure.openai.baseUrl": "",
  "azure.openai.realtimeDeployment": "gpt-realtime-2",
  "azure.openai.transcriptionDeployment": "gpt-realtime-whisper",
  "chat.llm.apiKey": "",
  "chat.llm.apiKeyHeader": "api-key",
  "chat.llm.baseUrl": "",
  "chat.llm.model": "gpt-5-mini",
  custom_words: [],
  default_summary_prompt: DEFAULT_SUMMARY_PROMPT,
  filler_words: [],
  onboarding_completed: false,
  post_process_presets: DEFAULT_POST_PROCESS_PRESETS,
  selected_post_process_preset_id: "preset-none",
};

const DEFAULT_CURRENT_STATE = {
  active_meeting_id: null,
  active_meeting_status: "idle",
};

module.exports = {
  DEFAULT_CURRENT_STATE,
  DEFAULT_POST_PROCESS_PRESETS,
  DEFAULT_SETTINGS,
  DEFAULT_SUMMARY_PROMPT,
};
