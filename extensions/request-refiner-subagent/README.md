# Request Refiner Subagent Pi Extension

This Pi extension registers the `request_refiner_subagent` tool. The tool delegates request refinement to an isolated child Pi process that reads relevant project context, writes a refined request specification under `docs/reference/`, and returns a concise caller report.

## Files

- `index.ts` — Pi extension entrypoint.
- `request-refiner-agent.md` — adapted request-refiner subagent prompt derived from `/Users/giorgosmarinos/aiwork/llama-cpp/test/subagent-specs/request-refiner.md`.

## Tool

### `request_refiner_subagent`

Parameters:

- `rawRequest` (required): raw user request to refine.
- `projectRoot` (optional): project root for `docs/reference/refined-request-<slug>.md`; defaults to the current Pi working directory.
- `outputSlug` (optional): preferred lowercase hyphenated slug.
- `additionalContext` (optional): extra constraints or context from the parent agent.
- `model` (optional): explicit Pi model selector for the child process. Defaults to the calling agent's current model; use `same`, `current`, `caller`, `calling-agent`, or omit it to forward the caller model.

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this. It runs with restricted file-oriented tools:

```text
read,write,grep,find,ls
```

## Installation

The source folder is intended to be symlinked into Pi's user extension directory:

```bash
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/request-refiner-subagent" \
  "$HOME/.pi/agent/extensions/request-refiner-subagent"
```

Reload Pi after creating or updating the symlink:

```text
/reload
```

or restart Pi.

## Example Invocation

Ask Pi to use the tool, for example:

```text
Use request_refiner_subagent to refine this request: "Build a dashboard that shows Azure costs by team."
```

The expected subagent output is a short report containing the refined request file path, slug, category, key scope boundaries, and open questions.
