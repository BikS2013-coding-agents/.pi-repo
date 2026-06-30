# Dependency Validator Subagent Pi Extension

This Pi extension registers the `dependency_validator_subagent` tool. The tool launches an isolated child `pi` process with the dependency-validator agent prompt, validates dependency hygiene for a target project, and writes the structured markdown report required by the agent specification.

## Files

- `index.ts` — Pi extension entrypoint.
- `dependency-validator-agent.md` — adapted Pi subagent prompt derived from `/Users/giorgosmarinos/aiwork/llama-cpp/test/subagent-specs/dependency-validator.md`.

## Tool

### `dependency_validator_subagent`

Parameters:

- `target_path` (optional): absolute or cwd-relative project path. Defaults to current Pi working directory.
- `output_path` (optional): absolute or `target_path`-relative report path. Defaults to `target_path/docs/reference/dependency-validation-<ISO-timestamp>.md`.
- `request_file` (optional): absolute or `target_path`-relative refined-request file for context.
- `mode` (optional): `report-only`, `fix`, or `interactive`. Defaults to `fix`.
- `max_iterations` (optional): hard cap on validate/fix loops. Defaults to `5`.
- `include_security_audit` (optional): include supported security audit commands. Defaults to `true`.
- `model` (optional): explicit Pi model selector for the child process. Defaults to the calling agent's current model; use `same`, `current`, `caller`, `calling-agent`, or omit it to forward the caller model.

The child process forwards the calling agent's current model by default by launching `pi --model <caller-provider>/<caller-model-id>`. An explicit `model` parameter overrides this. It runs with these tools:

```text
read,write,edit,grep,find,ls,bash
```

## Installation / Symlinks

The source folder is intended to be symlinked into Pi's user extension directory:

```bash
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/dependency-validator-subagent" \
  "$HOME/.pi/agent/extensions/dependency-validator-subagent"
```

The adapted agent definition is also symlinked into Pi's user agent directory so generic subagent runners can discover it by name:

```bash
mkdir -p "$HOME/.pi/agent/agents"
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/dependency-validator-subagent/dependency-validator-agent.md" \
  "$HOME/.pi/agent/agents/dependency-validator.md"
```

Reload Pi after creating or updating the symlinks:

```text
/reload
```

or restart Pi.

## Example Invocation

Report-only check:

```text
Use dependency_validator_subagent with target_path: "/path/to/project", mode: "report-only".
```

Interactive fix plan without applying changes:

```text
Use dependency_validator_subagent with target_path: "/path/to/project", mode: "interactive".
```

Generic subagent runner invocation, if the `subagent` tool is available:

```text
Use subagent with agent: "dependency-validator" and task: "Run dependency validation for /path/to/project in report-only mode."
```

## Verification

Confirm symlinks resolve:

```bash
readlink "$HOME/.pi/agent/extensions/dependency-validator-subagent"
readlink "$HOME/.pi/agent/agents/dependency-validator.md"
test -f "$HOME/.pi/agent/extensions/dependency-validator-subagent/index.ts"
test -f "$HOME/.pi/agent/agents/dependency-validator.md"
```

Confirm Pi can load the extension by starting a new Pi session or running `/reload`. The extension performs no dependency validation until the `dependency_validator_subagent` tool is called.
