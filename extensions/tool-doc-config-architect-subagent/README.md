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

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this. It runs with restricted locally available tools:

```text
read,write,edit,grep,find,ls,bash
```

## Modes

### Scaffold

Writes conformant artifacts for a new or partially configured tool:

- `<project_root>/docs/tools/<tool-name>.md`
- `~/.tool-agents/<tool-name>/` with mode `0700`
- `~/.tool-agents/<tool-name>/.env` with mode `0600`

It returns a report with compliance status and a recommended `CLAUDE.md` Tools section entry, but it does **not** modify `CLAUDE.md`.

### Audit

Performs a read-only conformance check and returns findings/remediation. Audit mode must not write or modify any file.

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
