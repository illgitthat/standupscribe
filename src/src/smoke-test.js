const fs = require("node:fs");
const path = require("node:path");

const { startServers, API_PORT, UI_PORT } = require("./server");
const { StandupScribeStore } = require("./store");

async function expectJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} failed: ${response.status} ${payload.detail ?? ""}`.trim());
  }
  return payload;
}

async function main() {
  const dataDir = path.join(__dirname, "..", "local-data", "smoke-test");
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const store = new StandupScribeStore(dataDir);
  const servers = await startServers({
    uiDir: path.join(__dirname, "..", "ui"),
    dataDir,
    store,
  });

  try {
    const settings = await expectJson(`http://127.0.0.1:${API_PORT}/api/global/settings/`);
    if (!settings.result || typeof settings.result !== "object") {
      throw new Error("settings endpoint returned an invalid payload");
    }

    await expectJson(`http://127.0.0.1:${API_PORT}/api/global/settings/`, {
      method: "POST",
      body: JSON.stringify({ "azure.openai.realtimeDeployment": "gpt-realtime-2" }),
      headers: { "Content-Type": "application/json" },
    });

    const adoStatus = await expectJson(`http://127.0.0.1:${API_PORT}/api/ado/status`);
    if (adoStatus.result?.enabled !== false) {
      throw new Error("unexpected ado status payload");
    }

    const meeting = await expectJson(`http://127.0.0.1:${API_PORT}/api/meeting/`, { method: "POST" });
    const meetingId = meeting.result?.meeting_id;
    if (!meetingId) {
      throw new Error("meeting creation did not return an id");
    }

    await expectJson(`http://127.0.0.1:${API_PORT}/api/meeting/${meetingId}/transcripts`, {
      method: "POST",
      body: JSON.stringify({ item_id: "item-1", text: "hello standup", start_ms: 0, end_ms: 500 }),
      headers: { "Content-Type": "application/json" },
    });

    const transcripts = await expectJson(`http://127.0.0.1:${API_PORT}/api/meeting/${meetingId}/transcripts`);
    if (!Array.isArray(transcripts.result) || transcripts.result.length !== 1) {
      throw new Error("transcript persistence check failed");
    }

    const removed = await fetch(`http://127.0.0.1:${API_PORT}/api/global/audio/current_state`, { method: "POST" });
    if (removed.status !== 404) {
      throw new Error(`expected removed endpoint to return 404, got ${removed.status}`);
    }

    const ui = await fetch(`http://127.0.0.1:${UI_PORT}/realtime-test.html`);
    if (!ui.ok) {
      throw new Error("realtime-test.html was not served");
    }

    console.log("Smoke test passed");
  } finally {
    await servers.close();
    store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
