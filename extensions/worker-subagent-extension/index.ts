import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "worker_subagent";
const PROMPT_FILE = "worker-agent.md";
const CHILD_TOOLS = "read,grep,find,ls,bash,edit,write,contact_supervisor,intercom";
const FINAL_TEXT_CAP = 24 * 1024;
const DIAGNOSTIC_TEXT_CAP = 6 * 1024;

const SAME_MODEL_ALIASES = new Set(["same", "current", "caller", "calling-agent", "same-as-calling-agent"]);
const DEFAULT_INTERCOM_TARGET_PREFIX = "subagent-chat";
const SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET";
const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
const SUBAGENT_CHILD_INDEX_ENV = "PI_SUBAGENT_CHILD_INDEX";
const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";

type JsonEvent = {
	type?: string;
	message?: unknown;
	[key: string]: unknown;
};

type MessageLike = {
	role?: string;
	content?: unknown;
	usage?: unknown;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
};

function extensionDir(): string {
	return __dirname;
}

function requirePromptPath(): string {
	const promptPath = path.join(extensionDir(), PROMPT_FILE);
	if (!fs.existsSync(promptPath)) {
		throw new Error(`Worker subagent prompt file is missing: ${promptPath}`);
	}
	return promptPath;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const record = part as Record<string, unknown>;
			if (typeof record.text === "string") return record.text;
			if (typeof record.content === "string") return record.content;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function messageToText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	return contentToText((message as MessageLike).content);
}

function getEventRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function formatSupervisorWaitNotice(args: Record<string, unknown>, bridge: { orchestratorTarget: string; childSessionName: string } | undefined): string {
	const reason = typeof args.reason === "string" ? args.reason : "unknown";
	const message = typeof args.message === "string" ? args.message : "(no message text supplied)";
	const lines = [
		`Worker called contact_supervisor with reason=${reason}.`,
		"The worker is paused waiting for the supervisor reply; this is expected for need_decision/interview_request.",
		bridge ? `Supervisor target: ${bridge.orchestratorTarget}` : undefined,
		bridge ? `Child intercom session: ${bridge.childSessionName}` : undefined,
		"Reply from the parent Pi session with the immediate slash command:",
		'/intercom-reply <your decision>',
		"",
		"Do not type a normal steering message like 'reply to worker...': steering is queued until the current worker_subagent tool finishes, so it cannot unblock the waiting child.",
		"If the agent is already idle, the regular tool form also works: intercom({ action: \"reply\", message: \"<your decision>\" })",
		"",
		"Worker message:",
		message,
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

function resolveChildModelSelector(rawModel: string | undefined, currentModel: { provider?: string; id?: string } | undefined): string | undefined {
	const requested = rawModel?.trim();
	if (requested && !SAME_MODEL_ALIASES.has(requested.toLowerCase())) return requested;
	if (currentModel?.provider && currentModel?.id) return `${currentModel.provider}/${currentModel.id}`;
	return undefined;
}

function truncateText(text: string, maxBytes: number): string {
	const byteLength = Buffer.byteLength(text, "utf8");
	if (byteLength <= maxBytes) return text;
	let truncated = text.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

function tailText(text: string, maxBytes: number): string {
	const byteLength = Buffer.byteLength(text, "utf8");
	if (byteLength <= maxBytes) return text;
	let tail = text.slice(-maxBytes);
	while (Buffer.byteLength(tail, "utf8") > maxBytes) tail = tail.slice(1);
	return `[Earlier output truncated: ${byteLength - Buffer.byteLength(tail, "utf8")} bytes omitted.]\n${tail}`;
}

function resolveCwd(rawCwd: string | undefined, fallback: string): string {
	return path.resolve(rawCwd?.trim() || fallback);
}

function sanitizeIntercomTargetPart(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "") || "agent";
}

function resolveIntercomSessionTarget(sessionName: string | undefined, sessionId: string): string {
	const trimmedName = sessionName?.trim();
	if (trimmedName) return trimmedName;
	const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
	return `${DEFAULT_INTERCOM_TARGET_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}

function resolveSubagentIntercomTarget(runId: string, agent: string, index: number): string {
	return `subagent-${sanitizeIntercomTargetPart(agent)}-${sanitizeIntercomTargetPart(runId)}-${index + 1}`;
}

function normalizeContextFiles(rawFiles: string[] | undefined): string[] {
	if (!Array.isArray(rawFiles)) return ["context.md", "plan.md"];
	return rawFiles.map((file) => file.trim()).filter(Boolean);
}

function existingContextFileLines(cwd: string, contextFiles: string[]): string[] {
	const lines: string[] = [];
	for (const file of contextFiles) {
		const resolved = path.resolve(cwd, file);
		if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
			lines.push(`- ${resolved}`);
		}
	}
	return lines;
}

function buildTask(options: { task: string; cwd: string; contextFiles: string[]; extraInstructions?: string }): string {
	const contextLines = existingContextFileLines(options.cwd, options.contextFiles);
	const lines = [
		"Run as the worker implementation subagent using the worker system prompt.",
		"",
		"Launch inputs:",
		`- cwd: ${options.cwd}`,
		`- context_files_to_read_if_present: ${options.contextFiles.length > 0 ? options.contextFiles.join(", ") : "none"}`,
		"",
	];

	if (contextLines.length > 0) {
		lines.push("Context files found. Read these before editing:", ...contextLines, "");
	} else if (options.contextFiles.length > 0) {
		lines.push("No configured context files were found; proceed from the explicit task and repository context.", "");
	}

	if (options.extraInstructions?.trim()) {
		lines.push("Additional parent-agent instructions:", options.extraInstructions.trim(), "");
	}

	lines.push(
		"Task:",
		options.task,
		"",
		"Requirements:",
		"- Implement narrowly and coherently; do not make unapproved product or architecture decisions.",
		"- Use the available read/search/bash/edit/write tools directly.",
		"- Validate with relevant focused checks when practical.",
		"- If blocked by an unapproved decision, report the blocker clearly rather than inventing a decision.",
		"- Return the worker final response in the required concise shape.",
	);
	return lines.join("\n");
}

async function runChildPi(options: {
	promptPath: string;
	task: string;
	cwd: string;
	model?: string;
	intercomBridge?: {
		orchestratorTarget: string;
		runId: string;
		childAgent: string;
		childIndex: number;
		childSessionName: string;
	};
	signal?: AbortSignal;
	onText?: (text: string) => void;
}): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	messages: MessageLike[];
	finalText: string;
	observedModel?: string;
}> {
	const args = ["--mode", "json", "-p", "--no-session", "--no-skills", "--tools", CHILD_TOOLS, "--system-prompt", options.promptPath];
	if (options.model?.trim()) args.push("--model", options.model.trim());
	if (options.intercomBridge?.childSessionName) args.push("--name", options.intercomBridge.childSessionName);
	args.push(options.task);

	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	if (options.intercomBridge) {
		childEnv[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = options.intercomBridge.orchestratorTarget;
		childEnv[SUBAGENT_RUN_ID_ENV] = options.intercomBridge.runId;
		childEnv[SUBAGENT_CHILD_AGENT_ENV] = options.intercomBridge.childAgent;
		childEnv[SUBAGENT_CHILD_INDEX_ENV] = String(options.intercomBridge.childIndex);
		childEnv[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = options.intercomBridge.childSessionName;
	}

	return await new Promise((resolve) => {
		const child = spawn("pi", args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: childEnv,
		});

		let stdout = "";
		let stderr = "";
		let lineBuffer = "";
		const messages: MessageLike[] = [];
		let finalText = "";
		let observedModel: string | undefined;
		let wasAborted = false;

		const processLine = (line: string) => {
			stdout += `${line}\n`;
			if (!line.trim()) return;

			let event: JsonEvent;
			try {
				event = JSON.parse(line) as JsonEvent;
			} catch {
				return;
			}

			if (event.type === "tool_execution_start" && event.toolName === "contact_supervisor") {
				const args = getEventRecord(event.args) ?? getEventRecord(event.input) ?? {};
				options.onText?.(formatSupervisorWaitNotice(args, options.intercomBridge));
			}

			if (event.type === "tool_result_end" && event.message && typeof event.message === "object") {
				const message = event.message as MessageLike;
				messages.push(message);
				const text = messageToText(message).trim();
				if (text) options.onText?.(truncateText(text, FINAL_TEXT_CAP));
			}

			if (event.type === "message_end" && event.message && typeof event.message === "object") {
				const message = event.message as MessageLike;
				messages.push(message);
				if (message.model) observedModel = message.model;
				if (message.role === "assistant") {
					const text = messageToText(message).trim();
					if (text) {
						finalText = text;
						options.onText?.(truncateText(text, FINAL_TEXT_CAP));
					}
				}
			}
		};

		child.stdout.on("data", (data) => {
			lineBuffer += data.toString();
			const lines = lineBuffer.split("\n");
			lineBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("error", (error) => {
			stderr += `${error.message}\n`;
		});

		child.on("close", (code) => {
			if (lineBuffer.trim()) processLine(lineBuffer);
			if (wasAborted && !stderr.includes("aborted")) stderr += "Child Pi worker process aborted by parent signal.\n";
			resolve({ exitCode: code ?? 1, stdout, stderr, messages, finalText, observedModel });
		});

		if (options.signal) {
			const abortChild = () => {
				wasAborted = true;
				child.kill("SIGTERM");
				setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
				}, 5000).unref?.();
			};

			if (options.signal.aborted) abortChild();
			else options.signal.addEventListener("abort", abortChild, { once: true });
		}
	});
}

export default function workerSubagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Worker Subagent",
		description:
			"Delegate implementation work to a focused worker subagent derived from the internet-hosted nicobailon/pi-subagents worker. The child runs in an isolated Pi process, can edit files, validates when practical, and reports changed files, validation, risks, and next step.",
		promptSnippet:
			"Run worker_subagent for narrow implementation tasks or approved execution plans when an isolated writer agent should make edits and report validation.",
		promptGuidelines: [
			"Use worker_subagent for implementation tasks that need a focused isolated writer with read/search/bash/edit/write tools.",
			"Pass concrete task instructions to worker_subagent; include approved plan/context paths via context_files or task text when available.",
			"Do not use worker_subagent for exploratory option discovery, planning-only work, or full-suite integration verification.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Required implementation task or approved direction for the worker subagent." }),
			cwd: Type.Optional(
				Type.String({ description: "Optional project root / working directory for the child worker process. Defaults to current Pi working directory." }),
			),
			context_files: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional cwd-relative or absolute files the worker should read first if they exist. Defaults to context.md and plan.md.",
				}),
			),
			extra_instructions: Type.Optional(Type.String({ description: "Optional additional instructions from the parent agent." })),
			model: Type.Optional(
				Type.String({
					description:
						"Optional Pi model selector for the child process. Defaults to the calling agent's current model; use same/current/caller to forward the caller model explicitly.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = params.task?.trim();
			if (!task) {
				return { content: [{ type: "text", text: "Missing required parameter: task." }], isError: true };
			}

			let promptPath: string;
			try {
				promptPath = requirePromptPath();
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
			}

			const cwd = resolveCwd(params.cwd, ctx.cwd);
			if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
				return { content: [{ type: "text", text: `cwd does not exist or is not a directory: ${cwd}` }], isError: true };
			}

			const contextFiles = normalizeContextFiles(params.context_files);
			const childModel = resolveChildModelSelector(params.model, ctx.model);
			const childTask = buildTask({ task, cwd, contextFiles, extraInstructions: params.extra_instructions });
			const runId = randomUUID();
			const childIndex = 0;
			const orchestratorTarget = resolveIntercomSessionTarget(pi.getSessionName(), ctx.sessionManager.getSessionId());
			const childSessionName = resolveSubagentIntercomTarget(runId, "worker", childIndex);
			const intercomBridge = {
				orchestratorTarget,
				runId,
				childAgent: "worker",
				childIndex,
				childSessionName,
			};

			onUpdate?.({ content: [{ type: "text", text: `Starting worker subagent in ${cwd}${childModel ? ` with model ${childModel}` : ""}. Supervisor target: ${orchestratorTarget}.` }] });

			const result = await runChildPi({
				promptPath,
				task: childTask,
				cwd,
				model: childModel,
				intercomBridge,
				signal,
				onText: (text) => onUpdate?.({ content: [{ type: "text", text }] }),
			});

			if (result.exitCode !== 0 || !result.finalText.trim()) {
				const diagnostics = [
					`Worker subagent failed with exit code ${result.exitCode}.`,
					result.stderr.trim() ? `stderr:\n${tailText(result.stderr.trim(), DIAGNOSTIC_TEXT_CAP)}` : "",
					!result.finalText.trim() && result.stdout.trim() ? `stdout:\n${tailText(result.stdout.trim(), DIAGNOSTIC_TEXT_CAP)}` : "",
				]
					.filter(Boolean)
					.join("\n\n");
				return {
					content: [{ type: "text", text: diagnostics }],
					details: { cwd, promptPath, childModel, observedModel: result.observedModel, intercomBridge, exitCode: result.exitCode, stderr: tailText(result.stderr, DIAGNOSTIC_TEXT_CAP), messageCount: result.messages.length },
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: truncateText(result.finalText, FINAL_TEXT_CAP) }],
				details: { cwd, promptPath, childModel, observedModel: result.observedModel, intercomBridge, exitCode: result.exitCode, messageCount: result.messages.length, contextFiles },
			};
		},
	});
}
