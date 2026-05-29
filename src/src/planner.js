// Background planner agent.
// Takes a high-level intent from the realtime listener and runs a multi-step
// chat-completions ReAct loop using the ADO MCP toolbox to investigate and
// produce a concrete proposed action.
//
// Safety model:
//   - All READ tools (search/list/get/query/my/...) are auto-executed.
//   - WRITE tools are NEVER auto-executed. Instead the planner produces a
//     proposed_action row that the user reviews and applies via the UI.

const MAX_STEPS = 10;
const MAX_PROPOSALS = 5;
const READ_VERB_RE = /(^|_)(search|list|get|read|query|my|by_id|by_ids|by_wiql)(_|$)/i;

function isReadOnlyTool(name) {
  return READ_VERB_RE.test(String(name ?? ""));
}

function summarizeResult(result, max = 350) {
  try {
    if (!result) return "(empty)";
    if (typeof result === "string") return result.slice(0, max);
    // MCP wraps text in {content: [{type:'text', text:'...'}]}
    if (Array.isArray(result.content)) {
      const text = result.content
        .map((c) => (c?.type === "text" ? c.text : JSON.stringify(c)))
        .join("\n");
      return text.slice(0, max);
    }
    return JSON.stringify(result).slice(0, max);
  } catch {
    return String(result).slice(0, max);
  }
}

function buildToolSchemas(mcpTools) {
  return mcpTools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: String(t.description ?? "").slice(0, 500),
      parameters: t.inputSchema && typeof t.inputSchema === "object"
        ? t.inputSchema
        : { type: "object", properties: {} },
    },
  }));
}

const PROPOSAL_TOOL = {
  type: "function",
  function: {
    name: "propose_action",
    description:
      "Record one concrete change to Azure DevOps. Call this once per distinct change you want to propose — you may call it MULTIPLE TIMES if the speaker described several actions in one update (e.g. 'I'll close ticket X AND add a comment to Y AND reassign Z to Sam' = 3 calls). Do NOT call write tools yourself. After your last propose_action, call finalize_planning to stop.",
    parameters: {
      type: "object",
      required: ["action", "summary", "rationale"],
      properties: {
        action: {
          type: "string",
          enum: [
            "add_comment",
            "update_status",
            "close_task",
            "assign",
            "create_task",
            "create_user_story",
            "create_child_task",
            "noop",
          ],
          description: "The concrete change to propose. Use 'noop' if no change is warranted.",
        },
        summary: { type: "string", description: "Short human-readable summary, max 200 chars." },
        rationale: { type: "string", description: "Why this is the right action; cite work item IDs you investigated." },
        work_item_id: { type: "string", description: "Existing work item ID this acts on (required for add_comment/update_status/close_task/assign/create_child_task)." },
        parent_work_item_id: { type: "string", description: "Parent ID for create_child_task." },
        new_state: { type: "string", description: "Target state for update_status / close_task." },
        assignee: { type: "string", description: "Display name or email for assign / create_*." },
        comment: { type: "string", description: "Comment text for add_comment." },
        title: { type: "string", description: "New work item title for create_task / create_user_story / create_child_task." },
        description: { type: "string", description: "New work item description (HTML or text)." },
      },
    },
  },
};

const FINALIZE_TOOL = {
  type: "function",
  function: {
    name: "finalize_planning",
    description:
      "Call this exactly once after your last propose_action to signal you are done. If no actions are warranted, call this directly (without any propose_action calls) and the system will record a single noop.",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "Optional one-line note about the overall outcome." },
      },
    },
  },
};

async function callChatCompletions({ settings, messages, tools, logger }) {
  const baseUrl = String(settings["chat.llm.baseUrl"] ?? "").trim().replace(/\/+$/, "");
  const apiKey = String(settings["chat.llm.apiKey"] ?? "").trim();
  const header = String(settings["chat.llm.apiKeyHeader"] ?? "api-key").trim() || "api-key";
  const model = String(settings["chat.llm.model"] ?? "").trim() || "gpt-5-mini";
  if (!baseUrl || !apiKey) {
    throw new Error("Chat LLM is not configured. Set chat.llm.baseUrl + chat.llm.apiKey in Settings.");
  }
  const body = {
    model,
    messages,
    tools,
    tool_choice: "auto",
    max_completion_tokens: 1200,
  };
  const response = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", [header]: apiKey },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Chat LLM ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  const choice = data?.choices?.[0]?.message;
  if (!choice) throw new Error("Chat LLM returned no choice.");
  return choice;
}

async function runPlanner({
  intent,
  transcriptContext,
  priorActions,
  meetingId,
  meeting,
  prefetchedItems,
  runtime,
  store,
  settings,
  onEvent,
  signal,
}) {
  const emit = (type, data) => {
    try { onEvent?.({ type, ...data, ts: Date.now() }); } catch {}
  };
  emit("started", { intent });

  const bridge = await runtime.getAdoBridge({ start: true });
  if (!bridge) {
    emit("error", { message: "ADO bridge unavailable." });
    return null;
  }

  // Fetch full tool catalog
  let allTools = [];
  try {
    allTools = await bridge.getTools({ mode: "read-write" });
  } catch (error) {
    emit("error", { message: "Failed to list MCP tools: " + (error?.message || error) });
    return null;
  }
  // For autonomy: planner can only auto-execute read tools. Write tools are surfaced only via propose_action.
  const readTools = allTools.filter((t) => isReadOnlyTool(t.name));
  emit("thinking", { message: `Connected: ${readTools.length} read tools + propose_action available` });

  const adoSettings = runtime.getAdoSettings();
  const projectStr = String(adoSettings?.project ?? "").trim();
  const orgStr = String(adoSettings?.organization ?? "").trim();

  const itemListBlock = (prefetchedItems || []).slice(0, 30).map((w) => {
    return `- #${w.id} <${w.type ?? "?"}>: ${w.title ?? "(untitled)"} [${w.state ?? "?"}]${w.assignee ? " — " + w.assignee : ""}`;
  }).join("\n");

  const priorActionsBlock = (priorActions || []).slice(-15).map((a) => {
    let args = {};
    try { args = a.tool_args_json ? JSON.parse(a.tool_args_json) : {}; } catch {}
    const labelMap = { applied: "TAKEN", auto_applied: "AUTO-TAKEN", rejected: "DISMISSED", failed: "FAILED", pending: "PROPOSED" };
    const status = a.undone_at ? "REVERTED" : (labelMap[a.status] || a.status || "?");
    return `- [${status}] action=${args.action ?? "?"} work_item_id=${args.work_item_id ?? "-"} summary="${(args.summary ?? "").slice(0, 80)}"`;
  }).join("\n");

  const systemPrompt = [
    "You are the background planner for StandupScribe, an Azure DevOps meeting copilot.",
    "Your job: take an INTENT extracted from the meeting audio, use the FULL RECENT TRANSCRIPT to understand pronouns and references ('that ticket', 'the deploy thing', 'her item'), INVESTIGATE the relevant ADO state using the read tools, then propose ONE OR MORE concrete actions via the propose_action function.",
    "",
    "MULTI-ACTION DECOMPOSITION (CRITICAL):",
    "  • A single intent can describe multiple distinct changes. Example: 'I finished the login refactor, also add a comment that the design doc is linked in the description, and reassign the onboarding flow story to Sam' = THREE proposals.",
    "  • Call propose_action ONCE PER distinct change. Then call finalize_planning ONCE to stop.",
    "  • If only one change is warranted, call propose_action once and then finalize_planning.",
    "  • If NO change is warranted (question, brainstorm, off-topic), call finalize_planning directly with no propose_action calls — the system will record a noop.",
    "  • You may interleave read-tool calls between propose_action calls if a second action needs separate investigation.",
    "  • Maximum " + MAX_PROPOSALS + " proposals per dispatch.",
    "",
    "Resolving references is critical:",
    "  • The intent string is short and may use pronouns. The transcript is your ground truth — read it carefully.",
    "  • If the speaker said 'that one' or 'this task' look earlier in the transcript for what 'that' refers to (a work item number, a title, a project, a person's name).",
    "  • Cross-reference candidate items against the pre-loaded active work items list and against earlier proposed/applied actions in THIS meeting.",
    "  • If a pronoun-only follow-up ('it', 'that one', 'reassign it') immediately follows a grounded item in THIS meeting, assume it refers to that same work item unless new evidence clearly points elsewhere.",
    "  • Treat the pre-loaded active work items list and prior actions as hints only — never as sufficient evidence by themselves.",
    "",
    "Investigation playbook:",
    "  • Look for a work item ID in the transcript first. If found, use wit_get_work_item to confirm it.",
    "  • For EVERY proposal that targets an existing work item (add_comment/update_status/close_task/assign/create_child_task), you MUST perform at least one candidate-finding lookup with search_workitem or wit_my_work_items before deciding. Do this even if the pre-loaded list or prior meeting context already suggests a likely ID.",
    "  • Otherwise: use search_workitem with keywords from the transcript to find candidates.",
    "  • If search returns nothing but a pre-loaded candidate looks promising, run a follow-up search using the candidate's exact title words before relying on it. If you still cannot ground the item through search/my-work results, return noop for that specific change.",
    "  • For fuzzy shorthand ('launchpad item', 'deployment story', 'the ontology work'), combine ALL transcript cues, prefer a single strong active candidate over older closed items, then run an exact-title search on that candidate before deciding.",
    "  • If multiple candidates: prefer items in active states (New/Active/In Progress/Accepted) and items assigned to the speaker or to people mentioned earlier in the meeting.",
    "  • Before proposing add_comment, use wit_list_work_item_comments to avoid duplicating a recent comment.",
    "  • Before proposing create_task / create_user_story, use search_workitem to verify nothing similar exists.",
    "  • For create_child_task: use wit_get_work_item on the parent to confirm it exists and is the right type (Epic/Feature/User Story for child Task).",
    "",
    "Constraints:",
    "  • Do NOT call any write/mutating tools yourself — those are blocked anyway. Use propose_action.",
    "  • Be conservative on create_*: only propose those when the speaker explicitly asks for a new item AND no close match exists in your search results.",
    "  • Prefer add_comment over update_status when the speaker is just recording a fact.",
    "  • If returning noop because the speaker was asking a question, brainstorming, being speculative, or lacked a grounded work item reference, say that explicitly in the rationale.",
    "  • If a prior action in this meeting already covers what the speaker just said, skip it (don't re-propose).",
    `  • Active project: ${projectStr || "(unset)"} in org: ${orgStr || "(unset)"}.`,
    `  • Maximum ${MAX_STEPS} tool-calling iterations. Use them wisely.`,
  ].join("\n");

  const userPrompt = [
    "# Intent (extracted by the realtime listener — may be short and pronoun-heavy, may contain multiple distinct items)",
    intent,
    "",
    transcriptContext ? "# Full recent transcript (USE THIS to resolve pronouns, find context, and identify ALL distinct actions)\n" + transcriptContext + "\n" : "",
    meeting?.summary ? "# Existing meeting summary\n" + meeting.summary + "\n" : "",
    priorActionsBlock ? "# Prior actions in THIS meeting (avoid duplicating these)\n" + priorActionsBlock + "\n" : "",
    itemListBlock ? "# Pre-loaded active work items (subset of project's active items)\n" + itemListBlock + "\n" : "",
    "Investigate via read tool calls. Call propose_action once per distinct change. Call finalize_planning when done.",
  ].filter(Boolean).join("\n");

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const tools = [...buildToolSchemas(readTools), PROPOSAL_TOOL, FINALIZE_TOOL];

  const proposals = [];
  let finalized = false;
  let finalizeNote = "";
  for (let step = 1; step <= MAX_STEPS && !finalized; step++) {
    if (signal?.aborted) {
      emit("aborted", {});
      return null;
    }
    let choice;
    try {
      choice = await callChatCompletions({ settings, messages, tools });
    } catch (error) {
      emit("error", { message: error?.message || String(error) });
      return null;
    }
    messages.push(choice);
    const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
    if (toolCalls.length === 0) {
      // Model wandered off with plain text. Nudge it once and continue.
      emit("thinking", { message: "Model produced text instead of a tool call; nudging." });
      const stillNeeded = proposals.length === 0
        ? "You did not call a tool. Call propose_action for each distinct change (or just finalize_planning if nothing should change)."
        : `You have proposed ${proposals.length} action(s). Call finalize_planning now to finish, or propose_action if more actions are warranted.`;
      messages.push({ role: "user", content: stillNeeded });
      continue;
    }
    for (const call of toolCalls) {
      const callName = call?.function?.name;
      let parsedArgs = {};
      try { parsedArgs = call?.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch {}
      if (callName === "propose_action") {
        if (proposals.length >= MAX_PROPOSALS) {
          emit("thinking", { message: `Skipping additional proposal — already at MAX_PROPOSALS=${MAX_PROPOSALS}.` });
          messages.push({ role: "tool", tool_call_id: call.id, content: `error: max proposals (${MAX_PROPOSALS}) reached. Call finalize_planning.` });
          continue;
        }
        proposals.push(parsedArgs);
        emit("proposal", { action: parsedArgs.action, args: parsedArgs, index: proposals.length });
        messages.push({ role: "tool", tool_call_id: call.id, content: `ok (proposal ${proposals.length} recorded)` });
        continue;
      }
      if (callName === "finalize_planning") {
        finalizeNote = String(parsedArgs.note ?? "").trim();
        finalized = true;
        messages.push({ role: "tool", tool_call_id: call.id, content: "ok" });
        break;
      }
      // Otherwise: auto-execute the read tool via the MCP bridge
      emit("tool_call", { name: callName, args: parsedArgs });
      let toolResult;
      try {
        toolResult = await bridge.callTool(callName, parsedArgs);
      } catch (error) {
        toolResult = { error: error?.message || String(error) };
        emit("tool_error", { name: callName, error: toolResult.error });
      }
      const summary = summarizeResult(toolResult, 400);
      emit("tool_result", { name: callName, summary });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult).slice(0, 8000),
      });
    }
  }

  if (!finalized && proposals.length === 0) {
    emit("error", { message: `Planner exhausted ${MAX_STEPS} steps without a proposal.` });
    return null;
  }

  // Persist each proposal as its own proposed_action row.
  const persistedRows = [];
  const meaningful = proposals.filter((p) => p && p.action && p.action !== "noop");
  for (const proposal of meaningful) {
    const toolArgs = {
      action: proposal.action,
      summary: proposal.summary,
      rationale: proposal.rationale,
      work_item_id: proposal.work_item_id,
      parent_work_item_id: proposal.parent_work_item_id,
      new_state: proposal.new_state,
      assignee: proposal.assignee,
      comment: proposal.comment,
      title: proposal.title,
      description: proposal.description,
    };
    const row = store.createProposedAction({
      meetingId,
      transcriptItemId: null,
      transcriptSnippet: transcriptContext || intent,
      toolName: "propose_status_update",
      toolArgs,
    });
    persistedRows.push(row);
  }

  if (persistedRows.length === 0) {
    const noopProposal = proposals.find((p) => p?.action === "noop");
    emit("done", {
      decision: "noop",
      rationale: noopProposal?.rationale || finalizeNote || "Planner returned no actionable changes.",
      proposal_count: 0,
    });
    return null;
  }

  emit("done", {
    decision: persistedRows.length === 1 ? persistedRows[0].tool_name : "multi",
    proposal_count: persistedRows.length,
    proposed_action_ids: persistedRows.map((r) => r.id),
    note: finalizeNote || undefined,
  });
  return persistedRows;
}

module.exports = {
  runPlanner,
  isReadOnlyTool,
};
