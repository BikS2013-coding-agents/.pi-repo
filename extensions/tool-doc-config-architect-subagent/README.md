# Tool Doc Config Architect Subagent Pi Extension

This Pi extension registers the `tool_doc_config_architect_subagent` tool. The tool delegates TypeScript CLI tool documentation/configuration scaffolding or read-only convention auditing to an isolated child Pi process.

## Files

- `index.ts` — Pi extension entrypoint.
- `tool-doc-config-architect-agent.md` — adapted tool-doc-config-architect subagent prompt derived from `/Users/giorgosmarinos/aiwork/llama-cpp/test/subagent-specs/tool-doc-config-architect.md`.

## Tool

### `tool_doc_config_architect_subagent`

Parameters:

- `mode` (required): `scaffold` or `audit`.
- `tool_name` (required): lowercase-with-hyphens tool name.
- `project_root` (optional): absolute or cwd-relative path to the project root. Defaults to the current Pi working directory.
- `tool_description` (required for scaffold): one-or-two-sentence summary of what the tool does.
- `tool_command` (required for scaffold): exact CLI command users will run.
- `llm_required` (required for scaffold): `yes` or `no`.
- `extra_config_vars` (optional): array of `{ name, purpose }` non-LLM configuration variables.
- `model` (optional): explicit Pi model selector for the child process. Defaults to the calling agent's current model; use `same`, `current`, `caller`, `calling-agent`, or omit it to forward the caller model.

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this. It runs in JSON print mode with restricted locally available tools plus pi-intercom supervisor bridge tools:

```text
--no-session --no-skills --name <child-intercom-name> --system-prompt tool-doc-config-architect-agent.md --tools read,write,edit,grep,find,ls,bash,contact_supervisor,intercom
```

`contact_supervisor` and `intercom` are included so the child can coordinate with the parent supervisor when the `pi-intercom` extension is installed and active.

## Modes

### Scaffold

Writes conformant artifacts for a new or partially configured tool:

- `<project_root>/docs/tools/<tool-name>.md`
- `~/.tool-agents/<tool-name>/` with mode `0700`
- `~/.tool-agents/<tool-name>/.env` with mode `0600`

It returns a report with compliance status and a recommended `CLAUDE.md` Tools section entry, but it does **not** modify `CLAUDE.md`.

### Audit

Performs a read-only conformance check and returns findings/remediation. Audit mode must not write or modify any file.

## pi-intercom supervisor bridge

The extension injects the reusable `pi-intercom` subagent bridge metadata into every child tool-doc-config-architect run:

```text
PI_SUBAGENT_ORCHESTRATOR_TARGET=<parent session name or subagent-chat-<session-id-prefix>>
PI_SUBAGENT_RUN_ID=<uuid>
PI_SUBAGENT_CHILD_AGENT=tool-doc-config-architect
PI_SUBAGENT_CHILD_INDEX=0
PI_SUBAGENT_INTERCOM_SESSION_NAME=subagent-tool-doc-config-architect-<run-id>-1
```

The child Pi process is also launched with the matching stable name:

```text
--name subagent-tool-doc-config-architect-<run-id>-1
```

If `pi-intercom` is installed and loaded in the child process, it sees this metadata and registers the child-only `contact_supervisor` tool. The tool-doc-config architect can then call:

```text
contact_supervisor({ reason: "need_decision", message: "..." })
contact_supervisor({ reason: "progress_update", message: "..." })
contact_supervisor({ reason: "interview_request", interview: { ... } })
```

The prompt preserves the strict scaffold/audit contracts. Required scaffold inputs are still validated by the parent extension and missing required inputs return an error rather than being guessed or requested through intercom. The child should use blocking supervisor contact only for rare unapproved decisions discovered after validation where proceeding would make the scaffold/audit result unsafe, misleading, or unusable. Audit mode remains strictly read-only; it should normally report decisions in the final audit report and may use only non-blocking `progress_update` for material discoveries. Scaffold mode must not write artifacts while waiting for a required supervisor decision.

When the child starts `contact_supervisor`, the parent extension parses the child JSON event and streams a wait notice that includes:

- the contact reason;
- the supervisor target;
- the child intercom session name;
- the child message; and
- the exact foreground reply instruction:

```text
/intercom-reply <your decision>
```

Do not type a normal steering message like "reply to the tool architect..." while `tool_doc_config_architect_subagent` is still running. Pi queues normal steering until the foreground tool call finishes, so it cannot unblock a child that is waiting inside `contact_supervisor`. Use `/intercom-reply ...` while the tool is running. When the parent agent is already idle, the regular tool form also works:

```typescript
intercom({ action: "reply", message: "<your decision>" })
```

Do not abort the foreground `tool_doc_config_architect_subagent` tool while a `need_decision` or `interview_request` contact is pending unless the goal is to intentionally kill the child run.

## Validation

Recommended validation after edits or reloads:

```bash
rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name" \
  /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/tool-doc-config-architect-subagent

pi --no-extensions --offline \
  -e /Users/giorgosmarinos/.pi/agent/npm/node_modules/pi-intercom \
  -e /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/tool-doc-config-architect-subagent \
  --list-models

pi --offline --list-models
```

For non-interactive behavior validation, run audit mode against a temporary project and verify no files are written. For interactive bridge validation, reload or restart Pi so the updated extension is active, then run `tool_doc_config_architect_subagent` in a safe fixture project with instructions/context that force a supervisor decision before any scaffold write. When the wait notice appears, reply immediately in the parent Pi input with:

```text
/intercom-reply Do not modify any unrelated file. This is a bridge test only; continue by reporting that contact_supervisor reply delivery worked.
```

Expected result: the slash command is handled immediately, the child receives the reply as the `contact_supervisor` result, the child completes normally, audit mode writes no files, scaffold mode writes only explicitly authorized tool artifacts, no stale ask appears after completion, and `intercom({ action: "pending" })` reports no unresolved inbound asks when checked after the run.

Lifecycle tests for timeout, abort, `progress_update`, and `interview_request` should be run when changing bridge behavior. Timeout testing can take up to the configured intercom ask timeout and may be documented as intentionally not run for quick source-only changes.

### Pi-intercom bridge validation — 2026-06-30

- Static/source validation: passed with `rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name|SUBAGENT_|--no-skills|--system-prompt" /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/tool-doc-config-architect-subagent/{index.ts,tool-doc-config-architect-agent.md,README.md}`.
- Load validation: passed with `pi --no-extensions --offline -e /Users/giorgosmarinos/.pi/agent/npm/node_modules/pi-intercom -e /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/tool-doc-config-architect-subagent --list-models`.
- Global autoload validation: passed with `pi --offline --list-models` while `/Users/giorgosmarinos/.pi/agent/extensions/tool-doc-config-architect-subagent` is a symlink to this source folder.
- Audit read-only validation: passed in temporary project `/tmp/tool-architect-audit-validation-YEjJhQ`; before/after file tree hashes matched and no files were created in the temporary project.
- Blocking `need_decision` interactive reply: not run in this API implementation session because it requires a live foreground Pi UI to type `/intercom-reply ...` while `tool_doc_config_architect_subagent` is running. Use the manual steps above after `/reload` or restart.
- Stale-message cleanup / pending empty check: not run for the same reason; verify with `intercom({ action: "pending" })` after the interactive bridge test.
- Timeout, abort, `progress_update`, and `interview_request`: not run; these are lifecycle/manual follow-up tests unless bridge behavior changes again.
- Changed files during bridge-only testing: none; only extension source/prompt/README documentation were edited during this enhancement. The audit validation wrote no files to its temporary project.

## Installation

The source folder is intended to be symlinked into Pi's user extension directory:

```bash
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/tool-doc-config-architect-subagent" \
  "$HOME/.pi/agent/extensions/tool-doc-config-architect-subagent"
```

Reload Pi after creating or updating the symlink:

```text
/reload
```

or restart Pi.

## Example Invocations

Scaffold mode:

```text
Use tool_doc_config_architect_subagent in scaffold mode with tool_name="example-cli", tool_description="Example CLI for collecting project diagnostics.", tool_command="example-cli scan", llm_required="no".
```

Audit mode:

```text
Use tool_doc_config_architect_subagent in audit mode with tool_name="example-cli" and project_root="/absolute/path/to/project".
```

LLM-enabled scaffold with extra config:

```text
Use tool_doc_config_architect_subagent in scaffold mode with tool_name="summary-tool", tool_description="Summarizes local documents using configurable LLM providers.", tool_command="summary-tool summarize", llm_required="yes", extra_config_vars=[{"name":"SUMMARY_OUTPUT_DIR","purpose":"Directory where generated summaries are written"}].
```
