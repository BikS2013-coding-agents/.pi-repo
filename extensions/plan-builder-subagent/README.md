# Plan Builder Subagent Pi Extension

This Pi extension registers the `plan_builder_subagent` tool. The tool delegates executable implementation-plan creation to an isolated child Pi process that writes a plan file under `docs/design/`.

## Files

- `index.ts` — Pi extension entrypoint and child Pi launcher.
- `plan-builder-agent.md` — adapted plan-builder subagent prompt derived from `/Users/giorgosmarinos/aiwork/llama-cpp/test/subagent-specs/plan-builder.md`.

## Tool

### `plan_builder_subagent`

Parameters:

- `request_file` (required): absolute or cwd-relative path to the refined request specification. Must exist.
- `investigation_file` (optional): absolute or cwd-relative path to an investigation document. Must exist if supplied.
- `research_files` (optional): array of absolute or cwd-relative paths to technical research documents. Every supplied file must exist.
- `codebase_scan_file` (optional): absolute or cwd-relative path to a codebase scan document. Must exist if supplied.
- `design_file` (optional): absolute or cwd-relative path to project design documentation. Must exist if supplied.
- `output_path` (optional): absolute or cwd-relative path for the plan output. Defaults to `docs/design/plan-NNN-<slug>.md` under `cwd`.
- `output_slug` (optional): lowercase hyphenated slug used when `output_path` is omitted.
- `duplication_directive` (optional): binding instruction from duplication analysis.
- `original_request` (optional): raw user request text used as a drift guard.
- `cwd` (optional): project root / working directory for the child plan-builder process. Defaults to the current Pi working directory.
- `model` (optional): explicit Pi model selector for the child process. Defaults to the calling agent's current model; use `same`, `current`, `caller`, `calling-agent`, or omit it to forward the caller model.

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this.

The child process is launched in isolated JSON print mode with restricted locally available tools plus the supervisor bridge tools:

```text
--mode json -p --no-session --no-skills --name <child-intercom-name> --system-prompt plan-builder-agent.md --tools read,write,grep,find,ls,bash,contact_supervisor,intercom
```

Serena MCP tools are not assumed to exist. If unavailable, the child planner is instructed to use local file/search tools and document any verification limitations.

## Output

The child subagent writes one implementation plan with mandatory YAML frontmatter and sections including:

- Objective
- Context
- Open Questions
- Steps
- Implementation Units
- Risks & Mitigations
- Acceptance Criteria Mapping
- Deviation Rules for Executors
- Verification

Default output path:

```text
<cwd>/docs/design/plan-NNN-<slug>.md
```

`NNN` is resolved to the next sequential plan number by scanning existing `docs/design/plan-*.md` files. If `output_path` contains a literal `NNN`, the extension resolves it before launching the child process.

## pi-intercom supervisor bridge

The launcher injects `pi-intercom` bridge metadata for every plan-builder child run:

```text
PI_SUBAGENT_ORCHESTRATOR_TARGET=<parent session name or subagent-chat-<session-id-prefix>>
PI_SUBAGENT_RUN_ID=<uuid>
PI_SUBAGENT_CHILD_AGENT=plan-builder
PI_SUBAGENT_CHILD_INDEX=0
PI_SUBAGENT_INTERCOM_SESSION_NAME=subagent-plan-builder-<run-id>-1
```

The child `pi` process is also launched with the same stable name:

```text
--name subagent-plan-builder-<run-id>-1
```

When `pi-intercom` is available in the child process and the required metadata is present, it registers the child-only `contact_supervisor` tool. The plan-builder prompt allows the child to call:

```text
contact_supervisor({ reason: "need_decision", message: "..." })
contact_supervisor({ reason: "progress_update", message: "..." })
contact_supervisor({ reason: "interview_request", interview: { ... } })
```

The bridge is for genuinely blocking planning decisions or meaningful plan-changing updates only. It must not be used for routine completion, and it must not bypass the plan-builder invariants: `request_file` remains authoritative, the plan file structure/frontmatter remains mandatory, source files must not be modified, and only the plan file plus project-functions file may be written.

If the bridge is unavailable and a decision is required, the child prompt instructs the planner to stop when blocked or record the decision as an Open Question with a recommended default rather than silently choosing.

## Parent wait notice and reply rule

When the child starts `contact_supervisor`, `index.ts` parses the child JSON event:

```text
event.type === "tool_execution_start" && event.toolName === "contact_supervisor"
```

The parent-visible update includes:

- the contact reason,
- the supervisor target,
- the child intercom session name,
- the child message,
- and the immediate foreground reply instruction:

```text
/intercom-reply <your decision>
```

Use `/intercom-reply ...` while the foreground `plan_builder_subagent` tool call is still running. Do **not** type a normal steering sentence such as `reply to the plan-builder...`: Pi queues normal steering until the current foreground tool finishes, so it cannot unblock a child that is paused waiting for the reply.

When the parent agent is already idle, the regular tool form can also work:

```text
intercom({ action: "reply", message: "<your decision>" })
```

## Installation

The source folder is intended to be symlinked into Pi's user extension directory:

```bash
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/plan-builder-subagent" \
  "$HOME/.pi/agent/extensions/plan-builder-subagent"
```

Reload Pi after creating or updating the symlink:

```text
/reload
```

or restart Pi.

## Example Invocations

Basic plan:

```text
Use plan_builder_subagent with request_file=/absolute/path/to/docs/reference/refined-request-my-feature.md.
```

Plan with context artifacts:

```text
Use plan_builder_subagent with request_file=/absolute/path/to/refined-request-my-feature.md, investigation_file=/absolute/path/to/investigation-my-feature.md, codebase_scan_file=/absolute/path/to/codebase-scan-my-feature.md, and research_files=["/absolute/path/to/docs/research/my-library.md"].
```

Explicit output slug:

```text
Use plan_builder_subagent with request_file=/absolute/path/to/refined-request-my-feature.md and output_slug="my-feature".
```

## Verification

Confirm symlink resolution when installed globally:

```bash
readlink "$HOME/.pi/agent/extensions/plan-builder-subagent"
test -f "$HOME/.pi/agent/extensions/plan-builder-subagent/index.ts"
test -f "$HOME/.pi/agent/extensions/plan-builder-subagent/plan-builder-agent.md"
```

Static/source bridge validation:

```bash
rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name|--no-skills" \
  "$HOME/ai-coding/pi-workdocs/extensions/plan-builder-subagent"
```

Expected: required bridge environment variables, stable child naming, `contact_supervisor,intercom` in the tool allowlist, parent wait notice text, prompt guidance, and this README documentation are present.

Load validation with `pi-intercom` and this extension:

```bash
pi --no-extensions --offline \
  -e "$HOME/.pi/agent/npm/node_modules/pi-intercom" \
  -e "$HOME/ai-coding/pi-workdocs/extensions/plan-builder-subagent" \
  --list-models
```

Global autoload validation when symlinked:

```bash
pi --offline --list-models
```

Interactive bridge validation (safe, planning-only):

1. Restart Pi or run `/reload` so the edited extension is active.
2. Run a safe task that uses a throwaway refined request and forces a supervisor decision before writing the plan, for example:

   ```text
   Use plan_builder_subagent with request_file="/path/to/safe/refined-request.md" and output_path="docs/design/plan-NNN-bridge-test.md". Before writing any output file or making any recommendation, contact the supervisor with reason need_decision asking whether to proceed with bridge-only validation.
   ```

3. When the wait notice appears, reply in the parent Pi session while the tool is still running:

   ```text
   /intercom-reply Do not modify source files. This is a bridge test only; proceed only if you can write the requested plan safely and report that contact_supervisor reply delivery worked.
   ```

Expected: the slash command is not queued as steering, the child receives the reply as the `contact_supervisor` result, the child completes normally, and no source files are modified.

Lifecycle/cleanup checks to run when practical:

- Confirm no stale ask renders after completion.
- When idle, `intercom({ action: "pending" })` should report no unresolved inbound asks.
- Timeout and abort paths should report a clear blocker and should not leave persistent pending asks.
- `progress_update` should be non-blocking and should not create a pending ask.
- `interview_request` should block and receive the raw `/intercom-reply` payload.

## Validation evidence

Pi-intercom bridge validation — 2026-06-30

- Static/source validation: passed with `rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name|--no-skills|subagent-plan-builder" /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/plan-builder-subagent`; required bridge variables, tool allowlist, wait-notice parsing, prompt guidance, and README documentation were present.
- Symlink validation: passed; `~/.pi/agent/extensions/plan-builder-subagent` resolves to this source folder and required source/prompt files exist.
- Load validation: passed with `pi --no-extensions --offline -e "$HOME/.pi/agent/npm/node_modules/pi-intercom" -e "$HOME/ai-coding/pi-workdocs/extensions/plan-builder-subagent" --list-models`.
- Global autoload validation: passed with `pi --offline --list-models`.
- Blocking `need_decision` reply: not run in this non-interactive edit session; requires a foreground interactive Pi session after `/reload` so the supervisor can type `/intercom-reply ...` while the tool is running.
- Stale message cleanup: not run; requires a successful blocking reply validation first.
- Timeout/abort behavior: intentionally not run by default because timeout can take up to the configured ask timeout and abort testing intentionally kills the child.
- Progress update: not run; documented as a manual validation step above.
- Interview request: not run; documented as a manual validation step above.
- Changed files during bridge-only test: none; no bridge-only child execution was performed in this session.
