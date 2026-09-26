# Test Builder Subagent Pi Extension

This Pi extension registers the `test_builder_subagent` tool. The tool delegates scoped test creation/update to an isolated child Pi process that uses the bundled `test-builder-agent.md` prompt, writes or updates only owned test files, optionally runs only the touched tests, and produces a structured markdown test-build report.

## Files

- `index.ts` — Pi extension entrypoint and child Pi launcher.
- `test-builder-agent.md` — adapted test-builder subagent prompt derived from `/Users/giorgosmarinos/aiwork/llama-cpp/test/subagent-specs/test-builder.md`.

## Tool

### `test_builder_subagent`

Parameters:

- `scope` (required): textual description of what to test. Include source file paths, symbol names, or a feature name resolvable via a codebase scan.
- `target_path` (optional): project root for the child process. Defaults to the current Pi working directory.
- `output_path` (optional): report path. Defaults to `docs/reference/test-build-<scope-slug>-<ISO-date>.md` under `target_path`.
- `codebase_scan_file` (optional): path to a codebase scan. Missing files are passed to the child as warnings to record in the report.
- `request_file` (optional): path to a refined request specification. Missing files are passed to the child as warnings to record in the report.
- `design_file` (optional): path to design documentation. Missing files are passed to the child as warnings to record in the report.
- `test_dir` (optional): preferred test directory. If omitted, the child follows the prompt's resolution rules.
- `mode` (optional): `write-and-run` (default), `write-only`, or `report-only`.
- `cwd` (optional): working directory used to resolve `target_path`.
- `model` (optional): explicit Pi model selector for the child process. Defaults to the calling agent's current model; use `same`, `current`, `caller`, `calling-agent`, or omit it to forward the caller model.

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this.

The child is launched in isolated JSON print mode with the existing appended system prompt behavior and an explicit Pi-native tool allowlist:

```text
--mode json -p --no-session --no-skills --name <child-intercom-name> --append-system-prompt test-builder-agent.md --tools read,write,edit,grep,find,ls,bash,contact_supervisor,intercom
```

Serena, CCLS, or other MCP/LSP tools are not assumed to exist. The adapted prompt instructs the child process to use local file/search/test-runner evidence and document any symbol-resolution or diagnostics limitations instead of depending on MCP/LSP tools.

## pi-intercom supervisor bridge

The launcher injects `pi-intercom` bridge metadata for every test-builder child run:

```text
PI_SUBAGENT_ORCHESTRATOR_TARGET=<parent session name or subagent-chat-<session-id-prefix>>
PI_SUBAGENT_RUN_ID=<uuid>
PI_SUBAGENT_CHILD_AGENT=test-builder
PI_SUBAGENT_CHILD_INDEX=0
PI_SUBAGENT_INTERCOM_SESSION_NAME=subagent-test-builder-<run-id>-1
```

The child `pi` process is also launched with the same stable name:

```text
--name subagent-test-builder-<run-id>-1
```

When `pi-intercom` is available in the child process and the required metadata is present, it registers the child-only `contact_supervisor` tool. The test-builder prompt allows the child to call:

```text
contact_supervisor({ reason: "need_decision", message: "..." })
contact_supervisor({ reason: "progress_update", message: "..." })
contact_supervisor({ reason: "interview_request", interview: { ... } })
```

The bridge is for genuinely blocking test-scope/ownership decisions or meaningful plan-changing updates only. It must not be used for routine completion, and it must not bypass the test-builder invariants: no production source edits, declared `test_files_owned`, no shared test infrastructure edits, scope-only test execution, report-only/write-only mode semantics, and the mandatory markdown report contract.

If the bridge is unavailable and a decision is required, the child prompt instructs the test builder to stop when blocked or record the issue in the report status, Manual Review Needed, or Implementation Gaps rather than silently choosing.

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

Use `/intercom-reply ...` while the foreground `test_builder_subagent` tool call is still running. Do **not** type a normal steering sentence such as `reply to the test-builder...`: Pi queues normal steering until the current foreground tool finishes, so it cannot unblock a child that is paused waiting for the reply.

When the parent agent is already idle, the regular tool form can also work:

```text
intercom({ action: "reply", message: "<your decision>" })
```

## Installation

The source folder is intended to be symlinked into Pi's user extension directory:

```bash
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/test-builder-extension" \
  "$HOME/.pi/agent/extensions/test-builder-extension"
```

Reload Pi after creating or updating the symlink:

```text
/reload
```

or restart Pi.

## Example Invocations

Dry plan/report only:

```text
Use test_builder_subagent with scope="Add tests for src/auth/session.ts SessionStore" and mode="report-only".
```

Write and run scoped tests:

```text
Use test_builder_subagent with scope="Test src/auth/session.ts createSession and revokeSession" and request_file="docs/reference/refined-request-auth-sessions.md".
```

## Safety Contract

The child prompt preserves these core invariants:

- No production source edits.
- No interactive user questions; supervisor coordination is only for live bridge decisions when available and necessary.
- `test_files_owned` is declared before any writes and is never expanded.
- Shared test infrastructure is not edited.
- Only touched/owned tests are executed.
- The markdown report includes mandatory YAML frontmatter for downstream aggregation.
- Unsuitable scopes are skipped with structured `skipped_*` statuses rather than fabricated tests.

No runtime dependencies are added by this extension; it uses Pi's extension API, `typebox`, and Node.js built-ins already available to Pi extensions.

## Verification

Confirm symlink resolution when installed globally:

```bash
readlink "$HOME/.pi/agent/extensions/test-builder-extension"
test -f "$HOME/.pi/agent/extensions/test-builder-extension/index.ts"
test -f "$HOME/.pi/agent/extensions/test-builder-extension/test-builder-agent.md"
```

Static/source bridge validation:

```bash
rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name|--no-skills|subagent-test-builder" \
  "$HOME/ai-coding/pi-workdocs/extensions/test-builder-extension"
```

Expected: required bridge environment variables, stable child naming, `contact_supervisor,intercom` in the tool allowlist, parent wait notice text, prompt guidance, and this README documentation are present.

Load validation with `pi-intercom` and this extension:

```bash
pi --no-extensions --offline \
  -e "$HOME/.pi/agent/npm/node_modules/pi-intercom" \
  -e "$HOME/ai-coding/pi-workdocs/extensions/test-builder-extension" \
  --list-models
```

Global autoload validation when symlinked:

```bash
pi --offline --list-models
```

Interactive bridge validation (safe, report-only):

1. Restart Pi or run `/reload` so the edited extension is active.
2. Run a safe task that uses `report-only` and forces a supervisor decision before test/report work, for example:

   ```text
   Use test_builder_subagent with scope="Bridge test for a harmless explicit file path" target_path="/path/to/safe/project" mode="report-only". Before writing any output file or making any recommendation, contact the supervisor with reason need_decision asking whether to proceed with bridge-only validation.
   ```

3. When the wait notice appears, reply in the parent Pi session while the tool is still running:

   ```text
   /intercom-reply Do not modify source or test files. This is a bridge test only; proceed only in report-only mode and report that contact_supervisor reply delivery worked.
   ```

Expected: the slash command is not queued as steering, the child receives the reply as the `contact_supervisor` result, the child completes normally, and no source/test files are modified except the explicit report file allowed by report-only mode.

Lifecycle/cleanup checks to run when practical:

- Confirm no stale ask renders after completion.
- When idle, `intercom({ action: "pending" })` should report no unresolved inbound asks.
- Timeout and abort paths should report a clear blocker and should not leave persistent pending asks.
- `progress_update` should be non-blocking and should not create a pending ask.
- `interview_request` should block and receive the raw `/intercom-reply` payload.

## Validation evidence

Pi-intercom bridge validation — 2026-06-30

- Static/source validation: passed with `rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name|--no-skills|subagent-test-builder" /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/test-builder-extension`; required bridge variables, tool allowlist, wait-notice parsing, prompt guidance, and README documentation were present.
- Symlink validation: passed; `~/.pi/agent/extensions/test-builder-extension` resolves to this source folder and required source/prompt files exist.
- Load validation: passed with `pi --no-extensions --offline -e "$HOME/.pi/agent/npm/node_modules/pi-intercom" -e "$HOME/ai-coding/pi-workdocs/extensions/test-builder-extension" --list-models`.
- Global autoload validation: passed with `pi --offline --list-models`.
- Blocking `need_decision` reply: not run in this non-interactive edit session; requires a foreground interactive Pi session after `/reload` so the supervisor can type `/intercom-reply ...` while the tool is running.
- Stale message cleanup: not run; requires a successful blocking reply validation first.
- Timeout/abort behavior: intentionally not run by default because timeout can take up to the configured ask timeout and abort testing intentionally kills the child.
- Progress update: not run; documented as a manual validation step above.
- Interview request: not run; documented as a manual validation step above.
- Changed files during bridge-only test: none; no bridge-only child execution was performed in this session.
