import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "request_refiner_subagent";
const PROMPT_FILE = "request-refiner-agent.md";
const CHILD_TOOLS = "read,write,grep,find,ls,contact_supervisor,intercom";
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
		throw new Error(`Request refiner subagent prompt file is missing: ${promptPath}`);
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
		`Request refiner called contact_supervisor with reason=${reason}.`,
		"The request refiner is paused waiting for the supervisor reply; this is expected for rare blocking need_decision/interview_request cases.",
		bridge ? `Supervisor target: ${bridge.orchestratorTarget}` : undefined,
		bridge ? `Child intercom session: ${bridge.childSessionName}` : undefined,
		"Reply from the parent Pi session with the immediate slash command:",
		"/intercom-reply <your decision>",
		"",
		"Do not type a normal steering message like 'reply to the request refiner...': steering is queued until the current request_refiner_subagent tool finishes, so it cannot unblock the waiting child.",
		"If the agent is already idle, the regular tool form also works: intercom({ action: \"reply\", message: \"<your decision>\" })",
		"",
		"Request-refiner message:",
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

function buildTask(rawRequest: string, projectRoot: string, outputSlug?: string, additionalContext?: string): string {
	const parts = [
		"Refine the following raw user request into a structured specification.",
		"",
		`Project root: ${projectRoot}`,
		"Save the refined request under docs/reference/ inside the project root.",
	];

	if (outputSlug?.trim()) {
		parts.push(`Use this requested slug if it fits the objective: ${outputSlug.trim()}`);
	}

	if (additionalContext?.trim()) {
		parts.push("", "Additional context from the parent agent:", additionalContext.trim());
	}

	parts.push("", "Raw request:", rawRequest);
	return parts.join("\n");
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
			if (wasAborted && !stderr.includes("aborted")) stderr += "Child Pi request-refiner process aborted by parent signal.\n";
			resolve({
				exitCode: code ?? 1,
				stdout,
				stderr,
				messages,
				finalText,
				observedModel,
			});
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

export default function requestRefinerSubagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Request Refiner Subagent",
		description:
			"Delegate request refinement to an isolated Pi subagent. The subagent reads relevant project context, writes docs/reference/refined-request-<slug>.md, and returns the output path, slug, scope boundaries, and open questions.",
		promptSnippet: "Refine broad, vague, complex, or multi-step user requests into docs/reference/refined-request-<slug>.md via an isolated subagent.",
		promptGuidelines: [
			"Use request_refiner_subagent when a request needs refinement before planning, design, implementation, review, or testing.",
			"Do not use request_refiner_subagent for trivial read-only questions or already fully specified requests.",
		],
		parameters: Type.Object({
			rawRequest: Type.String({ description: "The raw user request to refine. Preserve the user's wording." }),
			projectRoot: Type.Optional(
				Type.String({ description: "Project root where docs/reference/refined-request-<slug>.md should be written. Defaults to the current Pi working directory." }),
			),
			outputSlug: Type.Optional(
				Type.String({ description: "Optional preferred 3-5 word lowercase hyphenated slug for the refined request file." }),
			),
			additionalContext: Type.Optional(
				Type.String({ description: "Optional extra context or constraints from the parent agent to include in the refinement task." }),
			),
			model: Type.Optional(
				Type.String({ description: "Optional Pi model selector for the child process. Defaults to the calling agent's current model; use \"same\" or omit to forward the caller model." }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const rawRequest = params.rawRequest?.trim();
			if (!rawRequest) {
				return {
					content: [{ type: "text", text: "Missing required parameter: rawRequest." }],
					isError: true,
				};
			}

			let promptPath: string;
			try {
				promptPath = requirePromptPath();
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
				};
			}

			const projectRoot = path.resolve(params.projectRoot?.trim() || ctx.cwd);
			if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
				return {
					content: [{ type: "text", text: `Project root does not exist or is not a directory: ${projectRoot}` }],
					isError: true,
				};
			}

			const task = buildTask(rawRequest, projectRoot, params.outputSlug, params.additionalContext);
			const childModel = resolveChildModelSelector(params.model, ctx.model);
			const runId = randomUUID();
			const childIndex = 0;
			const orchestratorTarget = resolveIntercomSessionTarget(pi.getSessionName(), ctx.sessionManager.getSessionId());
			const childSessionName = resolveSubagentIntercomTarget(runId, "request-refiner", childIndex);
			const intercomBridge = {
				orchestratorTarget,
				runId,
				childAgent: "request-refiner",
				childIndex,
				childSessionName,
			};

			onUpdate?.({ content: [{ type: "text", text: `Starting request-refiner subagent in ${projectRoot}${childModel ? ` with model ${childModel}` : ""}. Supervisor target: ${orchestratorTarget}.` }] });

			const result = await runChildPi({
				promptPath,
				task,
				cwd: projectRoot,
				model: childModel,
				intercomBridge,
				signal,
				onText: (text) => onUpdate?.({ content: [{ type: "text", text }] }),
			});

			if (result.exitCode !== 0 || !result.finalText.trim()) {
				const diagnostics = [
					`Request-refiner subagent failed with exit code ${result.exitCode}.`,
					result.stderr.trim() ? `stderr:\n${tailText(result.stderr.trim(), DIAGNOSTIC_TEXT_CAP)}` : "",
					!result.finalText.trim() && result.stdout.trim() ? `stdout:\n${tailText(result.stdout.trim(), DIAGNOSTIC_TEXT_CAP)}` : "",
				]
					.filter(Boolean)
					.join("\n\n");

				return {
					content: [{ type: "text", text: diagnostics }],
					details: {
						projectRoot,
						promptPath,
						childModel,
						observedModel: result.observedModel,
						intercomBridge,
						exitCode: result.exitCode,
						stderr: tailText(result.stderr, DIAGNOSTIC_TEXT_CAP),
						messageCount: result.messages.length,
					},
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: truncateText(result.finalText, FINAL_TEXT_CAP) }],
				details: {
					projectRoot,
					promptPath,
					childModel,
					observedModel: result.observedModel,
					intercomBridge,
					exitCode: result.exitCode,
					messageCount: result.messages.length,
				},
			};
		},
	});
}
