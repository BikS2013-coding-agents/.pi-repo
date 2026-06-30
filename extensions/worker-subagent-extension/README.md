# Worker Subagent Pi Extension

This extension registers `worker_subagent`, a dedicated worker implementation subagent derived from the internet-hosted `pi-subagents` extension.

## Upstream provenance

The requested online `pi-subagents` extension was found and verified:

- Repository: <https://github.com/nicobailon/pi-subagents>
- npm package: <https://www.npmjs.com/package/pi-subagents>
- Repository description: "Pi extension for async subagent delegation with truncation, artifacts, and session sharing"
- Commit studied: `85348a7fcf2c6a9e46ccf4ff3f9d7a9d8a1288c0`
- Commit date: `2026-06-26T06:39:15Z`
- Retrieved: `2026-06-30`
- Files studied:
  - `agents/worker.md`
  - `README.md`
  - `src/extension/index.ts`
  - `src/runs/foreground/subagent-executor.ts`
  - `src/runs/background/subagent-runner.ts`
  - `src/runs/shared/pi-args.ts`
  - `src/agents/agents.ts`

## Upstream worker implementation summary

The upstream worker is a builtin agent with this frontmatter:

```yaml
name: worker
description: Implementation agent for normal tasks and approved oracle handoffs
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
tools: read, grep, find, ls, bash, edit, write, contact_supervisor
defaultContext: fork
defaultReads: context.md, plan.md
defaultProgress: true
```

Behavior studied:

- Worker is the implementation/writer agent.
- It makes narrow, coherent edits and validates with focused checks when practical.
- It treats approved plans/oracle handoffs as contracts and does not invent unapproved product or architecture decisions.
- It reads `context.md` and `plan.md` by default when present.
- It is designed to escalate required decisions through `contact_supervisor` when that tool/intercom bridge is available.
- It returns a concise final response: implemented change, changed files, validation, risks/questions, next step.

The upstream extension supports a broad generic `subagent` tool, foreground/background runs, chain/parallel orchestration, model overrides/fallbacks, artifact directories, session sharing, forked context, widgets, slash commands, and optional intercom. This local extension intentionally implements only a dedicated worker subagent tool, reusing the worker persona and isolated child-`pi` execution pattern.

## Local tool

### `worker_subagent`

Parameters:

- `task` (required): implementation task or approved direction.
- `cwd` (optional): project root / working directory for the child worker process. Defaults to the current Pi working directory.
- `context_files` (optional): files the worker should read first if present. Defaults to `context.md` and `plan.md`.
- `extra_instructions` (optional): additional parent-agent instructions.
- `model` (optional): explicit Pi model selector for the child process. Defaults to the calling agent's current model; use `same`, `current`, `caller`, `calling-agent`, or omit it to forward the caller model.

The child process is launched in JSON print mode with:

```text
--no-session --no-skills --name <child-intercom-name> --system-prompt worker-agent.md --tools read,grep,find,ls,bash,edit,write,contact_supervisor,intercom
```

## pi-intercom supervisor bridge

Phase 2 support is enabled: when `worker_subagent` launches a child process it now injects the upstream `pi-subagents` / `pi-intercom` bridge metadata:

```text
PI_SUBAGENT_ORCHESTRATOR_TARGET=<parent session name or subagent-chat-<session-id-prefix>>
PI_SUBAGENT_RUN_ID=<uuid>
PI_SUBAGENT_CHILD_AGENT=worker
PI_SUBAGENT_CHILD_INDEX=0
PI_SUBAGENT_INTERCOM_SESSION_NAME=subagent-worker-<run-id>-1
```

The child is also launched with `--name subagent-worker-<run-id>-1` so it has a stable intercom presence name while running.

If `pi-intercom` is installed and auto-loaded in the child Pi process, it sees this metadata and registers the child-only `contact_supervisor` tool. The worker can then call:

```text
contact_supervisor({ reason: "need_decision", message: "..." })
contact_supervisor({ reason: "progress_update", message: "..." })
contact_supervisor({ reason: "interview_request", interview: { ... } })
```

If `contact_supervisor` or `intercom` are not installed/available, they simply will not be available to the child model; the adapted worker prompt instructs the child to report blockers instead of silently choosing.

When the child calls `contact_supervisor`, the extension now streams an explicit parent-visible status update explaining that the worker is paused and waiting for a supervisor reply, including the suggested immediate slash command:

```text
/intercom-reply <your decision>
```

Do not abort the parent `worker_subagent` tool call while a `need_decision` or `interview_request` contact is pending unless you intentionally want to kill the child worker. Also do not type a normal steering message like "reply to the worker..." while the foreground tool is still running: Pi queues steering until the current tool call finishes, so it cannot unblock the child. Use the immediate `/intercom-reply ...` slash command while the tool is running; when the agent is already idle, the regular `intercom({ action: "reply", message: "..." })` tool form also works. The child should continue with the reply as its tool result.

## Installation

The source folder is intended to be symlinked into Pi's user extension directory:

```bash
ln -sfn "$HOME/ai-coding/pi-workdocs/extensions/worker-subagent-extension" \
  "$HOME/.pi/agent/extensions/worker-subagent-extension"
```

Then reload or restart Pi:

```text
/reload
```

## Example invocation

```text
Use worker_subagent with task="Implement the approved parser change from docs/design/plan-001-parser.md" and context_files=["docs/design/plan-001-parser.md"].
```

To force a different model:

```text
Use worker_subagent with task="Apply this small refactor" and model="anthropic/claude-sonnet-4-5".
```

For the same model as the calling Pi agent, omit `model` or pass `model="same"`.

## Notes

- No runtime dependencies are added.
- The user request path `~/ai-coding/pi-wokdocs/extensions` appears to be a typo. This extension was placed under the existing workspace: `~/ai-coding/pi-workdocs/extensions`.
- This is not a full copy of upstream `pi-subagents`; it is a focused worker-only adapter based on the verified upstream worker implementation.
