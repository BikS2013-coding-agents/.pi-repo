# Plan Builder Subagent Pi Extension

This Pi extension registers the `plan_builder_subagent` tool. The tool delegates executable implementation-plan creation to an isolated child Pi process that writes a plan file under `docs/design/`.

## Files

- `index.ts` — Pi extension entrypoint.
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

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this. It runs with restricted locally available tools:

```text
read,write,grep,find,ls,bash
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
