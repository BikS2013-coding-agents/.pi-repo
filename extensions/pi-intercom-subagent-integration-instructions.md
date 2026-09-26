# Pi Intercom Integration Instructions for Subagent Extensions

Status: reusable implementation instructions  
Created: 2026-06-30  
Primary reference implementation: `extensions/worker-subagent-extension/`  
Related runtime package: `~/.pi/agent/npm/node_modules/pi-intercom/`

## Purpose

Use these instructions when enhancing any Pi subagent extension so a child subagent can communicate with its supervisor through `pi-intercom`, especially for blocking decisions via `contact_supervisor`.

These instructions capture the working integration pattern proven during the `worker_subagent` bridge fixes. They are intended to be reused across subagents such as request refiners, investigators, planners, designers, test builders, dependency validators, and future subagent extensions.

## Desired User Experience

A subagent should be able to do this inside the child Pi process:

```typescript
contact_supervisor({
  reason: "need_decision",
  message: "Which file should I modify first?"
})
```

The supervisor should see a clear waiting notice and reply while the foreground subagent tool is still running:

```text
/intercom-reply Do not modify any file. This is a bridge test only; report that the supervisor reply was received.
```

The child should receive the reply as the `contact_supervisor` tool result and continue normally.

## Core Architecture

There are two cooperating layers:

1. **Subagent launcher extension** — e.g. `worker-subagent-extension/index.ts`.
   - Spawns the child `pi` process.
   - Gives the child a stable intercom session name.
   - Injects bridge metadata through environment variables.
   - Includes `contact_supervisor` and `intercom` in the child tool allowlist.
   - Streams parent-visible wait notices when the child calls `contact_supervisor`.

2. **`pi-intercom` extension** — installed package at `~/.pi/agent/npm/node_modules/pi-intercom/`.
   - Reads child bridge metadata.
   - Registers the child-only `contact_supervisor` tool.
   - Sends blocking/non-blocking supervisor messages.
   - Provides `/intercom-reply <message>` so the supervisor can answer immediately while a foreground tool is still running.
   - Cleans up stale pending asks and deferred UI messages.

## Required Child Bridge Metadata

When launching a child Pi process, set these environment variables:

```text
PI_SUBAGENT_ORCHESTRATOR_TARGET=<parent session name or fallback alias>
PI_SUBAGENT_RUN_ID=<uuid>
PI_SUBAGENT_CHILD_AGENT=<agent-name>
PI_SUBAGENT_CHILD_INDEX=<zero-based-child-index>
PI_SUBAGENT_INTERCOM_SESSION_NAME=<stable child intercom name>
```

`pi-intercom` only registers `contact_supervisor` when the required metadata is present.

Recommended constants:

```typescript
const SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET";
const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
const SUBAGENT_CHILD_INDEX_ENV = "PI_SUBAGENT_CHILD_INDEX";
const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";
```

## Stable Naming Rules

The parent supervisor target should be resolvable even when the parent session is unnamed.

Use this pattern:

```typescript
const DEFAULT_INTERCOM_TARGET_PREFIX = "subagent-chat";

function resolveIntercomSessionTarget(sessionName: string | undefined, sessionId: string): string {
  const trimmedName = sessionName?.trim();
  if (trimmedName) return trimmedName;
  const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `${DEFAULT_INTERCOM_TARGET_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}
```

The child session name should be deterministic for a run:

```typescript
function sanitizeIntercomTargetPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent";
}

function resolveSubagentIntercomTarget(runId: string, agent: string, index: number): string {
  return `subagent-${sanitizeIntercomTargetPart(agent)}-${sanitizeIntercomTargetPart(runId)}-${index + 1}`;
}
```

Example child target:

```text
subagent-worker-97c99468-34f1-4075-a5d6-2db3880fe6b9-1
```

## Child Process Launch Requirements

When spawning child `pi`, include:

```text
--mode json
-p
--no-session
--no-skills
--tools <subagent tools plus contact_supervisor,intercom>
--system-prompt <agent prompt file>
--name <child intercom session name>
```

Example tool allowlist:

```typescript
const CHILD_TOOLS = "read,grep,find,ls,bash,edit,write,contact_supervisor,intercom";
```

For non-writer subagents, keep the specific subagent's normal tools but add `contact_supervisor,intercom` when supervisor coordination is desired.

Example spawn environment:

```typescript
const childEnv: NodeJS.ProcessEnv = { ...process.env };
childEnv[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = orchestratorTarget;
childEnv[SUBAGENT_RUN_ID_ENV] = runId;
childEnv[SUBAGENT_CHILD_AGENT_ENV] = childAgent;
childEnv[SUBAGENT_CHILD_INDEX_ENV] = String(childIndex);
childEnv[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = childSessionName;
```

Then spawn:

```typescript
const args = [
  "--mode", "json",
  "-p",
  "--no-session",
  "--no-skills",
  "--tools", CHILD_TOOLS,
  "--system-prompt", promptPath,
  "--name", childSessionName,
  task,
];
```

## Parent-Side Wait Notice

The parent subagent launcher must detect child JSON events where the child starts `contact_supervisor`:

```json
{
  "type": "tool_execution_start",
  "toolName": "contact_supervisor",
  "args": {
    "reason": "need_decision",
    "message": "Which file should I modify first?"
  }
}
```

When detected, stream an `onUpdate` message to the supervisor.

The notice must explicitly say that normal steering cannot unblock the child and that the user should use `/intercom-reply`.

Recommended formatter:

```typescript
function formatSupervisorWaitNotice(
  args: Record<string, unknown>,
  bridge: { orchestratorTarget: string; childSessionName: string } | undefined,
): string {
  const reason = typeof args.reason === "string" ? args.reason : "unknown";
  const message = typeof args.message === "string" ? args.message : "(no message text supplied)";
  const lines = [
    `Worker called contact_supervisor with reason=${reason}.`,
    "The worker is paused waiting for the supervisor reply; this is expected for need_decision/interview_request.",
    bridge ? `Supervisor target: ${bridge.orchestratorTarget}` : undefined,
    bridge ? `Child intercom session: ${bridge.childSessionName}` : undefined,
    "Reply from the parent Pi session with the immediate slash command:",
    "/intercom-reply <your decision>",
    "",
    "Do not type a normal steering message like 'reply to worker...': steering is queued until the current subagent tool finishes, so it cannot unblock the waiting child.",
    "If the agent is already idle, the regular tool form also works: intercom({ action: \"reply\", message: \"<your decision>\" })",
    "",
    "Worker message:",
    message,
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}
```

Adapt the word `Worker` to the subagent type when appropriate.

## Critical Reply Rule

When a foreground subagent tool is running, the supervisor must reply with:

```text
/intercom-reply <message>
```

Do **not** instruct users to type a normal sentence such as:

```text
reply to the worker to do X
```

That creates a deadlock because Pi queues steering until the current tool call finishes, and the current tool call cannot finish until the child receives the supervisor reply.

The regular tool form is only appropriate when the parent agent is already idle:

```typescript
intercom({ action: "reply", message: "..." })
```

## `contact_supervisor` Semantics

The child-only `contact_supervisor` tool supports these reasons:

| Reason | Blocking | Use when |
|---|---:|---|
| `need_decision` | Yes | The child is blocked, uncertain, or needs scope/product/API approval before continuing. |
| `interview_request` | Yes | The child needs multiple structured supervisor answers in one exchange. |
| `progress_update` | No | The child reports meaningful progress or a plan-changing discovery. |

Do not use `contact_supervisor` for routine completion. The subagent should return its final result normally.

## Dedicated Blocking Client Requirement in `pi-intercom`

Blocking `contact_supervisor` calls must use a dedicated per-tool intercom connection, not only the normal session-scoped client.

Rationale:

- Foreground/print-mode child Pi lifecycle can disconnect its normal session-scoped intercom client while a tool is still waiting.
- If the child disappears from the broker while the parent still has a pending ask, replies fail with `Session not found`.
- A dedicated per-tool client remains registered until reply/timeout/cancel/failure.

Implementation pattern inside `pi-intercom`:

1. Create a new `IntercomClient` for blocking `need_decision` / `interview_request`.
2. Register it with the stable child session name from `PI_SUBAGENT_INTERCOM_SESSION_NAME`.
3. Send the supervisor ask through this dedicated client.
4. Wait for a matching reply on this client (`replyTo === questionId`).
5. Disconnect the dedicated client in `finally`.

The active `pi-intercom` package already implements this pattern; future changes must preserve it.

## Pending Ask and Deferred UI Cleanup

When integrating subagents, ensure the intercom layer cleans both pending state and deferred UI state.

Important state buckets:

- `ReplyTracker.pendingAsks` — used to resolve `/intercom-reply` and `intercom({ action: "reply" })`.
- `pendingIdleMessages` — inbound intercom messages queued for display after the parent becomes idle.

When a reply succeeds, both must be cleared for that `replyTo`.

Recommended invariant:

```typescript
markRepliedAndDropQueued(replyTo)
```

must:

1. mark the ask replied in `ReplyTracker`, and
2. remove matching deferred messages from `pendingIdleMessages`.

When a child session leaves, remove:

1. pending asks from that sender, and
2. deferred UI messages from that sender.

Otherwise, a stale ask can render after the child already completed, causing a second reply attempt and `Session not found`.

## Child Prompt Guidance

Subagent system prompts should include guidance like this:

```text
If a live supervisor coordination tool is available, use contact_supervisor with reason='need_decision' when a new unapproved decision is required before continuing. Wait for the reply and continue with that decision.

Use reason='progress_update' only for meaningful non-blocking updates or unexpected discoveries that change the plan.

Do not send routine completion handoffs through contact_supervisor; return the final result normally.

If contact_supervisor is unavailable and implementation reveals a required unapproved decision, stop and report the blocker clearly instead of silently choosing.
```

For writer subagents, also include:

```text
Do not make edits while waiting for a required supervisor decision.
```

## Parent Tool Result Handling

The parent launcher should parse child JSON output and surface useful events:

- `tool_execution_start` with `toolName === "contact_supervisor"`
  - Stream the wait notice.
- `tool_result_end`
  - Optionally stream the child-visible tool result so the supervisor can see that the reply was received.
- `message_end`
  - Capture final child text.

Do not treat a blocking `contact_supervisor` call as a hang; it is expected to wait up to the intercom ask timeout.

## Timeout and Abort Behavior

Blocking asks currently have a 10-minute timeout.

If the supervisor does not reply in time:

- The child should receive a failure from `contact_supervisor`.
- The child should report that no decision was received and avoid making unapproved changes.
- The parent should not keep stale pending asks.

If the parent aborts `worker_subagent` or another foreground subagent tool:

- The child process is killed.
- Any later reply will fail because the child session is gone.
- Pending/deferred intercom state must be cleaned by `session_left` handling where possible.

## Documentation Requirements for Each Enhanced Subagent

When adding this integration to a subagent extension, update that extension's README with:

1. The injected bridge env vars.
2. The child `--name` convention.
3. The child tool allowlist addition (`contact_supervisor,intercom`).
4. How the parent wait notice appears.
5. The exact reply instruction:

```text
/intercom-reply <decision>
```

6. A warning that normal steering cannot unblock a foreground subagent.
7. Validation steps.

## Testing Instructions for Enhanced Subagents

Every subagent enhanced with `pi-intercom` / `contact_supervisor` must be tested at four levels:

1. **Static/source validation** — the implementation has the required bridge pieces.
2. **Load validation** — Pi can load the enhanced extension with `pi-intercom`.
3. **Interactive bridge validation** — the supervisor can reply while the foreground subagent tool is still running.
4. **Lifecycle/cleanup validation** — timeout, abort, completion, and stale-message paths do not leave broken pending state.

Create any ad hoc test scripts under the active project's `test_scripts/` folder. Keep scripts focused, deterministic where possible, and non-destructive.

### Test Preconditions

Before testing a subagent extension:

- Restart Pi or run `/reload` so the edited extension code is active.
- Confirm `pi-intercom` is listed under `[Extensions]` at startup.
- Confirm the enhanced subagent extension is listed under `[Extensions]` at startup.
- Use a safe project directory where the test task can inspect files without making edits.
- Use a test task that explicitly forbids edits until after supervisor approval.
- Keep the expected supervisor reply ready as a slash command:

```text
/intercom-reply Do not modify any file. This is a bridge test only; report that contact_supervisor reply delivery worked.
```

### 1. Static Source Validation

Inspect the enhanced subagent extension source before running interactive tests.

Required checks:

- The child process launch includes a stable `--name <child intercom session name>`.
- The child environment includes all required bridge variables:
  - `PI_SUBAGENT_ORCHESTRATOR_TARGET`
  - `PI_SUBAGENT_RUN_ID`
  - `PI_SUBAGENT_CHILD_AGENT`
  - `PI_SUBAGENT_CHILD_INDEX`
  - `PI_SUBAGENT_INTERCOM_SESSION_NAME`
- The child tool allowlist includes `contact_supervisor` and `intercom`.
- The parent launcher parses child JSON events and detects:

```typescript
event.type === "tool_execution_start" && event.toolName === "contact_supervisor"
```

- The parent wait notice includes:
  - contact reason,
  - supervisor target,
  - child intercom session name,
  - `/intercom-reply <your decision>`,
  - warning that normal steering cannot unblock the foreground subagent tool.
- The child system prompt explains when to use `contact_supervisor` and when not to use it.
- The subagent README documents the bridge and retest steps.

Useful source inspection command:

```bash
rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name" \
  /path/to/subagent-extension
```

Expected: all required bridge pieces are present.

### 2. Load Validation

Validate the enhanced extension loads together with `pi-intercom`:

```bash
pi --no-extensions --offline \
  -e /Users/giorgosmarinos/.pi/agent/npm/node_modules/pi-intercom \
  -e /path/to/subagent-extension \
  --list-models
```

Expected:

- Exit code `0`.
- No TypeScript import/runtime errors.
- No extension registration errors.

Also validate normal global autoload if the extension is symlinked into `~/.pi/agent/extensions`:

```bash
pi --offline --list-models
```

Expected: exit code `0`.

### 3. Startup Resource Validation

Start a fresh interactive Pi session in the test project:

```bash
pi5.5
```

or the wrapper/model normally used for development.

Expected startup output:

- `[Extensions]` includes `pi-intercom`.
- `[Extensions]` includes the enhanced subagent extension.
- If the subagent has a skill, `[Skills]` includes the relevant skill.

If the old wait notice text still appears later, restart or `/reload` again and verify the active extension path.

### 4. Bridge Metadata and Wait Notice Validation

Run a task that forces the child to contact the supervisor before any edit.

For writer-like subagents:

```text
Use <subagent_tool> with task="Inspect the current project and before making any edit, contact the supervisor with reason need_decision asking which file you should modify first."
```

For non-writer subagents, adapt the task so it is safe and still requires a decision, for example:

```text
Use <subagent_tool> for a dry-run inspection. Before writing any output file or making any recommendation, contact the supervisor with reason need_decision asking whether to proceed with the dry-run output.
```

Expected parent-visible wait notice:

```text
<Subagent> called contact_supervisor with reason=need_decision.
The <subagent> is paused waiting for the supervisor reply...
Supervisor target: <parent-target>
Child intercom session: subagent-<agent>-<run-id>-1
Reply from the parent Pi session with the immediate slash command:
/intercom-reply <your decision>
```

The notice must **not** instruct the user to use only the regular tool form while the foreground tool is running:

```typescript
intercom({ action: "reply", message: "..." })
```

That regular form may be documented as idle-only, but `/intercom-reply` must be the primary instruction for foreground subagent waits.

### 5. Blocking Reply Validation

While the foreground subagent tool is still running and the child is waiting, type the slash command directly in the Pi input box:

```text
/intercom-reply Do not modify any file. This is a bridge test only; report that contact_supervisor reply delivery worked.
```

Expected:

- The command executes immediately; it must not appear as queued `Steering:`.
- UI shows a success notification or transcript line similar to:

```text
Reply sent to subagent-<agent>-<run-id>-1
```

- The child receives the reply as the `contact_supervisor` tool result.
- The child continues and returns a normal final result.
- The final result explicitly states the supervisor reply was received.
- No files are modified unless the supervisor reply explicitly authorizes edits.

For a bridge-only test, expected final response shape:

```text
Implemented supervisor bridge test only.
Changed files: none.
Validation: inspected project layout and contacted supervisor before any edit; received supervisor reply successfully.
Open risks/questions: none.
Recommended next step: none.
```

### 6. Normal Steering Negative Test

Run the same bridge test again. When the child waits, intentionally type a normal sentence instead of the slash command:

```text
reply to the subagent that it should not modify any file
```

Expected:

- Pi shows it as queued steering, for example:

```text
Steering: reply to the subagent...
```

- The child remains blocked until timeout or until you abort.

This validates the documented limitation and proves why `/intercom-reply` is required. Do this only as a controlled negative test because it intentionally blocks the child.

After observing the queued steering behavior, abort or let the child time out, then clear/restart the session before the next test.

### 7. Stale Message Cleanup Validation

Run the successful blocking reply test again.

After the subagent completes:

1. Wait a few seconds for any deferred inbound messages to flush.
2. Confirm that the original ask does **not** render again after completion.
3. Ask the parent agent or use the intercom tool when idle:

```typescript
intercom({ action: "pending" })
```

Expected:

```text
No unresolved inbound asks.
```

There must be no second attempted reply to a completed child and no post-completion `Session not found` caused by a stale displayed ask.

### 8. Timeout Validation

Run a controlled bridge test and do not reply.

Expected after the `contact_supervisor` timeout:

- Child reports that no supervisor reply was received within the timeout.
- Child does not make unapproved edits or decisions.
- Parent tool returns a clear blocked/timeout result, not a silent success.
- `intercom({ action: "pending" })` eventually reports no unresolved inbound asks.
- No stale ask is displayed after the timeout result.

Use this test sparingly because it may take up to the configured timeout, commonly 10 minutes.

### 9. Abort Validation

Run a bridge test and abort the parent foreground subagent tool while the child is waiting.

Expected:

- Parent reports the child was aborted, commonly exit code `143` for SIGTERM.
- The child session disappears from intercom.
- A later reply attempt, if any, may fail with `Session not found`, but the pending ask should be cleaned and should not remain indefinitely.
- `intercom({ action: "pending" })` should show no unresolved inbound asks after cleanup/reload.

This test confirms abort behavior is understandable and does not leave persistent stale state.

### 10. Multiple Pending Ask Validation

If the enhanced workflow can launch multiple child subagents in parallel, test multiple pending asks.

Expected:

- `intercom({ action: "pending" })` lists each pending ask with sender and message ID.
- `/intercom-reply <message>` should be used only when there is exactly one active/single pending ask.
- If multiple asks are pending, either:
  - use an explicit disambiguation command/tool path supported by the current implementation, or
  - reply from separate supervisor interactions in a controlled order.

Do not mark a parallel subagent integration complete until the multiple-child reply story is documented and tested.

### 11. Progress Update Validation

Test non-blocking progress updates separately:

```typescript
contact_supervisor({
  reason: "progress_update",
  message: "Dry-run discovered X; continuing with the approved plan."
})
```

Expected:

- Parent receives the progress update.
- Child does not block waiting for a reply.
- No pending ask is created.
- `intercom({ action: "pending" })` reports no unresolved inbound asks.

### 12. Structured Interview Validation

For subagents that use `interview_request`, run a structured test with at least:

- one `single` question,
- one `text` question,
- optionally one `info` question.

Example child request:

```typescript
contact_supervisor({
  reason: "interview_request",
  message: "Please answer these before I continue.",
  interview: {
    title: "Bridge Test Interview",
    questions: [
      { id: "proceed", type: "single", question: "Proceed with dry-run output?", options: ["Yes", "No"] },
      { id: "constraint", type: "text", question: "What constraint should be preserved?" },
      { id: "context", type: "info", question: "This is a test only." }
    ]
  }
})
```

Reply while the foreground tool is running:

```text
/intercom-reply { "responses": [ { "id": "proceed", "value": "No" }, { "id": "constraint", "value": "Do not write files." } ] }
```

Expected:

- Child receives the raw reply.
- Parsed structured reply is available in tool details when supported.
- `info` questions do not require response entries.
- Invalid option labels produce a clear parse warning/error rather than silent acceptance.

### 13. Cross-Session Reply Validation

Optionally test from a second visible Pi session.

1. Start a second Pi session in the same project.
2. Name it clearly, e.g. `/name supervisor-test`.
3. Run the subagent in the parent session.
4. Use `intercom({ action: "list" })` from both sessions to confirm visibility.
5. Reply from the intended supervisor path.

Expected:

- Session names resolve correctly.
- No duplicate-name ambiguity occurs.
- Replies are delivered to the correct child.

### 14. Test Evidence to Record

For every enhanced subagent, record a short validation note in that extension's README or an appropriate project reference document:

```text
Pi-intercom bridge validation — YYYY-MM-DD
- Load validation: passed (`pi --no-extensions --offline -e ... --list-models`)
- Blocking need_decision reply: passed with `/intercom-reply ...`
- Stale message cleanup: passed; no post-completion ask rendered; pending empty
- Timeout/abort behavior: tested or intentionally not tested with reason
- Progress update: passed/not applicable
- Interview request: passed/not applicable
- Changed files during bridge-only test: none
```

## Minimal Validation Checklist

Before marking an enhanced subagent complete, all applicable items below must pass:

- [ ] Static source validation confirms bridge env vars, stable child name, and tool allowlist.
- [ ] Load validation passes with `pi --no-extensions --offline -e pi-intercom -e subagent --list-models`.
- [ ] Global autoload validation passes when symlinked/installed.
- [ ] Startup output lists both `pi-intercom` and the enhanced subagent extension.
- [ ] Wait notice includes reason, supervisor target, child intercom session, and `/intercom-reply`.
- [ ] Wait notice warns that normal steering cannot unblock the child.
- [ ] Blocking `need_decision` reply via `/intercom-reply` succeeds while the foreground tool is still running.
- [ ] Child receives the reply and completes normally.
- [ ] Bridge-only test changes no files.
- [ ] No stale ask renders after successful completion.
- [ ] `intercom({ action: "pending" })` reports no unresolved asks after completion.
- [ ] Timeout or abort behavior is tested or explicitly documented as not tested.
- [ ] `progress_update` is tested if the subagent uses it.
- [ ] `interview_request` is tested if the subagent uses it.
- [ ] Evidence is documented in the extension README or reference notes.

## Common Failure Modes

### User typed a normal sentence instead of `/intercom-reply`

Symptom:

```text
Steering: reply to worker...
```

Cause: The message is queued until the foreground subagent tool finishes.

Fix: Use:

```text
/intercom-reply <message>
```

### Reply fails with `Session not found`

Possible causes:

- Child timed out and exited before the reply.
- Parent aborted the foreground subagent tool.
- Stale deferred UI message rendered after successful completion.
- Blocking `contact_supervisor` is not using the dedicated per-tool intercom client.

Fixes:

- Reply before the timeout.
- Do not abort the parent tool unless intentionally stopping the child.
- Ensure `markRepliedAndDropQueued` behavior exists in `pi-intercom`.
- Ensure blocking `contact_supervisor` uses a dedicated client.

### Parent wait notice still shows `intercom({ action: "reply" ... })`

Cause: Running Pi process did not load the updated subagent launcher source, or another copy of the extension is being loaded.

Fix:

- Restart Pi or run `/reload`.
- Verify extension path and symlink.
- Search active source for the wait notice text.

## Implementation Checklist for Future Subagent Enhancements

Use this checklist before marking a subagent as pi-intercom-enabled:

- [ ] Child process is launched with `--name <stable child intercom name>`.
- [ ] Child process receives all required `PI_SUBAGENT_*` env vars.
- [ ] Child tool allowlist includes `contact_supervisor` and `intercom`.
- [ ] Parent target fallback alias uses `subagent-chat-<session-id-prefix>` when unnamed.
- [ ] Parent launcher detects `tool_execution_start` for `contact_supervisor`.
- [ ] Parent wait notice tells users to use `/intercom-reply <message>`.
- [ ] Parent wait notice warns that normal steering cannot unblock the child.
- [ ] Child prompt explains when to use `contact_supervisor`.
- [ ] Blocking `contact_supervisor` path uses the `pi-intercom` dedicated-client implementation.
- [ ] Stale pending asks and deferred UI messages are cleaned after reply/session exit.
- [ ] README documents the integration and retest procedure.
- [ ] Load validation passes.
- [ ] Blocking reply validation passes.
- [ ] Stale-message validation passes.

## References

- Reference subagent launcher: `/Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/worker-subagent-extension/index.ts`
- Reference launcher README: `/Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/worker-subagent-extension/README.md`
- Runtime intercom package: `/Users/giorgosmarinos/.pi/agent/npm/node_modules/pi-intercom/`
- `pi-intercom` skill: `/Users/giorgosmarinos/.pi/agent/npm/node_modules/pi-intercom/skills/pi-intercom/SKILL.md`
- Project fix notes:
  - `/Users/giorgosmarinos/aiwork/llama-cpp/test/docs/reference/pi-intercom-subagent-reply-lifecycle-fix.md`
  - `/Users/giorgosmarinos/aiwork/llama-cpp/test/docs/reference/pi-intercom-immediate-subagent-reply-command-fix.md`
  - `/Users/giorgosmarinos/aiwork/llama-cpp/test/docs/reference/pi-intercom-stale-queued-ask-display-fix.md`
