# Technical Researcher Subagent Pi Extension

This Pi extension registers the `technical_researcher_subagent` tool. The tool delegates implementation-level technical research to an isolated child Pi process that writes comprehensive markdown documentation under `docs/research/`.

## Files

- `index.ts` — Pi extension entrypoint and child process launcher.
- `technical-researcher-agent.md` — adapted technical researcher subagent prompt derived from `/Users/giorgosmarinos/aiwork/llama-cpp/test/subagent-specs/technical-researcher.md`.

## Tool

### `technical_researcher_subagent`

Parameters:

- `topic` (required): exact technology, library, API, SDK, protocol, platform, framework, or implementation pattern to research.
- `why_needed` (optional): what decision or implementation detail depends on this research.
- `focus_areas` (optional): array of specific aspects to investigate, such as APIs, setup, configuration, security, testing, error handling, or examples.
- `depth_level` (optional): `Overview`, `Intermediate`, or `Deep dive`; defaults to `Intermediate` in the child prompt.
- `investigation_file` (optional): absolute or cwd-relative path to the investigation document that identified this topic. If supplied, it must exist.
- `output_path` (optional): absolute or cwd-relative path for the research markdown output. Defaults to `docs/research/<topic-slug>.md` under `cwd`.
- `cwd` (optional): project root / working directory for the child technical researcher process. Defaults to the current Pi working directory.
- `model` (optional): explicit Pi model selector for the child process. Defaults to the calling agent's current model; use `same`, `current`, `caller`, `calling-agent`, or omit it to forward the caller model.

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this.

## Child Process Launch

The technical researcher child is launched as a bounded Pi subprocess with JSON output:

```text
pi --mode json -p --no-session --no-skills \
  --tools read,write,grep,find,ls,bash,contact_supervisor,intercom \
  --append-system-prompt <technical-researcher-agent.md> \
  --name <child-intercom-session-name> \
  <task>
```

The technical researcher is read-only for project/source code. The `write` tool is retained only so the child can create the configured research artifact at `output_path` and any required parent directories.

External web/search/Context7/MCP tools are not assumed to exist. If unavailable, the child technical researcher is instructed to document that limitation rather than fabricate sources or claims.

## Output

The child subagent writes a research document with sections such as:

- Overview
- Research Scope
- Key Concepts
- Installation / Setup
- Configuration
- Core Features / APIs
- Usage Examples
- Error Handling and Edge Cases
- Security Considerations
- Testing Guidance
- Best Practices
- Common Pitfalls
- Project Integration Notes
- Assumptions & Scope
- Uncertainties & Gaps
- Clarifying Questions for Follow-up
- References

## Pi Intercom Supervisor Bridge

The extension follows the reusable subagent bridge pattern in `/Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/pi-intercom-subagent-integration-instructions.md`.

### Injected bridge environment variables

For each child run, `index.ts` injects:

```text
PI_SUBAGENT_ORCHESTRATOR_TARGET=<parent session name or subagent-chat-<session-id-prefix>>
PI_SUBAGENT_RUN_ID=<uuid>
PI_SUBAGENT_CHILD_AGENT=technical-researcher
PI_SUBAGENT_CHILD_INDEX=0
PI_SUBAGENT_INTERCOM_SESSION_NAME=<stable child intercom name>
```

`pi-intercom` uses this metadata to expose the child-only `contact_supervisor` tool.

### Intercom naming

- Parent/supervisor target: the parent Pi session name when set; otherwise `subagent-chat-<first-8-chars-of-session-id-without-session-prefix>`.
- Child session name: `subagent-technical-researcher-<run-id>-1` after sanitization.

The child launch includes `--name <child session name>` so `/intercom-reply` and other intercom routing can address the child reliably.

### Tool allowlist additions

The technical researcher's original local tool set is preserved and extended with intercom tools:

```text
read,write,grep,find,ls,bash,contact_supervisor,intercom
```

The child prompt instructs the technical researcher to use `contact_supervisor` only for new unapproved decisions, structured blocking interviews, or meaningful non-blocking plan-changing progress updates, not routine completion handoffs.

## Parent Wait Notice

When the child emits a JSON event like:

```json
{"type":"tool_execution_start","toolName":"contact_supervisor","args":{"reason":"need_decision","message":"Which API version should this research prioritize?"}}
```

`index.ts` streams a parent-visible wait notice containing:

- the `contact_supervisor` reason;
- the child message;
- the resolved supervisor target;
- the child intercom session name;
- the exact foreground reply instruction:

```text
/intercom-reply <your decision>
```

The notice also warns that normal steering cannot unblock a foreground subagent tool. Do **not** type a normal message such as `reply to the technical researcher...` while the `technical_researcher_subagent` tool is still running; Pi queues normal steering until the foreground tool returns, so it cannot unblock the child. If the parent agent is already idle, the regular tool form also works:

```typescript
intercom({ action: "reply", message: "<your decision>" })
```

The parent also surfaces concise evidence when the `contact_supervisor` tool result is observed, without dumping unrelated child JSON.

## Installation

The source folder is intended to be symlinked into Pi's user extension directory:

```bash
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/technical-researcher-subagent" \
  "$HOME/.pi/agent/extensions/technical-researcher-subagent"
```

Reload Pi after creating or updating the symlink:

```text
/reload
```

or restart Pi.

## Example Invocations

General technical research:

```text
Use technical_researcher_subagent to research "FastAPI dependency injection" with depth_level="Intermediate".
```

Investigation-guided technical research:

```text
Use technical_researcher_subagent with topic="Server-Sent Events", investigation_file=/absolute/path/to/docs/reference/investigation-realtime-notifications.md, focus_areas=["streaming API", "error recovery", "testing"].
```

Explicit output path:

```text
Use technical_researcher_subagent with topic="JWT validation with jose" and output_path=/absolute/path/to/docs/research/jose-jwt-validation.md.
```

## Validation

### Static/source validation

Run:

```bash
rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name|--no-skills" \
  /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/technical-researcher-subagent
```

Expected: matches in `index.ts`, `technical-researcher-agent.md`, and this README for bridge env vars, stable child name, tool allowlist additions, parent wait notice, and child prompt guidance.

### Load validation

Validate the extension loads together with `pi-intercom`:

```bash
pi --no-extensions --offline \
  -e /Users/giorgosmarinos/.pi/agent/npm/node_modules/pi-intercom \
  -e /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/technical-researcher-subagent \
  --list-models
```

Also validate global autoload after the symlink is present:

```bash
pi --offline --list-models
```

Expected: exit code `0` with no TypeScript import/runtime or extension registration errors.

### Interactive bridge validation

1. Restart Pi or run `/reload` so the updated extension is active.
2. Confirm startup lists both `pi-intercom` and `technical-researcher-subagent` under extensions.
3. Run a safe dry-run task that forces a supervisor decision before writing the output, for example:

```text
Use technical_researcher_subagent with cwd=/Users/giorgosmarinos/aiwork/llama-cpp, output_path=/Users/giorgosmarinos/aiwork/llama-cpp/docs/research/technical-researcher-intercom-bridge-test.md, topic="Technical researcher bridge validation", why_needed="Bridge validation only", focus_areas=["supervisor reply delivery"], and depth_level="Overview". Before writing any output file or making any recommendation, contact the supervisor with reason need_decision asking whether to proceed with the dry-run research output. Do not modify source files.
```

4. When the wait notice appears, reply from the parent Pi session with:

```text
/intercom-reply Do not modify any source file. This is a bridge test only; write only the configured research output if needed and report that contact_supervisor reply delivery worked.
```

Expected: the slash command executes immediately while the foreground subagent tool is running, the child receives the reply, and the child completes normally. No source files are modified.

### Lifecycle/cleanup checks

After an interactive bridge test, wait briefly and then check pending asks from an idle parent session:

```typescript
intercom({ action: "pending" })
```

Expected: no unresolved inbound asks. Timeout and abort paths should be tested sparingly because blocking asks may wait for the configured `pi-intercom` timeout (commonly 10 minutes); if not tested, document that explicitly in the validation note.

## Validation Evidence

Pi-intercom bridge validation — 2026-06-30

- Static source validation: passed with `rg -n "PI_SUBAGENT_|contact_supervisor|intercom-reply|tool_execution_start|--name|--no-skills" /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/technical-researcher-subagent`.
- Load validation with explicit `pi-intercom` and this extension: passed with `pi --no-extensions --offline -e /Users/giorgosmarinos/.pi/agent/npm/node_modules/pi-intercom -e /Users/giorgosmarinos/ai-coding/pi-workdocs/extensions/technical-researcher-subagent --list-models`.
- Global autoload validation: passed with `pi --offline --list-models`.
- Blocking `need_decision` reply via `/intercom-reply`: pending manual interactive validation in a live foreground Pi session.
- Stale message cleanup / pending empty: pending manual interactive validation in a live foreground Pi session.
- Normal technical research behavior: pending optional live subagent execution after `/reload` or Pi restart.
- Timeout/abort behavior: not tested yet; intentionally deferred unless a controlled long-running validation pass is requested.
- Progress update: not tested yet.
- Interview request: not tested yet; supported by prompt guidance but not typical for normal technical research usage.
- Changed files during bridge-only test: pending manual interactive validation.
