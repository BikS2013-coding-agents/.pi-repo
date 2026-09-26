# .pi-repo

[Pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) extensions that give a Pi
agent a set of **subagents**: each extension registers one tool that hands a focused task
to an isolated child Pi process with its own prompt, and returns the child's result.

Lives at `~/coding-agents/.pi-repo`; each extension folder is symlinked into
`~/.pi/agent/extensions/`, which is how Pi loads it. See
[`repos.md`](https://github.com/BikS2013-coding-agents/coding-agents/blob/main/repos.md)
in the `coding-agents` workspace for the link commands.

## Extensions

| Folder | Tool | What the subagent does |
|---|---|---|
| `request-refiner-subagent` | `request_refiner_subagent` | Turns a vague request into a structured specification |
| `codebase-scanner-subagent` | `codebase_scanner_subagent` | Writes a codebase overview with YAML frontmatter metadata |
| `investigator-subagent` | `investigator_subagent` | Researches and compares approaches, then recommends one |
| `technical-researcher-subagent` | `technical_researcher_subagent` | Produces sourced documentation on a technical topic |
| `plan-builder-subagent` | `plan_builder_subagent` | Writes an agent-executable implementation plan |
| `design-builder-subagent` | `design_builder_subagent` | Writes the technical design for a planned change |
| `test-builder-extension` | `test_builder_subagent` | Adds or updates tests for one scope |
| `dependency-validator-subagent` | `dependency_validator_subagent` | Finds deprecated or vulnerable dependencies and vets new ones |
| `tool-doc-config-architect-subagent` | `tool_doc_config_architect_subagent` | Scaffolds or audits a tool's documentation and configuration |
| `worker-subagent-extension` | `worker_subagent` | General implementation worker, derived from [`pi-subagents`](https://github.com/nicobailon/pi-subagents) |

Each folder holds `index.ts` (the extension and child-process launcher), the subagent's
prompt (`*-agent.md`) and a README with the tool's parameters.

## Supervisor contact (pi-intercom)

Child subagents can pause and ask their supervisor for a decision through
[`pi-intercom`](https://www.npmjs.com/package/pi-intercom): each child gets the
`contact_supervisor` and `intercom` tools, and the parent session answers with
`/intercom-reply <decision>` while the subagent tool is still running.
[`extensions/pi-intercom-subagent-integration-instructions.md`](extensions/pi-intercom-subagent-integration-instructions.md)
is the reusable guide for adding this to a new subagent extension.

## Adding a subagent

`subagent-request.md` is the prompt used to create a new subagent extension from an agent
specification. After creating one, link it:

```bash
ln -sfn ~/coding-agents/.pi-repo/extensions/<name> ~/.pi/agent/extensions/<name>
```
