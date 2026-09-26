# Dependency Validator Subagent Pi Extension

This Pi extension registers the `dependency_validator_subagent` tool. The tool launches an isolated child `pi` process with the dependency-validator agent prompt, validates dependency hygiene for a target project, and writes the structured markdown report required by the agent specification.

## Files

- `index.ts` — Pi extension entrypoint and child Pi launcher.
- `dependency-validator-agent.md` — adapted Pi subagent prompt derived from `/Users/giorgosmarinos/aiwork/llama-cpp/test/subagent-specs/dependency-validator.md`.

## Tool

### `dependency_validator_subagent`

Parameters:

- `target_path` (optional): absolute or cwd-relative project path. Defaults to current Pi working directory.
- `output_path` (optional): absolute or `target_path`-relative report path. Defaults to `target_path/docs/reference/dependency-validation-<ISO-timestamp>.md`.
- `request_file` (optional): absolute or `target_path`-relative refined-request file for context.
- `mode` (optional): `report-only`, `fix`, or `interactive`. Defaults to `fix`.
- `max_iterations` (optional): hard cap on validate/fix loops. Defaults to `5`.
- `include_security_audit` (optional): include supported security audit commands. Defaults to `true`.
- `model` (optional): explicit Pi model selector for the child process. Defaults to the calling agent's current model; use `same`, `current`, `caller`, `calling-agent`, or omit it to forward the caller model.

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this.

The child process is launched in isolated JSON print mode with:

```text
--mode json -p --no-session --no-skills --name <child-intercom-name> --system-prompt dependency-validator-agent.md --tools read,write,edit,grep,find,ls,bash,contact_supervisor,intercom
```

## pi-intercom supervisor bridge

The launcher injects `pi-intercom` bridge metadata for every dependency-validator child run:

```text
PI_SUBAGENT_ORCHESTRATOR_TARGET=<parent session name or subagent-chat-<session-id-prefix>>
PI_SUBAGENT_RUN_ID=<uuid>
PI_SUBAGENT_CHILD_AGENT=dependency-validator
PI_SUBAGENT_CHILD_INDEX=0
PI_SUBAGENT_INTERCOM_SESSION_NAME=subagent-dependency-validator-<run-id>-1
```

The child `pi` process is also launched with the same stable name:

```text
--name subagent-dependency-validator-<run-id>-1
```

When `pi-intercom` is available in the child process and the required metadata is present, it registers the child-only `contact_supervisor` tool. The dependency-validator prompt allows the child to call:

```text
contact_supervisor({ reason: "need_decision", message: "..." })
contact_supervisor({ reason: "progress_update", message: "..." })
contact_supervisor({ reason: "interview_request", interview: { ... } })
```

The bridge is for genuinely blocking or meaningful plan-changing coordination only. It must not be used for routine completion, and it must not bypass the dependency-validator safety invariants: report-only remains read-only, major-version migrations are not silently applied, transitive dependencies are not edited directly, and the markdown report contract remains mandatory.

`interactive` mode remains a non-blocking plan/report mode by default. It writes the planned unapplied replacements and returns the report to the caller; it does not proactively become an approval chat unless a separate unexpected blocker requires a supervisor decision.

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

Use `/intercom-reply ...` while the foreground `dependency_validator_subagent` tool call is still running. Do **not** type a normal steering sentence such as `reply to the dependency-validator...`: Pi queues normal steering until the current foreground tool finishes, so it cannot unblock a child that is paused waiting for the reply.

When the parent agent is already idle, the regular tool form can also work:

```text
intercom({ action: "reply", message: "<your decision>" })
```

## Installation / Symlinks

The source folder is intended to be symlinked into Pi's user extension directory:

```bash
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/dependency-validator-subagent" \
  "$HOME/.pi/agent/extensions/dependency-validator-subagent"
```

The adapted agent definition is also symlinked into Pi's user agent directory so generic subagent runners can discover it by name:

```bash
mkdir -p "$HOME/.pi/agent/agents"
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/dependency-validator-subagent/dependency-validator-agent.md" \
  "$HOME/.pi/agent/agents/dependency-validator.md"
```

Reload Pi after creating or updating the symlinks:

```text
/reload
```

or restart Pi.

## Example Invocation

Report-only check:

```text
Use dependency_validator_subagent with target_path: "/path/to/project", mode: "report-only".
```

Interactive fix plan without applying changes:

```text
Use dependency_validator_subagent with target_path: "/path/to/project", mode: "interactive".
```

Generic subagent runner invocation, if the `subagent` tool is available:

```text
Use subagent with agent: "dependency-validator" and task: "Run dependency validation for /path/to/project in report-only mode."
```

## Verification

Confirm symlinks resolve:

```bash
readlink "$HOME/.pi/agent/extensions/dependency-validator-subagent"
readlink "$HOME/.pi/agent/agents/dependency-validator.md"
test -f "$HOME/.pi/agent/extensions/dependency-validator-subagent/index.ts"
test -f "$HOME/.pi/agent/agents/dependency-validator.md"
```

Static/source bridge validation:

```bash
rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name|--no-skills" \
  "$HOME/ai-coding/pi-workdocs/extensions/dependency-validator-subagent"
```

Expected: required bridge environment variables, stable child naming, `contact_supervisor,intercom` in the tool allowlist, parent wait notice text, prompt guidance, and this README documentation are present.

Load validation with `pi-intercom` and this extension:

```bash
pi --no-extensions --offline \
  -e "$HOME/.pi/agent/npm/node_modules/pi-intercom" \
  -e "$HOME/ai-coding/pi-workdocs/extensions/dependency-validator-subagent" \
  --list-models
```

Global autoload validation when symlinked:

```bash
pi --offline --list-models
```

Interactive bridge validation (safe, bridge-only):

1. Restart Pi or run `/reload` so the edited extension is active.
2. Run a safe task that forbids edits and forces a supervisor decision before dependency work, for example:

   ```text
   Use dependency_validator_subagent in report-only mode for a safe test project. Before writing any output file or making any recommendation, contact the supervisor with reason need_decision asking whether to proceed with bridge-only validation. Do not modify project files except the explicit report path.
   ```

3. When the wait notice appears, reply in the parent Pi session while the tool is still running:

   ```text
   /intercom-reply Do not modify any dependency files. This is a bridge test only; report that contact_supervisor reply delivery worked.
   ```

Expected: the slash command is not queued as steering, the child receives the reply as the `contact_supervisor` result, the child completes normally, and no project files are modified unless explicitly authorized.

Lifecycle/cleanup checks to run when practical:

- Confirm no stale ask renders after completion.
- When idle, `intercom({ action: "pending" })` should report no unresolved inbound asks.
- Timeout and abort paths should report a clear blocker and should not leave persistent pending asks.
- `progress_update` should be non-blocking and should not create a pending ask.
- `interview_request` should block and receive the raw `/intercom-reply` payload.

## Validation evidence

Pi-intercom bridge validation — 2026-06-30

- Static/source validation: passed with `rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name|--no-skills" /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/dependency-validator-subagent`; required bridge variables, tool allowlist, wait-notice parsing, prompt guidance, and README documentation were present.
- Symlink validation: passed; `~/.pi/agent/extensions/dependency-validator-subagent` and `~/.pi/agent/agents/dependency-validator.md` resolve to this source folder/prompt.
- Load validation: passed with `pi --no-extensions --offline -e "$HOME/.pi/agent/npm/node_modules/pi-intercom" -e "$HOME/ai-coding/pi-workdocs/extensions/dependency-validator-subagent" --list-models`.
- Global autoload validation: passed with `pi --offline --list-models`.
- Blocking `need_decision` reply: not run in this non-interactive edit session; requires a foreground interactive Pi session after `/reload` so the supervisor can type `/intercom-reply ...` while the tool is running.
- Stale message cleanup: not run; requires a successful blocking reply validation first.
- Timeout/abort behavior: intentionally not run by default because timeout can take up to the configured ask timeout and abort testing intentionally kills the child.
- Progress update: not run; documented as a manual validation step above.
- Interview request: not run; documented as a manual validation step above.
- Changed files during bridge-only test: none; no bridge-only child execution was performed in this session.
