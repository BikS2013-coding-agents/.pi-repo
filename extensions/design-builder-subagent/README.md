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

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this. It runs with restricted locally available tools:

```text
read,write,grep,find,ls,bash
```

Serena MCP tools are not assumed to exist in the child process. The adapted prompt instructs the child to use local read/search tools and document symbol-verification limitations when Serena is unavailable.

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
