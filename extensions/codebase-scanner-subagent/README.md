# Codebase Scanner Subagent Pi Extension

This Pi extension registers the `codebase_scanner_subagent` tool. The tool delegates codebase scanning to an isolated child Pi process that writes a concise markdown codebase overview with YAML frontmatter metadata, module map, conventions, and optional request-specific integration points.

## Files

- `index.ts` — Pi extension entrypoint.
- `codebase-scanner-agent.md` — adapted codebase-scanner subagent prompt derived from `/Users/giorgosmarinos/aiwork/llama-cpp/test/subagent-specs/codebase-scanner.md`.

## Tool

### `codebase_scanner_subagent`

Parameters:

- `request_file` (optional): absolute or cwd-relative path to a refined request specification. If supplied, it must exist.
- `output_path` (optional): absolute or cwd-relative path for the scan markdown output. Defaults to `docs/reference/codebase-scan-<slug>.md` under `cwd`.
- `cwd` (optional): project root / working directory for the child scanner process. Defaults to the current Pi working directory.
- `model` (optional): explicit Pi model selector for the child process. Defaults to the calling agent's current model; use `same`, `current`, `caller`, `calling-agent`, or omit it to forward the caller model.

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this. It runs with restricted scanner-oriented tools:

```text
read,write,grep,find,ls,bash
```

## Installation

The source folder is intended to be symlinked into Pi's user extension directory:

```bash
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/codebase-scanner-subagent" \
  "$HOME/.pi/agent/extensions/codebase-scanner-subagent"
```

Reload Pi after creating or updating the symlink:

```text
/reload
```

or restart Pi.

## Example Invocations

General scan:

```text
Use codebase_scanner_subagent to scan this project.
```

Request-focused scan:

```text
Use codebase_scanner_subagent with request_file=/absolute/path/to/docs/reference/refined-request-my-feature.md.
```

The expected output is a short report containing the scan output path, key metadata, module count, request-driven narrowing status, and anomalies. The detailed scan is written to the output markdown file.
