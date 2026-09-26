# Design Builder Subagent Pi Extension

This Pi extension registers the `design_builder_subagent` tool. The tool delegates technical-design creation to an isolated child Pi process that writes a per-request design file under `docs/design/` and updates the living `docs/design/project-design.md` document.

## Files

- `index.ts` — Pi extension entrypoint.
- `design-builder-agent.md` — adapted design-builder subagent prompt derived from `/Users/giorgosmarinos/aiwork/llama-cpp/test/subagent-specs/design-builder.md`.

## Tool

### `design_builder_subagent`

Parameters:

- `request_file` (required): absolute or cwd-relative path to the refined request specification. Must exist.
- `plan_file` (required): absolute or cwd-relative path to the implementation plan. Must exist.
- `investigation_file` (optional): absolute or cwd-relative path to an investigation document. Must exist if supplied.
- `research_files` (optional): array of absolute or cwd-relative paths to technical research documents. Every supplied file must exist.
- `codebase_scan_file` (optional): absolute or cwd-relative path to a codebase scan document. Must exist if supplied.
- `project_design_file` (optional): absolute or cwd-relative path to the living project design document. Defaults to `docs/design/project-design.md` under `cwd`; the child subagent may create it.
- `output_path` (optional): absolute or cwd-relative path for the per-request design output. Defaults to `docs/design/design-NNN-<slug>.md` under `cwd`.
- `output_slug` (optional): slug used when `output_path` is omitted. Overrides the plan slug for the output filename.
- `integration_directive` (optional): binding orchestrator instruction from duplication/integration analysis.
- `resolved_open_questions` (optional): binding record of user answers to the plan's open questions.
- `original_request` (optional): raw user request text used as a drift guard.
- `cwd` (optional): project root / working directory for the child design-builder process. Defaults to the current Pi working directory.
- `model` (optional): explicit Pi model selector for the child process. Defaults to the calling agent's current model; use `same`, `current`, `caller`, `calling-agent`, or omit it to forward the caller model.

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this. It runs in JSON print mode with an isolated prompt and restricted locally available tools:

```text
--no-session --no-skills --name <child-intercom-name> --system-prompt design-builder-agent.md --tools read,write,grep,find,ls,bash,contact_supervisor,intercom
```

Serena MCP tools are not assumed to exist in the child process. The adapted prompt instructs the child to use local read/search tools and document symbol-verification limitations when Serena is unavailable. The `contact_supervisor` and `intercom` tools are included so the child can coordinate with the parent supervisor when the `pi-intercom` extension is installed and active.

## Output

The child subagent writes:

1. One per-request design file with mandatory YAML frontmatter and sections including:
   - Objective
   - Architecture
   - Data Models
   - API & Interface Contracts
   - Module Organization
   - Error Handling Strategy
   - Implementation Units
   - Design Decisions
   - Decisions Requiring User Review
   - Risks
2. A dated provenance/decision section appended to the living project design document.

Default output path:

```text
<cwd>/docs/design/design-NNN-<slug>.md
```

`NNN` and `<slug>` are resolved from the supplied plan frontmatter (`plan_number` and `slug`) when available. If plan metadata is unavailable, `NNN` falls back to the next sequential `design-*.md` number and the slug falls back to the refined-request filename or `output_slug`.

If `output_path` contains a literal `NNN`, the extension resolves it before launching the child process.

## pi-intercom supervisor bridge

The extension injects the reusable `pi-intercom` subagent bridge metadata into every child design-builder run:

```text
PI_SUBAGENT_ORCHESTRATOR_TARGET=<parent session name or subagent-chat-<session-id-prefix>>
PI_SUBAGENT_RUN_ID=<uuid>
PI_SUBAGENT_CHILD_AGENT=design-builder
PI_SUBAGENT_CHILD_INDEX=0
PI_SUBAGENT_INTERCOM_SESSION_NAME=subagent-design-builder-<run-id>-1
```

The child Pi process is also launched with the matching stable name:

```text
--name subagent-design-builder-<run-id>-1
```

If `pi-intercom` is installed and loaded in the child process, it sees the bridge metadata and registers the child-only `contact_supervisor` tool. The design builder can then call:

```text
contact_supervisor({ reason: "need_decision", message: "..." })
contact_supervisor({ reason: "progress_update", message: "..." })
contact_supervisor({ reason: "interview_request", interview: { ... } })
```

The design-builder prompt preserves the normal design-review workflow: routine choices still go into `Decisions Requiring User Review` and the final report. The child should use blocking supervisor contact only when a new unapproved decision must be resolved before accurate design artifacts can be written. It must not modify design artifacts while waiting for a decision that affects their content. If `contact_supervisor` is unavailable and such a decision is truly blocking, the child should stop and report the blocker instead of silently choosing.

When the child starts `contact_supervisor`, the parent extension parses the child JSON event and streams a wait notice that includes:

- the contact reason;
- the supervisor target;
- the child intercom session name;
- the child message; and
- the exact foreground reply instruction:

```text
/intercom-reply <your decision>
```

Do not type a normal steering message like "reply to the design builder..." while `design_builder_subagent` is still running. Pi queues normal steering until the foreground tool call finishes, so it cannot unblock a child that is waiting inside `contact_supervisor`. Use `/intercom-reply ...` while the tool is running. When the parent agent is already idle, the regular tool form also works:

```typescript
intercom({ action: "reply", message: "<your decision>" })
```

Do not abort the foreground `design_builder_subagent` tool while a `need_decision` or `interview_request` contact is pending unless the goal is to intentionally kill the child run.

## Validation

Recommended validation after edits or reloads:

```bash
rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name" \
  /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/design-builder-subagent

pi --no-extensions --offline \
  -e /Users/giorgosmarinos/.pi/agent/npm/node_modules/pi-intercom \
  -e /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/design-builder-subagent \
  --list-models

pi --offline --list-models
```

For interactive bridge validation, reload or restart Pi so the updated extension is active. Run `design_builder_subagent` in a safe fixture project with request/plan files and instructions that force the child to ask for supervisor approval before writing artifacts. When the wait notice appears, reply immediately in the parent Pi input with:

```text
/intercom-reply Do not modify any file. This is a bridge test only; report that contact_supervisor reply delivery worked.
```

Expected result: the slash command is handled immediately, the child receives the reply as the `contact_supervisor` result, the child completes normally, no files are modified unless explicitly authorized, no stale ask appears after completion, and `intercom({ action: "pending" })` reports no unresolved inbound asks when checked after the run.

Lifecycle tests for timeout, abort, `progress_update`, and `interview_request` should be run when changing bridge behavior. Timeout testing can take up to the configured intercom ask timeout and may be documented as intentionally not run for quick source-only changes.

### Pi-intercom bridge validation — 2026-06-30

- Static/source validation: passed with `rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name|SUBAGENT_|--no-skills|--system-prompt" /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/design-builder-subagent/{index.ts,design-builder-agent.md,README.md}`.
- Load validation: passed with `pi --no-extensions --offline -e /Users/giorgosmarinos/.pi/agent/npm/node_modules/pi-intercom -e /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/design-builder-subagent --list-models`.
- Global autoload validation: passed with `pi --offline --list-models` while `/Users/giorgosmarinos/.pi/agent/extensions/design-builder-subagent` is a symlink to this source folder.
- Blocking `need_decision` interactive reply: not run in this API implementation session because it requires a live foreground Pi UI to type `/intercom-reply ...` while `design_builder_subagent` is running. Use the manual steps above after `/reload` or restart.
- Stale-message cleanup / pending empty check: not run for the same reason; verify with `intercom({ action: "pending" })` after the interactive bridge test.
- Timeout, abort, `progress_update`, and `interview_request`: not run; these are lifecycle/manual follow-up tests unless bridge behavior changes again.
- Changed files during bridge-only testing: none; only extension source/prompt/README documentation were edited during this enhancement.

## Installation

The source folder is intended to be symlinked into Pi's user extension directory:

```bash
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/design-builder-subagent" \
  "$HOME/.pi/agent/extensions/design-builder-subagent"
```

Reload Pi after creating or updating the symlink:

```text
/reload
```

or restart Pi.

## Example Invocations

Basic design:

```text
Use design_builder_subagent with request_file=/absolute/path/to/docs/reference/refined-request-my-feature.md and plan_file=/absolute/path/to/docs/design/plan-001-my-feature.md.
```

Design with context artifacts:

```text
Use design_builder_subagent with request_file=/absolute/path/to/refined-request-my-feature.md, plan_file=/absolute/path/to/plan-001-my-feature.md, investigation_file=/absolute/path/to/investigation-my-feature.md, codebase_scan_file=/absolute/path/to/codebase-scan-my-feature.md, and research_files=["/absolute/path/to/docs/research/my-library.md"].
```

Explicit output path and project design file:

```text
Use design_builder_subagent with request_file=/absolute/path/to/refined-request-my-feature.md, plan_file=/absolute/path/to/plan-001-my-feature.md, output_path=/absolute/path/to/docs/design/design-NNN-my-feature.md, and project_design_file=/absolute/path/to/docs/design/project-design.md.
```
