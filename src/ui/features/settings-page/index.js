import {
  getSelectedPostProcessPreset,
  normalizeStandupScribeSettings,
} from "../../core/settings.js";
import { showToast } from "../../core/toast.js";

const API_BASE = "http://127.0.0.1:12453";
const DEFAULT_SUMMARY_PROMPT = "Summarize this meeting with key discussion points, decisions made, action items with owners, and any unresolved questions or risks.";
const DEFAULT_CLEAN_TRANSCRIPT_PROMPT = "Clean this transcript:\n1. Fix spelling, capitalization, and punctuation errors\n2. Convert number words to digits (twenty-five → 25, ten percent → 10%, five dollars → $5)\n3. Replace spoken punctuation with symbols (period → ., comma → ,, question mark → ?)\n4. Remove filler words (um, uh, like as filler)\n5. Keep the language in the original version (if it was french, keep it in french for example)\n\nPreserve exact meaning and word order. Do not paraphrase or reorder content.";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseList(value) {
  const seen = new Set();
  const items = [];
  for (const part of String(value ?? "").split(/[\n,]/g)) {
    const text = part.trim();
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(text);
  }
  return items;
}

function listToField(value) {
  return safeArray(value).join("\n");
}

function createInitialAdoAuthState() {
  return {
    account_email: null,
    checking: true,
    code: "",
    error: "",
    installed: false,
    logged_in: false,
    open: false,
    running: false,
    tenant_id: null,
    url: "",
  };
}

function createRoot() {
  const root = document.createElement("section");
  root.className = "rr-settings-page";
  root.innerHTML = `
    <div class="rr-settings-page__hero">
      <div class="rr-settings-page__hero-copy">
        <p class="rr-settings-page__eyebrow">StandupScribe</p>
        <h1 class="rr-settings-page__title">Settings</h1>
        <p class="rr-settings-page__subtitle">Azure realtime, Azure DevOps, and summary chat configuration.</p>
      </div>
    </div>
    <div class="rr-settings-page__banner" data-role="banner" hidden></div>
    <form class="rr-settings-page__form" data-role="form">
      <div class="rr-settings-page__grid">
        <section class="rr-settings-card">
          <div class="rr-settings-card__header">
            <div>
              <h2 class="rr-settings-card__title">Azure OpenAI Realtime</h2>
            </div>
            <p class="rr-settings-card__note">Used by /api/realtime/connect.</p>
          </div>
          <div class="rr-settings-card__body">
            <label class="rr-settings-field"><span class="rr-settings-field__label">Base URL</span><input class="rr-settings-field__input" data-role="azure-openai-base-url" type="url" placeholder="https://your-resource.openai.azure.com/openai/v1" /></label>
            <label class="rr-settings-field"><span class="rr-settings-field__label">API key</span><input class="rr-settings-field__input" data-role="azure-openai-api-key" type="password" /></label>
            <label class="rr-settings-field"><span class="rr-settings-field__label">Realtime deployment</span><input class="rr-settings-field__input" data-role="azure-openai-realtime-deployment" type="text" /></label>
            <label class="rr-settings-field"><span class="rr-settings-field__label">Transcription deployment</span><input class="rr-settings-field__input" data-role="azure-openai-transcription-deployment" type="text" /></label>
            <div class="rr-settings-action-row">
              <button class="rr-settings-page__button" data-action="test-azure-openai" type="button">Test connection</button>
            </div>
          </div>
        </section>
        <section class="rr-settings-card">
          <div class="rr-settings-card__header">
            <div>
              <h2 class="rr-settings-card__title">Chat LLM (for summaries)</h2>
            </div>
            <p class="rr-settings-card__note">Required for end-of-meeting summaries.</p>
          </div>
          <div class="rr-settings-card__body">
            <label class="rr-settings-field"><span class="rr-settings-field__label">Base URL</span><input class="rr-settings-field__input" data-role="chat-llm-base-url" type="url" placeholder="https://your-resource.openai.azure.com/openai/v1" /></label>
            <label class="rr-settings-field"><span class="rr-settings-field__label">API key</span><input class="rr-settings-field__input" data-role="chat-llm-api-key" type="password" /></label>
            <label class="rr-settings-field"><span class="rr-settings-field__label">API key header</span><input class="rr-settings-field__input" data-role="chat-llm-api-key-header" type="text" /></label>
            <label class="rr-settings-field"><span class="rr-settings-field__label">Model deployment name</span><input class="rr-settings-field__input" data-role="chat-llm-model" type="text" /></label>
            <p class="rr-settings-field__hint">Required for end-of-meeting summaries. Should point to an Azure OpenAI Chat Completions deployment.</p>
            <div class="rr-settings-action-row">
              <button class="rr-settings-page__button" data-action="test-chat-llm" type="button">Test connection</button>
            </div>
          </div>
        </section>
        <section class="rr-settings-card">
          <div class="rr-settings-card__header">
            <div>
              <h2 class="rr-settings-card__title">Azure DevOps</h2>
            </div>
            <p class="rr-settings-card__note">Controls proposed work-item staging.</p>
          </div>
          <div class="rr-settings-card__body">
            <label class="rr-settings-field rr-settings-field--inline">
              <input data-role="ado-enabled" type="checkbox" />
              <span class="rr-settings-field__label">Enabled</span>
            </label>
            <label class="rr-settings-field"><span class="rr-settings-field__label">Organization</span><input class="rr-settings-field__input" data-role="ado-organization" type="text" /></label>
            <label class="rr-settings-field"><span class="rr-settings-field__label">Project</span><input class="rr-settings-field__input" data-role="ado-project" type="text" /></label>
            <label class="rr-settings-field"><span class="rr-settings-field__label">Tenant ID</span><input class="rr-settings-field__input" data-role="ado-tenant-id" type="text" /></label>
            <fieldset class="rr-settings-choice-group">
              <legend class="rr-settings-field__label">Mode</legend>
              <label class="rr-settings-choice"><input data-role="ado-mode" name="ado-mode" type="radio" value="read-only" /><span>Read-only</span></label>
              <label class="rr-settings-choice"><input data-role="ado-mode" name="ado-mode" type="radio" value="read-write" /><span>Read &amp; write</span></label>
            </fieldset>
            <fieldset class="rr-settings-choice-group" data-role="ado-approval-fieldset">
              <legend class="rr-settings-field__label">Approval</legend>
              <label class="rr-settings-choice"><input data-role="ado-approval" name="ado-approval" type="radio" value="confirm" /><span>Confirm each action</span></label>
              <label class="rr-settings-choice"><input data-role="ado-approval" name="ado-approval" type="radio" value="auto-apply" /><span>Auto-apply</span></label>
            </fieldset>
            <p class="rr-settings-field__hint" data-role="ado-approval-note" hidden>Approval stays on confirm while Azure DevOps is in read-only mode.</p>
            <div class="rr-settings-warning" data-role="ado-auto-apply-warning" hidden>⚠️ This will modify Azure DevOps work items without confirmation.</div>
            <div class="rr-settings-panel">
              <div class="rr-settings-panel__title-row">
                <span class="rr-settings-panel__title">Azure CLI authentication</span>
                <span class="rr-settings-panel__badge" data-role="ado-auth-badge">Checking…</span>
              </div>
              <p class="rr-settings-panel__copy" data-role="ado-auth-status">Status: Checking…</p>
              <div class="rr-settings-action-row">
                <button class="rr-settings-page__button" data-action="ado-login" type="button">Sign in to Azure DevOps</button>
                <button class="rr-settings-page__button" data-action="ado-logout" data-variant="secondary" type="button">Sign out</button>
              </div>
              <div class="rr-settings-panel" data-role="ado-auth-panel" hidden>
                <div class="rr-settings-panel__title-row">
                  <span class="rr-settings-panel__title">Device code sign-in</span>
                  <span class="rr-settings-panel__badge" data-role="ado-auth-panel-badge">Waiting…</span>
                </div>
                <p class="rr-settings-panel__copy" data-role="ado-auth-panel-text">Waiting for Azure CLI…</p>
                <div class="rr-settings-action-row" data-role="ado-auth-copy-row" hidden>
                  <button class="rr-settings-page__button" data-action="ado-copy-code" data-variant="secondary" type="button">Copy code</button>
                  <button class="rr-settings-page__button" data-action="ado-open-url" data-variant="secondary" type="button">Open sign-in page</button>
                </div>
                <div class="rr-settings-warning" data-role="ado-auth-error" hidden></div>
              </div>
            </div>
            <div class="rr-settings-action-row">
              <button class="rr-settings-page__button" data-action="test-ado" type="button">Test connection</button>
            </div>
          </div>
        </section>
        <section class="rr-settings-card">
          <div class="rr-settings-card__header">
            <div>
              <h2 class="rr-settings-card__title">Summary prompt</h2>
            </div>
          </div>
          <div class="rr-settings-card__body">
            <textarea class="rr-settings-panel__textarea" data-role="summary-prompt">${DEFAULT_SUMMARY_PROMPT}</textarea>
          </div>
        </section>
        <section class="rr-settings-card">
          <div class="rr-settings-card__header">
            <div>
              <h2 class="rr-settings-card__title">Transcript cleanup</h2>
            </div>
            <p class="rr-settings-card__note">Keeps the raw transcript unchanged.</p>
          </div>
          <div class="rr-settings-card__body">
            <label class="rr-settings-field"><span class="rr-settings-field__label">Glossary</span><span class="rr-settings-field__hint">One term per line.</span><textarea class="rr-settings-panel__textarea rr-settings-textarea-compact" data-role="custom-words" placeholder="e.g. StandupScribe&#10;Kubernetes&#10;OAuth"></textarea></label>
            <label class="rr-settings-field rr-settings-field--inline">
              <input data-role="cleanup-enabled" type="checkbox" />
              <span class="rr-settings-field__label">Auto-clean transcript</span>
            </label>
            <label class="rr-settings-field" data-role="cleanup-prompt-field">
              <span class="rr-settings-field__label">Cleanup prompt</span>
              <textarea class="rr-settings-panel__textarea" data-role="cleanup-prompt"></textarea>
            </label>
          </div>
        </section>
      </div>
      <div class="rr-settings-action-row" style="margin-top: 16px;">
        <button class="rr-settings-page__button" data-action="save" type="submit">Save settings</button>
      </div>
    </form>
  `;
  return {
    root,
    refs: {
      adoApprovalFieldset: root.querySelector('[data-role="ado-approval-fieldset"]'),
      adoApprovalInputs: [...root.querySelectorAll('[data-role="ado-approval"]')],
      adoApprovalNote: root.querySelector('[data-role="ado-approval-note"]'),
      adoAutoApplyWarning: root.querySelector('[data-role="ado-auto-apply-warning"]'),
      adoAuthBadge: root.querySelector('[data-role="ado-auth-badge"]'),
      adoAuthCopyRow: root.querySelector('[data-role="ado-auth-copy-row"]'),
      adoAuthError: root.querySelector('[data-role="ado-auth-error"]'),
      adoAuthPanel: root.querySelector('[data-role="ado-auth-panel"]'),
      adoAuthPanelBadge: root.querySelector('[data-role="ado-auth-panel-badge"]'),
      adoAuthPanelText: root.querySelector('[data-role="ado-auth-panel-text"]'),
      adoAuthStatus: root.querySelector('[data-role="ado-auth-status"]'),
      adoEnabled: root.querySelector('[data-role="ado-enabled"]'),
      adoModeInputs: [...root.querySelectorAll('[data-role="ado-mode"]')],
      adoOrganization: root.querySelector('[data-role="ado-organization"]'),
      adoProject: root.querySelector('[data-role="ado-project"]'),
      adoTenantId: root.querySelector('[data-role="ado-tenant-id"]'),
      azureOpenAiApiKey: root.querySelector('[data-role="azure-openai-api-key"]'),
      azureOpenAiBaseUrl: root.querySelector('[data-role="azure-openai-base-url"]'),
      azureOpenAiRealtimeDeployment: root.querySelector('[data-role="azure-openai-realtime-deployment"]'),
      azureOpenAiTranscriptionDeployment: root.querySelector('[data-role="azure-openai-transcription-deployment"]'),
      banner: root.querySelector('[data-role="banner"]'),
      chatLlmApiKey: root.querySelector('[data-role="chat-llm-api-key"]'),
      chatLlmApiKeyHeader: root.querySelector('[data-role="chat-llm-api-key-header"]'),
      chatLlmBaseUrl: root.querySelector('[data-role="chat-llm-base-url"]'),
      chatLlmModel: root.querySelector('[data-role="chat-llm-model"]'),
      cleanupEnabled: root.querySelector('[data-role="cleanup-enabled"]'),
      cleanupPrompt: root.querySelector('[data-role="cleanup-prompt"]'),
      cleanupPromptField: root.querySelector('[data-role="cleanup-prompt-field"]'),
      customWords: root.querySelector('[data-role="custom-words"]'),
      form: root.querySelector('[data-role="form"]'),
      summaryPrompt: root.querySelector('[data-role="summary-prompt"]'),
    },
  };
}

async function readSseStream(response, handlers = {}) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.detail ?? `request failed with status ${response.status}`);
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error("Azure login stream is unavailable.");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatchChunk = async (chunk) => {
    const lines = chunk.split(/\r?\n/);
    let eventName = "message";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim() || "message";
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    const dataText = dataLines.join("\n");
    let payload = dataText;
    if (dataText) {
      try {
        payload = JSON.parse(dataText);
      } catch {
      }
    }
    const handler = handlers[eventName] ?? handlers.message;
    if (typeof handler === "function") {
      await handler(payload);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const chunk = buffer.slice(0, separatorIndex).trim();
      buffer = buffer.slice(separatorIndex + 2);
      if (chunk) {
        await dispatchChunk(chunk);
      }
      separatorIndex = buffer.indexOf("\n\n");
    }
    if (done) {
      const tail = buffer.trim();
      if (tail) {
        await dispatchChunk(tail);
      }
      break;
    }
  }
}

export function createSettingsPage({ api } = {}) {
  const local = {
    adoAuth: createInitialAdoAuthState(),
    banner: null,
    refs: null,
    root: null,
    saving: false,
    settings: normalizeStandupScribeSettings({}),
  };

  function selectedRadioValue(inputs, fallback = "") {
    return inputs.find((input) => input.checked)?.value ?? fallback;
  }

  function setBanner(message, tone = "neutral") {
    local.banner = { message: String(message ?? "").trim(), tone };
    render();
  }

  function selectedPreset() {
    return getSelectedPostProcessPreset(local.settings);
  }

  function applySettings(value) {
    local.settings = normalizeStandupScribeSettings(value ?? {});
    populateInputs();
  }

  function renderAdoAuth() {
    const status = local.adoAuth;
    if (!local.refs) {
      return;
    }
    if (status.checking) {
      local.refs.adoAuthBadge.dataset.tone = "neutral";
      local.refs.adoAuthBadge.textContent = "Checking…";
      local.refs.adoAuthStatus.textContent = "Status: Checking…";
    } else if (!status.installed) {
      local.refs.adoAuthBadge.dataset.tone = "warning";
      local.refs.adoAuthBadge.textContent = "Azure CLI missing";
      local.refs.adoAuthStatus.textContent = "Status: Azure CLI is not installed or not on PATH.";
    } else if (status.logged_in) {
      local.refs.adoAuthBadge.dataset.tone = "success";
      local.refs.adoAuthBadge.textContent = "Signed in";
      local.refs.adoAuthStatus.textContent = `Status: ✓ Signed in as ${status.account_email ?? "unknown"}${status.tenant_id ? ` (tenant ${status.tenant_id})` : ""}`;
    } else {
      local.refs.adoAuthBadge.dataset.tone = "warning";
      local.refs.adoAuthBadge.textContent = "Not signed in";
      local.refs.adoAuthStatus.textContent = "Status: Not signed in";
    }
    local.refs.adoAuthPanel.hidden = !status.open;
    local.refs.adoAuthPanelBadge.dataset.tone = status.error ? "warning" : (status.running ? "neutral" : status.logged_in ? "success" : "neutral");
    local.refs.adoAuthPanelBadge.textContent = status.running ? "Waiting…" : status.logged_in ? "Done" : "Ready";
    local.refs.adoAuthPanelText.textContent = status.url && status.code
      ? `Open ${status.url} and enter code: ${status.code}`
      : status.running
        ? "Waiting for Azure CLI to print the device code…"
        : "Start sign-in to get a device code.";
    local.refs.adoAuthCopyRow.hidden = !(status.url && status.code);
    local.refs.adoAuthError.hidden = !status.error;
    local.refs.adoAuthError.textContent = status.error;
  }

  function populateInputs() {
    if (!local.refs) return;
    local.refs.azureOpenAiBaseUrl.value = local.settings["azure.openai.baseUrl"] ?? "";
    // Password fields: don't pre-populate. The placeholder indicates whether one is stored.
    const azKey = local.settings["azure.openai.apiKey"] ?? "";
    local.refs.azureOpenAiApiKey.value = "";
    local.refs.azureOpenAiApiKey.placeholder = azKey ? "•••• stored — leave blank to keep" : "Paste API key";
    local.refs.azureOpenAiRealtimeDeployment.value = local.settings["azure.openai.realtimeDeployment"] ?? "gpt-realtime-2";
    local.refs.azureOpenAiTranscriptionDeployment.value = local.settings["azure.openai.transcriptionDeployment"] ?? "gpt-realtime-whisper";
    local.refs.chatLlmBaseUrl.value = local.settings["chat.llm.baseUrl"] ?? "";
    const chatKey = local.settings["chat.llm.apiKey"] ?? "";
    local.refs.chatLlmApiKey.value = "";
    local.refs.chatLlmApiKey.placeholder = chatKey ? "•••• stored — leave blank to keep" : "Paste API key";
    local.refs.chatLlmApiKeyHeader.value = local.settings["chat.llm.apiKeyHeader"] ?? "api-key";
    local.refs.chatLlmModel.value = local.settings["chat.llm.model"] ?? "gpt-5-mini";
    local.refs.adoEnabled.checked = Boolean(local.settings["ado.enabled"]);
    local.refs.adoOrganization.value = local.settings["ado.organization"] ?? "";
    local.refs.adoProject.value = local.settings["ado.project"] ?? "";
    local.refs.adoTenantId.value = local.settings["ado.tenantId"] ?? "";
    const adoMode = local.settings["ado.mode"] ?? "read-only";
    const adoApproval = adoMode === "read-write"
      ? (local.settings["ado.approval"] ?? "confirm")
      : "confirm";
    for (const input of local.refs.adoModeInputs) {
      input.checked = input.value === adoMode;
    }
    for (const input of local.refs.adoApprovalInputs) {
      input.checked = input.value === adoApproval;
    }
    local.refs.summaryPrompt.value = local.settings.default_summary_prompt ?? DEFAULT_SUMMARY_PROMPT;
    local.refs.customWords.value = listToField(local.settings.custom_words);
    const cleanupPreset = selectedPreset();
    const cleanupActive = cleanupPreset?.id !== "preset-none" && Boolean(cleanupPreset?.instructions);
    local.refs.cleanupEnabled.checked = cleanupActive;
    local.refs.cleanupPrompt.value = cleanupActive
      ? (cleanupPreset?.instructions ?? "")
      : DEFAULT_CLEAN_TRANSCRIPT_PROMPT;
  }

  function render() {
    // NOTE: render() does NOT overwrite text/url/password/textarea input values.
    // Those are populated once by populateInputs() (called from applySettings/initial mount).
    // Overwriting them on every render() would wipe in-progress user edits whenever a
    // change event (toggle ADO mode, click cleanup checkbox, etc.) triggers a re-render.
    if (!local.refs) {
      return;
    }
    const bannerMessage = local.banner?.message || "";
    local.refs.banner.hidden = !bannerMessage;
    local.refs.banner.dataset.tone = local.banner?.tone ?? "neutral";
    local.refs.banner.textContent = bannerMessage;

    const adoMode = local.settings["ado.mode"] ?? "read-only";
    const adoApproval = adoMode === "read-write"
      ? (local.settings["ado.approval"] ?? "confirm")
      : "confirm";
    local.refs.adoApprovalFieldset.disabled = local.saving || adoMode !== "read-write";
    local.refs.adoApprovalNote.hidden = adoMode === "read-write";
    local.refs.adoAutoApplyWarning.hidden = !(adoMode === "read-write" && adoApproval === "auto-apply");
    const cleanupPreset = selectedPreset();
    const cleanupActive = cleanupPreset?.id !== "preset-none" && Boolean(cleanupPreset?.instructions);
    local.refs.cleanupPromptField.hidden = !cleanupActive;
    renderAdoAuth();

    for (const button of local.root.querySelectorAll("button")) {
      button.disabled = local.saving;
    }
    const loginButton = local.root.querySelector('[data-action="ado-login"]');
    const logoutButton = local.root.querySelector('[data-action="ado-logout"]');
    const copyCodeButton = local.root.querySelector('[data-action="ado-copy-code"]');
    const openUrlButton = local.root.querySelector('[data-action="ado-open-url"]');
    if (loginButton) {
      loginButton.disabled = local.saving || local.adoAuth.running;
    }
    if (logoutButton) {
      logoutButton.hidden = !local.adoAuth.logged_in;
      logoutButton.disabled = local.saving || local.adoAuth.running || !local.adoAuth.logged_in;
    }
    if (copyCodeButton) {
      copyCodeButton.disabled = local.saving || !local.adoAuth.code;
    }
    if (openUrlButton) {
      openUrlButton.disabled = local.saving || !local.adoAuth.url;
    }
  }

  function isMaskedSecret(value) {
    const text = String(value ?? "");
    return text.length > 0 && /^\*+/.test(text);
  }

  function collectAzureOpenAiDraft() {
    const apiKey = local.refs.azureOpenAiApiKey.value.trim();
    const draft = {
      "azure.openai.baseUrl": local.refs.azureOpenAiBaseUrl.value.trim(),
      "azure.openai.realtimeDeployment": local.refs.azureOpenAiRealtimeDeployment.value.trim() || "gpt-realtime-2",
      "azure.openai.transcriptionDeployment": local.refs.azureOpenAiTranscriptionDeployment.value.trim() || "gpt-realtime-whisper",
    };
    // Only include apiKey if the user typed a new value (not the masked placeholder, not empty)
    if (apiKey && !isMaskedSecret(apiKey)) {
      draft["azure.openai.apiKey"] = apiKey;
    }
    return draft;
  }

  function collectChatLlmDraft() {
    const apiKey = local.refs.chatLlmApiKey.value.trim();
    const draft = {
      "chat.llm.apiKeyHeader": local.refs.chatLlmApiKeyHeader.value.trim() || "api-key",
      "chat.llm.baseUrl": local.refs.chatLlmBaseUrl.value.trim(),
      "chat.llm.model": local.refs.chatLlmModel.value.trim() || "gpt-5-mini",
    };
    if (apiKey && !isMaskedSecret(apiKey)) {
      draft["chat.llm.apiKey"] = apiKey;
    }
    return draft;
  }

  function collectAdoDraft() {
    const adoMode = selectedRadioValue(local.refs.adoModeInputs, "read-only");
    return {
      "ado.approval": adoMode === "read-write"
        ? selectedRadioValue(local.refs.adoApprovalInputs, "confirm")
        : "confirm",
      "ado.enabled": local.refs.adoEnabled.checked,
      "ado.mode": adoMode,
      "ado.organization": local.refs.adoOrganization.value.trim() || "",
      "ado.project": local.refs.adoProject.value.trim(),
      "ado.tenantId": local.refs.adoTenantId.value.trim() || "",
    };
  }

  function settingsPayload() {
    const cleanupEnabled = local.refs.cleanupEnabled.checked;
    const cleanupPrompt = local.refs.cleanupPrompt.value.trim();
    const presets = [
      { id: "preset-none", name: "None", instructions: "" },
      {
        id: "preset-clean-transcript",
        name: "Clean transcript",
        instructions: cleanupPrompt || DEFAULT_CLEAN_TRANSCRIPT_PROMPT,
      },
    ];
    return {
      ...collectAdoDraft(),
      ...collectAzureOpenAiDraft(),
      ...collectChatLlmDraft(),
      custom_words: parseList(local.refs.customWords.value),
      default_summary_prompt: local.refs.summaryPrompt.value.trim() || DEFAULT_SUMMARY_PROMPT,
      filler_words: [],
      onboarding_completed: Boolean(local.settings.onboarding_completed),
      post_process_presets: presets,
      selected_post_process_preset_id: cleanupEnabled ? "preset-clean-transcript" : "preset-none",
    };
  }

  function validateSettingsPayload(payload) {
    if (payload["ado.enabled"] && !payload["ado.project"]) {
      throw new Error("Azure DevOps project is required when the integration is enabled.");
    }
  }

  async function refreshAdoAuthStatus() {
    local.adoAuth = {
      ...local.adoAuth,
      checking: true,
    };
    render();
    try {
      const status = await api("/api/ado/az-status");
      local.adoAuth = {
        ...local.adoAuth,
        ...status,
        checking: false,
        error: "",
      };
    } catch (error) {
      local.adoAuth = {
        ...local.adoAuth,
        checking: false,
        error: error instanceof Error ? error.message : "Failed to check Azure CLI status.",
      };
    }
    render();
  }

  async function loadData() {
    local.saving = true;
    render();
    try {
      applySettings(await api("/api/global/settings/").catch(() => ({})));
      local.banner = null;
      await refreshAdoAuthStatus();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Failed to load settings.", "warning");
    } finally {
      local.saving = false;
      render();
    }
  }

  async function persistSettings() {
    const payload = settingsPayload();
    validateSettingsPayload(payload);
    const savedSettings = await api("/api/global/settings/", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    applySettings(savedSettings ?? payload);
  }

  async function saveSettings(event) {
    event?.preventDefault?.();
    if (local.saving) {
      return;
    }
    local.saving = true;
    render();
    try {
      await persistSettings();
      setBanner("Settings saved.", "success");
      showToast("Settings saved");
      await refreshAdoAuthStatus();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Failed to save settings.", "warning");
    } finally {
      local.saving = false;
      render();
    }
  }

  async function testAzureOpenAiConnection() {
    const response = await api("/api/azure-openai/test", {
      method: "POST",
      body: JSON.stringify(collectAzureOpenAiDraft()),
    });
    setBanner(response?.detail || "Azure OpenAI settings look valid.", "success");
  }

  async function testChatLlmConnection() {
    const response = await api("/api/chat-llm/test", {
      method: "POST",
      body: JSON.stringify(collectChatLlmDraft()),
    });
    setBanner(response?.detail || "Chat LLM settings look valid.", "success");
  }

  async function testAdoConnection() {
    const payload = collectAdoDraft();
    validateSettingsPayload(payload);
    const response = await api("/api/ado/test", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setBanner(response?.detail || "Azure DevOps settings look valid.", "success");
  }

  async function startAdoLogin() {
    const payload = collectAdoDraft();
    validateSettingsPayload(payload);
    await api("/api/settings/ado", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    local.adoAuth = {
      ...local.adoAuth,
      code: "",
      error: "",
      logged_in: false,
      open: true,
      running: true,
      url: "",
    };
    render();
    await readSseStream(await fetch(`${API_BASE}/api/ado/login`, { method: "POST" }), {
      prompt: (data) => {
        local.adoAuth = {
          ...local.adoAuth,
          code: String(data?.code ?? "").trim(),
          error: "",
          open: true,
          url: String(data?.url ?? "").trim(),
        };
        render();
        if (local.adoAuth.url) {
          window.open(local.adoAuth.url, "_blank");
        }
      },
      success: async (data) => {
        local.adoAuth = {
          ...local.adoAuth,
          account_email: data?.account_email ?? null,
          logged_in: true,
          open: false,
          running: false,
          tenant_id: data?.tenant_id ?? null,
        };
        await api("/api/ado/reload-bridge", { method: "POST" }).catch(() => null);
        await refreshAdoAuthStatus();
        showToast("Azure DevOps sign-in complete");
        setBanner("Azure DevOps sign-in complete.", "success");
      },
      error: (data) => {
        throw new Error(String(data?.message ?? "Azure CLI login failed."));
      },
    });
  }

  async function handleAdoLogin() {
    try {
      await startAdoLogin();
    } catch (error) {
      local.adoAuth = {
        ...local.adoAuth,
        error: error instanceof Error ? error.message : "Azure CLI login failed.",
        open: true,
        running: false,
      };
      render();
      setBanner(local.adoAuth.error, "warning");
    } finally {
      local.adoAuth = {
        ...local.adoAuth,
        running: false,
      };
      render();
    }
  }

  async function handleAdoLogout() {
    await api("/api/ado/logout", { method: "POST" });
    local.adoAuth = createInitialAdoAuthState();
    await refreshAdoAuthStatus();
    showToast("Azure DevOps signed out");
    setBanner("Azure DevOps signed out.", "success");
  }

  async function copyAdoCode() {
    if (!local.adoAuth.code) {
      return;
    }
    await navigator.clipboard.writeText(local.adoAuth.code);
    showToast("Device code copied");
  }

  function openAdoUrl() {
    if (local.adoAuth.url) {
      window.open(local.adoAuth.url, "_blank");
    }
  }

  function bindEvents() {
    local.refs.form.addEventListener("submit", saveSettings);
    local.root.addEventListener("change", (event) => {
      if (event.target.closest('[data-role="cleanup-enabled"]')) {
        render();
      }
      if (event.target.closest('[data-role="ado-mode"]')) {
        local.settings["ado.mode"] = selectedRadioValue(local.refs.adoModeInputs, "read-only");
        if (local.settings["ado.mode"] !== "read-write") {
          local.settings["ado.approval"] = "confirm";
        }
        render();
      }
      if (event.target.closest('[data-role="ado-approval"]')) {
        local.settings["ado.approval"] = selectedRadioValue(local.refs.adoApprovalInputs, "confirm");
        render();
      }
      if (event.target.closest('[data-role="ado-enabled"]')) {
        local.settings["ado.enabled"] = local.refs.adoEnabled.checked;
        render();
      }
    });
    local.root.addEventListener("click", (event) => {
      const actionTarget = event.target.closest("[data-action]");
      if (!actionTarget || !local.root.contains(actionTarget)) {
        return;
      }
      const action = actionTarget.getAttribute("data-action");
      if (action === "test-azure-openai") {
        void testAzureOpenAiConnection().catch((error) => {
          setBanner(error instanceof Error ? error.message : "Couldn't test Azure OpenAI settings.", "warning");
        });
      } else if (action === "test-chat-llm") {
        void testChatLlmConnection().catch((error) => {
          setBanner(error instanceof Error ? error.message : "Couldn't test Chat LLM settings.", "warning");
        });
      } else if (action === "test-ado") {
        void testAdoConnection().catch((error) => {
          setBanner(error instanceof Error ? error.message : "Couldn't test Azure DevOps settings.", "warning");
        });
      } else if (action === "ado-login") {
        void handleAdoLogin();
      } else if (action === "ado-logout") {
        void handleAdoLogout().catch((error) => {
          setBanner(error instanceof Error ? error.message : "Couldn't sign out of Azure DevOps.", "warning");
        });
      } else if (action === "ado-copy-code") {
        void copyAdoCode().catch((error) => {
          setBanner(error instanceof Error ? error.message : "Couldn't copy the device code.", "warning");
        });
      } else if (action === "ado-open-url") {
        openAdoUrl();
      }
    });
  }

  function mount(container) {
    if (local.root) {
      local.root.remove();
      local.root = null;
      local.refs = null;
    }
    const created = createRoot();
    local.root = created.root;
    local.refs = created.refs;
    container.appendChild(local.root);
    bindEvents();
    render();
    void loadData();
  }

  function unmount() {
    local.root?.remove();
    local.root = null;
    local.refs = null;
  }

  return { mount, refresh: loadData, unmount };
}
