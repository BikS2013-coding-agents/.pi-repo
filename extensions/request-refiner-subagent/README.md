# Request Refiner Subagent Pi Extension

This Pi extension registers the `request_refiner_subagent` tool. The tool delegates request refinement to an isolated child Pi process that reads relevant project context, writes a refined request specification under `docs/reference/`, and returns a concise caller report.

## Files

- `index.ts` — Pi extension entrypoint.
- `request-refiner-agent.md` — adapted request-refiner subagent prompt derived from `/Users/giorgosmarinos/aiwork/llama-cpp/test/subagent-specs/request-refiner.md`.

## Tool

### `request_refiner_subagent`

Parameters:

- `rawRequest` (required): raw user request to refine.
- `projectRoot` (optional): project root for `docs/reference/refined-request-<slug>.md`; defaults to the current Pi working directory.
- `outputSlug` (optional): preferred lowercase hyphenated slug.
- `additionalContext` (optional): extra constraints or context from the parent agent.
- `model` (optional): explicit Pi model selector for the child process. Defaults to the calling agent's current model; use `same`, `current`, `caller`, `calling-agent`, or omit it to forward the caller model.

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this. It runs in JSON print mode with restricted file-oriented tools plus the pi-intercom supervisor bridge tools:

```text
--no-session --no-skills --name <child-intercom-name> --system-prompt request-refiner-agent.md --tools read,write,grep,find,ls,contact_supervisor,intercom
```

`contact_supervisor` and `intercom` are included so the child can coordinate with the parent supervisor when the `pi-intercom` extension is installed and active.

## pi-intercom supervisor bridge

The extension injects the reusable `pi-intercom` subagent bridge metadata into every child request-refiner run:

```text
PI_SUBAGENT_ORCHESTRATOR_TARGET=<parent session name or subagent-chat-<session-id-prefix>>
PI_SUBAGENT_RUN_ID=<uuid>
PI_SUBAGENT_CHILD_AGENT=request-refiner
PI_SUBAGENT_CHILD_INDEX=0
PI_SUBAGENT_INTERCOM_SESSION_NAME=subagent-request-refiner-<run-id>-1
```

The child Pi process is also launched with the matching stable name:

```text
--name subagent-request-refiner-<run-id>-1
```

If `pi-intercom` is installed and loaded in the child process, it sees this metadata and registers the child-only `contact_supervisor` tool. The request refiner can then call:

```text
contact_supervisor({ reason: "need_decision", message: "..." })
contact_supervisor({ reason: "progress_update", message: "..." })
contact_supervisor({ reason: "interview_request", interview: { ... } })
```

The request-refiner prompt keeps refinement primarily non-interactive. The child should use blocking supervisor contact only for rare critical ambiguities that would make the refined specification misleading, unsafe, or unusable if handled only as assumptions/open questions. Routine ambiguities should still be documented in `Open Questions` with recommended defaults. The child must not write the refined-request artifact while waiting if the supervisor decision affects its content. If `contact_supervisor` is unavailable or times out, the child should proceed only with documented assumptions/open questions when safe, or report a blocker clearly.

When the child starts `contact_supervisor`, the parent extension parses the child JSON event and streams a wait notice that includes:

- the contact reason;
- the supervisor target;
- the child intercom session name;
- the child message; and
- the exact foreground reply instruction:

```text
/intercom-reply <your decision>
```

Do not type a normal steering message like "reply to the request refiner..." while `request_refiner_subagent` is still running. Pi queues normal steering until the foreground tool call finishes, so it cannot unblock a child that is waiting inside `contact_supervisor`. Use `/intercom-reply ...` while the tool is running. When the parent agent is already idle, the regular tool form also works:

```typescript
intercom({ action: "reply", message: "<your decision>" })
```

Do not abort the foreground `request_refiner_subagent` tool while a `need_decision` or `interview_request` contact is pending unless the goal is to intentionally kill the child run.

## Validation

Recommended validation after edits or reloads:

```bash
rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name" \
  /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/request-refiner-subagent

pi --no-extensions --offline \
  -e /Users/giorgosmarinos/.pi/agent/npm/node_modules/pi-intercom \
  -e /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/request-refiner-subagent \
  --list-models

pi --offline --list-models
```

For interactive bridge validation, reload or restart Pi so the updated extension is active. Run `request_refiner_subagent` in a safe fixture project with a deliberately ambiguous raw request and `additionalContext` instructing the child to contact the supervisor before writing if the ambiguity is critical. When the wait notice appears, reply immediately in the parent Pi input with:

```text
/intercom-reply Do not modify any unrelated file. This is a bridge test only; continue by documenting the chosen default and report that contact_supervisor reply delivery worked.
```

Expected result: the slash command is handled immediately, the child receives the reply as the `contact_supervisor` result, the child completes normally, it writes only the expected `docs/reference/refined-request-*.md` file, no stale ask appears after completion, and `intercom({ action: "pending" })` reports no unresolved inbound asks when checked after the run.

Lifecycle tests for timeout, abort, `progress_update`, and `interview_request` should be run when changing bridge behavior. Timeout testing can take up to the configured intercom ask timeout and may be documented as intentionally not run for quick source-only changes.

### Pi-intercom bridge validation — 2026-06-30

- Static/source validation: passed with `rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name|SUBAGENT_|--no-skills|--system-prompt" /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/request-refiner-subagent/{index.ts,request-refiner-agent.md,README.md}`.
- Load validation: passed with `pi --no-extensions --offline -e /Users/giorgosmarinos/.pi/agent/npm/node_modules/pi-intercom -e /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/request-refiner-subagent --list-models`.
- Global autoload validation: passed with `pi --offline --list-models` while `/Users/giorgosmarinos/.pi/agent/extensions/request-refiner-subagent` is a symlink to this source folder.
- Non-interactive refinement validation: passed in temporary project `/tmp/request-refiner-validation-Tcd7x2`; output file created at `/tmp/request-refiner-validation-Tcd7x2/docs/reference/refined-request-validation-fixture-readme.md`.
- Blocking `need_decision` interactive reply: not run in this API implementation session because it requires a live foreground Pi UI to type `/intercom-reply ...` while `request_refiner_subagent` is running. Use the manual steps above after `/reload` or restart.
- Stale-message cleanup / pending empty check: not run for the same reason; verify with `intercom({ action: "pending" })` after the interactive bridge test.
- Timeout, abort, `progress_update`, and `interview_request`: not run; these are lifecycle/manual follow-up tests unless bridge behavior changes again.
- Changed files during bridge-only testing: none; only extension source/prompt/README documentation were edited during this enhancement. The non-interactive validation wrote only to the temporary `/tmp/request-refiner-validation-Tcd7x2` fixture.

## Installation

The source folder is intended to be symlinked into Pi's user extension directory:

```bash
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/request-refiner-subagent" \
  "$HOME/.pi/agent/extensions/request-refiner-subagent"
```

Reload Pi after creating or updating the symlink:

```text
/reload
```

or restart Pi.

## Example Invocation

Ask Pi to use the tool, for example:

```text
Use request_refiner_subagent to refine this request: "Build a dashboard that shows Azure costs by team."
```

The expected subagent output is a short report containing the refined request file path, slug, category, key scope boundaries, and open questions.
