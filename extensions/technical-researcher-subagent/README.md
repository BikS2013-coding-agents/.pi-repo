# Technical Researcher Subagent Pi Extension

This Pi extension registers the `technical_researcher_subagent` tool. The tool delegates implementation-level technical research to an isolated child Pi process that writes comprehensive markdown documentation under `docs/research/`.

## Files

- `index.ts` — Pi extension entrypoint.
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

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this. It runs with restricted locally available tools:

```text
read,write,grep,find,ls,bash
```

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
