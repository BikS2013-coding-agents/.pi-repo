# Test Builder Subagent Pi Extension

This Pi extension registers the `test_builder_subagent` tool. The tool delegates scoped test creation/update to an isolated child Pi process that uses the bundled `test-builder-agent.md` prompt, writes or updates only owned test files, optionally runs only the touched tests, and produces a structured markdown test-build report.

## Files

- `index.ts` — Pi extension entrypoint.
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

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this. It is launched in JSON print mode with an appended system prompt and an explicit Pi-native tool allowlist:

```text
read,write,edit,grep,find,ls,bash
```

Serena, CCLS, or other MCP/LSP tools are not assumed to exist. The adapted prompt instructs the child process to use local file/search/test-runner evidence and document any symbol-resolution or diagnostics limitations instead of depending on MCP/LSP tools.

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
- No interactive user questions.
- `test_files_owned` is declared before any writes and is never expanded.
- Shared test infrastructure is not edited.
- Only touched/owned tests are executed.
- The markdown report includes mandatory YAML frontmatter for downstream aggregation.
- Unsuitable scopes are skipped with structured `skipped_*` statuses rather than fabricated tests.

No runtime dependencies are added by this extension; it uses Pi's extension API, `typebox`, and Node.js built-ins already available to Pi extensions.
