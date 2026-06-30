# Investigator Subagent Pi Extension

This Pi extension registers the `investigator_subagent` tool. The tool delegates option discovery, trade-off comparison, and approach recommendation to an isolated child Pi process that writes a structured investigation document under `docs/reference/`.

## Files

- `index.ts` — Pi extension entrypoint.
- `investigator-agent.md` — adapted investigator subagent prompt derived from `/Users/giorgosmarinos/aiwork/llama-cpp/test/subagent-specs/investigator.md`.

## Tool

### `investigator_subagent`

Parameters:

- `investigation_request` (required): question, decision, option landscape, or approach area to investigate.
- `cwd` (optional): project root / working directory for the child investigator process. Defaults to the current Pi working directory.
- `refined_request_file` (optional): absolute or cwd-relative path to a refined request specification. If supplied, it must exist.
- `codebase_scan_file` (optional): absolute or cwd-relative path to a codebase scan document. If supplied, it must exist.
- `output_path` (optional): absolute or cwd-relative path for the investigation markdown output. Defaults to `docs/reference/investigation-<slug>.md` under `cwd`.
- `output_slug` (optional): lowercase hyphenated slug used when `output_path` is omitted.
- `additional_context` (optional): extra context, constraints, or limitations from the parent agent.
- `model` (optional): explicit Pi model selector for the child process. Defaults to the calling agent's current model; use `same`, `current`, `caller`, `calling-agent`, or omit it to forward the caller model.

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this. It runs with restricted locally available tools:

```text
read,write,grep,find,ls,bash
```

External web/search/documentation tools are not assumed to exist. If unavailable, the child investigator is instructed to document that limitation rather than fabricate sources or claims.

## Output

The child subagent writes an investigation document with sections including:

- Executive Summary
- Context
- Options Identified
- Comparison Matrix
- Recommendation
- Technical Research Guidance
- Implementation Considerations
- References
- Original Request

The document must include exactly one parseable line:

```markdown
**Research needed**: Yes
```

or:

```markdown
**Research needed**: No
```

## Installation

The source folder is intended to be symlinked into Pi's user extension directory:

```bash
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/investigator-subagent" \
  "$HOME/.pi/agent/extensions/investigator-subagent"
```

Reload Pi after creating or updating the symlink:

```text
/reload
```

or restart Pi.

## Example Invocations

General investigation:

```text
Use investigator_subagent to investigate options for adding real-time notifications to this API.
```

Request-focused investigation:

```text
Use investigator_subagent with refined_request_file=/absolute/path/to/docs/reference/refined-request-my-feature.md and investigation_request="Compare implementation approaches for this request."
```

With codebase context:

```text
Use investigator_subagent with refined_request_file=/absolute/path/to/refined-request-my-feature.md and codebase_scan_file=/absolute/path/to/codebase-scan-my-feature.md.
```
