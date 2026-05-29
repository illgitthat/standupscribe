#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const API_BASE = process.env.STANDUPSCRIBE_API_BASE || "http://127.0.0.1:12453";
const REPORT_PATH = process.env.FUNCTIONAL_REPORT_PATH || "";
const PROMPT_CHANGED = /^true$/i.test(process.env.FUNCTIONAL_PROMPT_CHANGED || "false");
const PROMPT_CHANGE_SUMMARY = process.env.FUNCTIONAL_PROMPT_CHANGE_SUMMARY || "";
const REQUEST_TIMEOUT_MS = 30_000;
const SCENARIO_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;

const SCENARIOS = [
  {
    key: "A",
    name: "Scenario A — Title references only, real items",
    description: "Speakers reference generic engineering work by title/description only; no numeric IDs are spoken.",
    lines: [
      { speaker: "Lead", text: "OK let's run through the active engineering items." },
      {
        speaker: "Sam",
        text: "I finished up the login flow refactor work, I'm going to mark that done.",
        dispatch: "I finished up the login flow refactor work, I'm going to mark that done.",
        expected: { kind: "existing", action: "update_status", titleHints: ["Login Flow Refactor"], requireGroundedLookup: true },
      },
      {
        speaker: "Lead",
        text: "Great. Can you add a comment on that one saying findings are in the engineering wiki?",
        dispatch: "Can you add a comment on that one saying findings are in the engineering wiki?",
        expected: { kind: "existing", action: "add_comment", titleHints: ["Login Flow Refactor"], requireGroundedLookup: true, requireCommentLookup: true, sameAsPrevious: true },
      },
      {
        speaker: "Pat",
        text: "I'm chasing the schema migration issue for the billing pipeline work.",
        dispatch: "I'm chasing the schema migration issue for the billing pipeline work.",
        expected: { kind: "existing", action: "add_comment", titleHints: ["Schema Migration for Billing Pipeline"], requireGroundedLookup: true, requireCommentLookup: true },
      },
      {
        speaker: "Pat",
        text: "We need a new child task under the billing pipeline schema migration story for the reconciliation piece.",
        dispatch: "We need a new child task under the billing pipeline schema migration story for the reconciliation piece.",
        expected: { kind: "existing", action: "create_child_task", titleHints: ["Schema Migration for Billing Pipeline"], requireGroundedLookup: true, requireDuplicateCheck: true, sameAsPrevious: true },
      },
      {
        speaker: "Alex",
        text: "I want to reassign the Create onboarding checklist for each onboarding path task to Casey — she has more context on the onboarding paths.",
        dispatch: "I want to reassign the Create onboarding checklist for each onboarding path task to Casey — she has more context on the onboarding paths.",
        expected: { kind: "existing", action: "assign", titleHints: ["Create onboarding checklist for each onboarding path"], requireGroundedLookup: true },
      },
      {
        speaker: "Robin",
        text: "I finished the Create API rate-limiter stories task — let's close that one out.",
        dispatch: "I finished the Create API rate-limiter stories task — let's close that one out.",
        expected: { kind: "existing", action: "close_task", titleHints: ["Create API rate-limiter stories"], requireGroundedLookup: true },
      },
      {
        speaker: "Robin",
        text: "And I want to create a new story for the deploy readiness checklist for the CI/CD pipeline. I'll take it.",
        dispatch: "Create a new story for the deploy readiness checklist for the CI/CD pipeline. I'll take it.",
        expected: { kind: "create", action: "create_user_story", titleHints: ["deploy readiness checklist", "CI/CD pipeline"], requireDuplicateCheck: true },
      },
      { speaker: "Lead", text: "Perfect, anything else? No? Thanks everyone." },
    ],
  },
  {
    key: "B",
    name: "Scenario B — Pronoun-heavy, no titles at all",
    description: "Pronoun-only engineering follow-ups must resolve from transcript context.",
    lines: [
      { speaker: "Lead", text: "Did you see the chat message about the deploy pipeline item?" },
      { speaker: "Sam", text: "Yeah the user story about deployment." },
      {
        speaker: "Lead",
        text: "Can you add a comment on that one saying we're deferring it?",
        dispatch: "Can you add a comment on that one saying we're deferring it?",
        expected: { kind: "existing", action: "add_comment", titleHints: ["deploy pipeline", "deployment"], requireGroundedLookup: true, requireCommentLookup: true },
      },
      { speaker: "Sam", text: "Sure." },
      {
        speaker: "Lead",
        text: "Also reassign it to me, I'll pick it up.",
        dispatch: "Also reassign it to me, I'll pick it up.",
        expected: { kind: "existing", action: "assign", titleHints: ["deploy pipeline", "deployment"], requireGroundedLookup: true, sameAsPrevious: true },
      },
    ],
  },
  {
    key: "C",
    name: "Scenario C — Negative and ambiguous cases",
    description: "Speculative engineering brainstorming and questions should not turn into work-item mutations.",
    lines: [
      {
        speaker: "Lead",
        text: "What do we think about tuning search relevance next quarter?",
        dispatch: "What do we think about tuning search relevance next quarter?",
        expected: { kind: "noop", rationaleTerms: ["question", "asked", "speculative", "brainstorm", "not actionable"] },
      },
      {
        speaker: "Sam",
        text: "I'm not sure, just brainstorming.",
        dispatch: "I'm not sure, just brainstorming.",
        expected: { kind: "noop", rationaleTerms: ["brainstorm", "not actionable", "unclear"] },
      },
      { speaker: "Pat", text: "We could potentially look at that." },
      {
        speaker: "Alex",
        text: "Did anyone get a chance to review the observability metrics proposal?",
        dispatch: "Did anyone get a chance to review the observability metrics proposal?",
        expected: { kind: "noop", rationaleTerms: ["question", "asked", "no specific work item", "not actionable", "speculative"] },
      },
      {
        speaker: "Robin",
        text: "Not yet, but I'll try this week.",
        dispatch: "Not yet, but I'll try this week.",
        expected: { kind: "noop", rationaleTerms: ["insufficient", "not actionable", "unclear", "no specific work item", "does not reference a specific work item", "grounded work item", "no concrete ado change", "conversational status update"] },
      },
    ],
  },
];

function truncate(value, max = 180) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout fetching ${url}`)), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    if (!response.ok) throw new Error(`${options.method || "GET"} ${url} failed: ${response.status} ${payload.detail || payload.error || truncate(text, 300)}`);
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

async function createSession() { return (await fetchJson(`${API_BASE}/api/listen/sessions`, { method: "POST" })).session_id; }
async function warmCache() { return fetchJson(`${API_BASE}/api/listen/session-config`); }
async function readEvents(sessionId, since) { return fetchJson(`${API_BASE}/api/listen/events?session_id=${encodeURIComponent(sessionId)}&since=${since}`); }
async function getProposedActions(sessionId) { return fetchJson(`${API_BASE}/api/meetings/${encodeURIComponent(sessionId)}/proposed-actions`); }

async function seedTranscript(sessionId, speaker, text, startMs, endMs) {
  return fetchJson(`${API_BASE}/api/listen/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, speaker_label: speaker, text: `${speaker}: ${text}`, start_ms: startMs, end_ms: endMs }),
  });
}

async function dispatchIntent(sessionId, intent) {
  return fetchJson(`${API_BASE}/api/listen/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, intent }),
  });
}

function numericId(value) {
  return /^\d+$/.test(String(value || "").trim()) ? String(value).trim() : "";
}

function indexEventsByJob(events) {
  const byJob = new Map();
  for (const event of events) {
    if (!event.job_id) continue;
    if (!byJob.has(event.job_id)) byJob.set(event.job_id, []);
    byJob.get(event.job_id).push(event);
  }
  return byJob;
}

function toToolTrace(jobEvents) {
  const trace = [];
  for (const event of jobEvents) {
    if (event.type === "tool_call") {
      trace.push({ name: event.name, args: event.args || {}, result: "", error: "" });
      continue;
    }
    const last = trace[trace.length - 1];
    if (!last || last.name !== event.name) continue;
    if (event.type === "tool_result") last.result = event.summary || "";
    if (event.type === "tool_error") last.error = event.error || "";
  }
  return trace;
}

function collectProposal(jobEvents, proposalsById) {
  const proposalEvent = [...jobEvents].reverse().find((event) => event.type === "proposal");
  const doneEvent = [...jobEvents].reverse().find((event) => event.type === "done" || event.type === "error") || null;
  const args = proposalEvent?.args || null;
  const proposalId = doneEvent?.proposed_action_id || null;
  return {
    proposalEvent,
    doneEvent,
    action: args?.action || doneEvent?.decision || null,
    args,
    proposalRow: proposalId ? proposalsById.get(proposalId) || null : null,
  };
}

function hasTool(trace, names) {
  const wanted = new Set(Array.isArray(names) ? names : [names]);
  return trace.some((entry) => wanted.has(entry.name));
}

function toolMentionsId(trace, id) {
  if (!id) return false;
  return trace.some((entry) => `${JSON.stringify(entry.args)}\n${entry.result}`.includes(id));
}

function titleHintMatch(dispatch, hint) {
  const text = [
    dispatch.args?.rationale || "",
    dispatch.proposalRow?.tool_args?.rationale || "",
    ...dispatch.toolTrace.map((entry) => entry.result || ""),
  ].join(" ").toLowerCase();
  return text.includes(String(hint).toLowerCase());
}

function lookupEntries(trace) {
  return trace.filter((entry) => ["search_workitem", "search_workitems", "wit_my_work_items"].includes(entry.name));
}

function groundedLookup(dispatch, priorDispatches) {
  const id = numericId(dispatch.args?.work_item_id || dispatch.proposalRow?.tool_args?.work_item_id || dispatch.args?.parent_work_item_id || dispatch.proposalRow?.tool_args?.parent_work_item_id);
  const hints = dispatch.expected?.titleHints || [];
  const entries = lookupEntries(dispatch.toolTrace);
  const directGrounding = entries.some((entry) => {
    const text = `${JSON.stringify(entry.args)} ${entry.result || ""}`.toLowerCase();
    const emptySearch = text.includes('"count":0') || text.includes('"results":[]');
    if (id && text.includes(id)) return true;
    if (!emptySearch && hints.some((hint) => text.includes(String(hint).toLowerCase()))) return true;
    return false;
  });
  if (directGrounding) return true;
  if (!dispatch.expected?.sameAsPrevious || !id) return false;
  const prior = [...priorDispatches].reverse().find((item) => {
    const priorId = numericId(item.args?.work_item_id || item.proposalRow?.tool_args?.work_item_id || item.args?.parent_work_item_id || item.proposalRow?.tool_args?.parent_work_item_id);
    return priorId && priorId === id;
  });
  return Boolean(prior?.checks?.find((check) => check.label === "Planner used search or my-work lookup to ground the item")?.pass);
}

function evaluateDispatch(dispatch, priorDispatches) {
  const expected = dispatch.expected || {};
  const checks = [];
  const action = dispatch.action || "";
  const resolvedId = numericId(dispatch.args?.work_item_id || dispatch.proposalRow?.tool_args?.work_item_id || dispatch.args?.parent_work_item_id || dispatch.proposalRow?.tool_args?.parent_work_item_id);
  const rationale = String(dispatch.args?.rationale || dispatch.proposalRow?.tool_args?.rationale || dispatch.doneEvent?.rationale || "");
  const previous = expected.sameAsPrevious ? [...priorDispatches].reverse().find((item) => numericId(item.args?.work_item_id || item.proposalRow?.tool_args?.work_item_id || item.args?.parent_work_item_id || item.proposalRow?.tool_args?.parent_work_item_id)) : null;
  const previousId = previous ? numericId(previous.args?.work_item_id || previous.proposalRow?.tool_args?.work_item_id || previous.args?.parent_work_item_id || previous.proposalRow?.tool_args?.parent_work_item_id) : "";

  checks.push({ label: expected.kind === "noop" ? "Planner returned noop" : "Planner produced a proposal", pass: expected.kind === "noop" ? action === "noop" : Boolean(action && action !== "noop"), detail: action || "(none)" });
  if (expected.action) checks.push({ label: `Action matches ${expected.action}`, pass: action === expected.action, detail: action || "(none)" });

  if (expected.kind === "existing") {
    checks.push({ label: "work_item_id populated", pass: Boolean(resolvedId), detail: resolvedId || "(missing)" });
    checks.push({ label: "work_item_id verified by tool trace", pass: Boolean(resolvedId) && toolMentionsId(dispatch.toolTrace, resolvedId), detail: resolvedId || "(missing)" });
  }

  if (expected.requireGroundedLookup) {
    checks.push({ label: "Planner used search or my-work lookup to ground the item", pass: groundedLookup(dispatch, priorDispatches), detail: lookupEntries(dispatch.toolTrace).map((entry) => `${entry.name}: ${truncate(entry.result || entry.args, 100)}`).join(" | ") || "(none)" });
  }
  if (expected.requireCommentLookup) checks.push({ label: "Checked work item comments", pass: hasTool(dispatch.toolTrace, "wit_list_work_item_comments"), detail: dispatch.toolTrace.map((entry) => entry.name).join(", ") || "(none)" });
  if (expected.requireDuplicateCheck) checks.push({ label: "Checked for duplicates with search_workitem", pass: hasTool(dispatch.toolTrace, ["search_workitem", "search_workitems"]), detail: dispatch.toolTrace.map((entry) => entry.name).join(", ") || "(none)" });
  if (expected.sameAsPrevious && previousId) checks.push({ label: "Resolved same work item as prior reference", pass: resolvedId === previousId, detail: `${resolvedId || "(missing)"} vs ${previousId}` });
  if (Array.isArray(expected.titleHints) && expected.titleHints.length) checks.push({ label: "Resolution is plausibly correct", pass: expected.titleHints.some((hint) => titleHintMatch(dispatch, hint)), detail: expected.titleHints.join(" | ") });
  if (expected.kind === "noop") checks.push({ label: "Rationale cites speculative/question nature", pass: expected.rationaleTerms?.some((term) => rationale.toLowerCase().includes(String(term).toLowerCase())) || false, detail: rationale || "(missing)" });
  return checks;
}

function scoreChecks(checks) {
  const passed = checks.filter((check) => check.pass).length;
  return { passed, failed: checks.length - passed, total: checks.length };
}

async function runScenario(scenario) {
  const sessionId = await createSession();
  const config = await warmCache();
  const dispatches = [];
  let lineIndex = 0;
  for (const line of scenario.lines) {
    lineIndex += 1;
    const startMs = (lineIndex - 1) * 5_000;
    await seedTranscript(sessionId, line.speaker, line.text, startMs, startMs + 3_000);
    const intents = Array.isArray(line.dispatch) ? line.dispatch : line.dispatch ? [line.dispatch] : [];
    for (const intent of intents) {
      const queued = await dispatchIntent(sessionId, intent);
      dispatches.push({ lineIndex, speaker: line.speaker, text: line.text, intent, expected: line.expected || null, jobId: queued.job_id });
      await sleep(250);
    }
  }

  let cursor = 0;
  const events = [];
  const pending = new Set(dispatches.map((dispatch) => dispatch.jobId));
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  while (pending.size && Date.now() < deadline) {
    const payload = await readEvents(sessionId, cursor);
    const batch = Array.isArray(payload?.events) ? payload.events : [];
    cursor = payload?.cursor || cursor;
    if (batch.length) {
      events.push(...batch);
      for (const event of batch) if (event.job_id && (event.type === "done" || event.type === "error")) pending.delete(event.job_id);
    }
    if (pending.size) await sleep(POLL_INTERVAL_MS);
  }

  const proposals = await getProposedActions(sessionId);
  const proposalsById = new Map((proposals || []).map((row) => [row.id, row]));
  const eventsByJob = indexEventsByJob(events);
  const reports = [];
  for (const dispatch of dispatches) {
    const jobEvents = eventsByJob.get(dispatch.jobId) || [];
    const toolTrace = toToolTrace(jobEvents);
    const resolution = collectProposal(jobEvents, proposalsById);
    const report = {
      scenario: scenario.key,
      sessionId,
      jobId: dispatch.jobId,
      lineIndex: dispatch.lineIndex,
      speaker: dispatch.speaker,
      text: dispatch.text,
      intent: dispatch.intent,
      expected: dispatch.expected,
      timedOut: pending.has(dispatch.jobId),
      jobEvents,
      toolTrace,
      proposalEvent: resolution.proposalEvent,
      doneEvent: resolution.doneEvent,
      proposalRow: resolution.proposalRow,
      action: resolution.action,
      args: resolution.args,
    };
    report.checks = evaluateDispatch(report, reports);
    report.score = scoreChecks(report.checks);
    reports.push(report);
  }

  return {
    key: scenario.key,
    name: scenario.name,
    description: scenario.description,
    sessionId,
    prefetchedItems: config.prefetched_work_items || [],
    dispatchCount: reports.length,
    proposals,
    timedOutJobs: [...pending],
    dispatches: reports,
    score: scoreChecks(reports.flatMap((report) => report.checks)),
  };
}

function buildRecommendations(results) {
  const recommendations = [];
  const lookupFailures = results.flatMap((scenario) => scenario.dispatches).filter((dispatch) => dispatch.expected?.requireGroundedLookup && !dispatch.checks.find((check) => check.label === "Planner used search or my-work lookup to ground the item")?.pass);
  if (lookupFailures.length) recommendations.push("Planner still resolves some items from prompt context/prefetch without grounding them through search_workitem or wit_my_work_items results.");
  const falsePositives = results.flatMap((scenario) => scenario.dispatches).filter((dispatch) => dispatch.expected?.kind === "noop" && dispatch.action !== "noop");
  if (falsePositives.length) recommendations.push("Negative/speculative utterances still need a stronger noop gate in the planner prompt.");
  const missedActions = results.flatMap((scenario) => scenario.dispatches).filter((dispatch) => dispatch.expected?.kind !== "noop" && (!dispatch.action || dispatch.action === "noop"));
  if (missedActions.length) recommendations.push("Pronoun-heavy follow-ups remain brittle: the planner sometimes refuses to act even after finding plausible launchpad/deployment candidates. Consider adding an explicit rule to reuse the most recent grounded item across consecutive pronoun-only turns.");
  const actionMismatches = results.flatMap((scenario) => scenario.dispatches).filter((dispatch) => dispatch.checks.some((check) => check.label.startsWith("Action matches") && !check.pass));
  if (actionMismatches.length) recommendations.push("Action selection is still inconsistent in edge cases; add more few-shot examples for comment-vs-assign follow-ups on the same referenced item.");
  if (!recommendations.length) recommendations.push("No major prompt issues observed in these scenarios.");
  return recommendations;
}

function overallGrade(results) {
  const checks = results.flatMap((scenario) => scenario.dispatches.flatMap((dispatch) => dispatch.checks));
  const { passed, total } = scoreChecks(checks);
  const ratio = total ? passed / total : 1;
  if (ratio >= 0.95) return "A";
  if (ratio >= 0.85) return "B";
  if (ratio >= 0.7) return "C";
  if (ratio >= 0.5) return "D";
  return "F";
}

function scenarioScript(key) {
  return (SCENARIOS.find((scenario) => scenario.key === key)?.lines || []).map((line) => `${line.speaker}: ${line.text}`);
}

function toMarkdown(results) {
  const lines = [
    "# StandupScribe Functional Readiness Report",
    "",
    `- API base: ${API_BASE}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Prompt changed: ${PROMPT_CHANGED ? "yes" : "no"}`,
  ];
  if (PROMPT_CHANGE_SUMMARY) lines.push(`- Prompt change summary: ${PROMPT_CHANGE_SUMMARY}`);
  lines.push("", "## Scenario scorecard", "", "| Scenario | Passed checks | Failed checks | Grade |", "|---|---:|---:|---|");
  for (const scenario of results) {
    const pct = scenario.score.total ? `${Math.round((scenario.score.passed / scenario.score.total) * 100)}%` : "100%";
    lines.push(`| ${scenario.name} | ${scenario.score.passed} | ${scenario.score.failed} | ${pct} |`);
  }
  lines.push("", `## Overall grade: ${overallGrade(results)}`, "");

  for (const scenario of results) {
    lines.push(`## ${scenario.name}`, "", scenario.description, "", "### Script", "", "```text", ...scenarioScript(scenario.key), "```", "");
    for (const dispatch of scenario.dispatches) {
      lines.push(`### Dispatch ${dispatch.jobId}`, "", `- Speaker line: ${dispatch.speaker}: ${dispatch.text}`, `- Intent: ${dispatch.intent}`, `- Final action: ${dispatch.action || "(none)"}`, `- work_item_id: ${dispatch.args?.work_item_id || dispatch.proposalRow?.tool_args?.work_item_id || dispatch.args?.parent_work_item_id || dispatch.proposalRow?.tool_args?.parent_work_item_id || "(none)"}`, `- Rationale: ${dispatch.args?.rationale || dispatch.proposalRow?.tool_args?.rationale || dispatch.doneEvent?.rationale || "(none)"}`);
      if (dispatch.timedOut) lines.push("- Timeout: planner did not finish within 90s");
      lines.push("", "#### Tool trace", "");
      if (!dispatch.toolTrace.length) lines.push("- (no tool calls)");
      else for (const entry of dispatch.toolTrace) lines.push(`- ${entry.name} args=${truncate(entry.args, 200)} result=${truncate(entry.error || entry.result || "", 240)}`);
      lines.push("", "#### Checks", "");
      for (const check of dispatch.checks) lines.push(`- ${check.pass ? "✓" : "✗"} ${check.label} — ${check.detail}`);
      lines.push("", "#### Final proposal", "", "```json", JSON.stringify(dispatch.args || { action: dispatch.action || null }, null, 2), "```", "");
    }
  }

  lines.push("## Recommendations", "");
  for (const recommendation of buildRecommendations(results)) lines.push(`- ${recommendation}`);
  lines.push("", "## Suspected bugs", "");
  const bugs = results.flatMap((scenario) => scenario.dispatches.filter((dispatch) => dispatch.checks.some((check) => !check.pass)).map((dispatch) => `Scenario ${scenario.key} / ${dispatch.jobId}: ${dispatch.checks.filter((check) => !check.pass).map((check) => check.label).join(", ")}`));
  if (bugs.length) for (const bug of bugs) lines.push(`- ${bug}`);
  else lines.push("- None observed in this run.");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const results = [];
  for (const scenario of SCENARIOS) results.push(await runScenario(scenario));
  const output = { apiBase: API_BASE, generatedAt: new Date().toISOString(), promptChanged: PROMPT_CHANGED, promptChangeSummary: PROMPT_CHANGE_SUMMARY, overallGrade: overallGrade(results), recommendations: buildRecommendations(results), results };
  if (REPORT_PATH) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, toMarkdown(results), "utf8");
  }
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
