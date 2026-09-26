import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "investigator_subagent";
const PROMPT_FILE = "investigator-agent.md";
const CHILD_TOOLS = "read,write,grep,find,ls,bash,contact_supervisor,intercom";
const CHILD_AGENT_NAME = "investigator";
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
		throw new Error(`Investigator subagent prompt file is missing: ${promptPath}`);
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
		`Investigator called contact_supervisor with reason=${reason}.`,
		"The investigator is paused waiting for the supervisor reply; this is expected for need_decision/interview_request.",
		bridge ? `Supervisor target: ${bridge.orchestratorTarget}` : undefined,
		bridge ? `Child intercom session: ${bridge.childSessionName}` : undefined,
		"Reply from the parent Pi session with the immediate slash command:",
		"/intercom-reply <your decision>",
		"",
		"Do not type a normal steering message like 'reply to the investigator...': steering is queued until the current investigator_subagent tool finishes, so it cannot unblock the waiting child.",
		"If the agent is already idle, the regular tool form also works: intercom({ action: \"reply\", message: \"<your decision>\" })",
		"",
		"Investigator message:",
		message,
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

function formatSupervisorReplyEvidence(event: JsonEvent): string | undefined {
	if (event.toolName !== "contact_supervisor") return undefined;
	const candidate = event.message ?? event.result ?? event.output;
	const text = messageToText(candidate).trim() || (typeof candidate === "string" ? candidate.trim() : "");
	if (!text) return "Investigator contact_supervisor call completed; supervisor reply was delivered to the child.";
	return `Investigator contact_supervisor completed. Child-visible result:\n${truncateText(text, 2000)}`;
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

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.split("-")
		.filter(Boolean)
		.slice(0, 5)
		.join("-");
	return slug || "general";
}

function slugFromRefinedRequestFile(filePath?: string): string | undefined {
	if (!filePath?.trim()) return undefined;
	const base = path.basename(filePath.trim()).replace(/\.md$/i, "");
	return slugify(base.replace(/^refined-request-/i, ""));
}

function resolveCwd(rawCwd: string | undefined, fallback: string): string {
	return path.resolve(rawCwd?.trim() || fallback);
}

function sanitizeIntercomTargetPart(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "agent"
	);
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

function resolveOptionalFile(rawFile: string | undefined, cwd: string): string | undefined {
	if (!rawFile?.trim()) return undefined;
	return path.resolve(cwd, rawFile.trim());
}

function resolveOutputPath(options: {
	rawOutputPath?: string;
	cwd: string;
	outputSlug?: string;
	refinedRequestFile?: string;
	investigationRequest: string;
}): string {
	if (options.rawOutputPath?.trim()) return path.resolve(options.cwd, options.rawOutputPath.trim());
	const slug = options.outputSlug?.trim()
		? slugify(options.outputSlug.trim())
		: slugFromRefinedRequestFile(options.refinedRequestFile) ?? slugify(options.investigationRequest);
	return path.join(options.cwd, "docs", "reference", `investigation-${slug}.md`);
}

function extractResearchNeeded(outputPath: string): "Yes" | "No" | "Unknown" {
	try {
		const content = fs.readFileSync(outputPath, "utf8");
		const match = content.match(/\*\*Research needed\*\*:\s*(Yes|No)\b/i);
		if (!match) return "Unknown";
		return match[1].toLowerCase() === "yes" ? "Yes" : "No";
	} catch {
		return "Unknown";
	}
}

function buildTask(options: {
	investigationRequest: string;
	cwd: string;
	outputPath: string;
	refinedRequestFile?: string;
	codebaseScanFile?: string;
	additionalContext?: string;
}): string {
	const lines = [
		"Run an investigation using the investigator instructions in your system prompt.",
		"",
		"Launch inputs:",
		`- cwd: ${options.cwd}`,
		`- output_path: ${options.outputPath}`,
		`- refined_request_file: ${options.refinedRequestFile ?? "null"}`,
		`- codebase_scan_file: ${options.codebaseScanFile ?? "null"}`,
		"",
		"Investigation request:",
		options.investigationRequest,
	];

	if (options.additionalContext?.trim()) {
		lines.push("", "Additional context from parent agent:", options.additionalContext.trim());
	}

	lines.push(
		"",
		"Requirements:",
		"- Treat cwd as the project root and write exactly one investigation document at output_path.",
		"- If refined_request_file is not null, read it first and treat it as authoritative for scope and acceptance criteria.",
		"- If codebase_scan_file is not null, read it to understand existing project architecture and integration context.",
		"- Include the required Technical Research Guidance section with exactly one line: **Research needed**: Yes or **Research needed**: No.",
		"- If external web or documentation lookup tools are unavailable, document that limitation in Context and References rather than fabricating sources.",
		"- Return the concise caller report specified in your output_format section after writing the file.",
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
	const args = ["--mode", "json", "-p", "--no-session", "--no-skills", "--tools", CHILD_TOOLS, "--append-system-prompt", options.promptPath];
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

			if (event.type === "tool_result_end" && event.toolName === "contact_supervisor") {
				const evidence = formatSupervisorReplyEvidence(event);
				if (evidence) options.onText?.(evidence);
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
			if (wasAborted && !stderr.includes("aborted")) stderr += "Child Pi investigator process aborted by parent signal.\n";
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

export default function investigatorSubagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Investigator Subagent",
		description:
			"Delegate option discovery, trade-off comparison, and approach recommendation to an isolated Pi investigator subagent. The subagent writes docs/reference/investigation-<slug>.md and returns the output path plus the Research needed flag.",
		promptSnippet:
			"Investigate available approaches, compare options, recommend a best-fit approach, and write docs/reference/investigation-<slug>.md with a parseable Research needed flag.",
		promptGuidelines: [
			"Use investigator_subagent after request refinement when multiple approaches, tools, platforms, or patterns could satisfy the request.",
			"Pass refined_request_file and codebase_scan_file to investigator_subagent when available so recommendations are grounded in scope and project context.",
		],
		parameters: Type.Object({
			investigation_request: Type.String({ description: "The question, decision, option landscape, or approach area to investigate." }),
			cwd: Type.Optional(
				Type.String({ description: "Optional working directory/project root for the child investigator process. Defaults to the current Pi working directory." }),
			),
			refined_request_file: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path to a refined request specification. If supplied, it must exist." }),
			),
			codebase_scan_file: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path to a codebase scan document. If supplied, it must exist." }),
			),
			output_path: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path for the investigation markdown output. Defaults to docs/reference/investigation-<slug>.md." }),
			),
			output_slug: Type.Optional(
				Type.String({ description: "Optional lowercase hyphenated slug used when output_path is omitted." }),
			),
			additional_context: Type.Optional(
				Type.String({ description: "Optional extra context, constraints, or known limitations from the parent agent." }),
			),
			model: Type.Optional(
				Type.String({ description: "Optional Pi model selector for the child process. Defaults to the calling agent's current model; use \"same\" or omit to forward the caller model." }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const investigationRequest = params.investigation_request?.trim();
			if (!investigationRequest) {
				return {
					content: [{ type: "text", text: "Missing required parameter: investigation_request." }],
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

			const cwd = resolveCwd(params.cwd, ctx.cwd);
			if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
				return {
					content: [{ type: "text", text: `Working directory does not exist or is not a directory: ${cwd}` }],
					isError: true,
				};
			}

			const refinedRequestFile = resolveOptionalFile(params.refined_request_file, cwd);
			if (refinedRequestFile && (!fs.existsSync(refinedRequestFile) || !fs.statSync(refinedRequestFile).isFile())) {
				return {
					content: [{ type: "text", text: `refined_request_file does not exist or is not a file: ${refinedRequestFile}` }],
					isError: true,
				};
			}

			const codebaseScanFile = resolveOptionalFile(params.codebase_scan_file, cwd);
			if (codebaseScanFile && (!fs.existsSync(codebaseScanFile) || !fs.statSync(codebaseScanFile).isFile())) {
				return {
					content: [{ type: "text", text: `codebase_scan_file does not exist or is not a file: ${codebaseScanFile}` }],
					isError: true,
				};
			}

			const outputPath = resolveOutputPath({
				rawOutputPath: params.output_path,
				cwd,
				outputSlug: params.output_slug,
				refinedRequestFile,
				investigationRequest,
			});
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });

			const task = buildTask({
				investigationRequest,
				cwd,
				outputPath,
				refinedRequestFile,
				codebaseScanFile,
				additionalContext: params.additional_context,
			});
			const childModel = resolveChildModelSelector(params.model, ctx.model);
			const runId = randomUUID();
			const childIndex = 0;
			const orchestratorTarget = resolveIntercomSessionTarget(pi.getSessionName(), ctx.sessionManager.getSessionId());
			const childSessionName = resolveSubagentIntercomTarget(runId, CHILD_AGENT_NAME, childIndex);
			const intercomBridge = {
				orchestratorTarget,
				runId,
				childAgent: CHILD_AGENT_NAME,
				childIndex,
				childSessionName,
			};

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Starting investigator subagent. Output: ${outputPath}${childModel ? ` Model: ${childModel}.` : ""} Supervisor target: ${orchestratorTarget}. Child intercom session: ${childSessionName}.`,
					},
				],
			});

			const result = await runChildPi({
				promptPath,
				task,
				cwd,
				model: childModel,
				intercomBridge,
				signal,
				onText: (text) => onUpdate?.({ content: [{ type: "text", text }] }),
			});

			const researchNeeded = extractResearchNeeded(outputPath);
			if (result.exitCode !== 0 || !result.finalText.trim() || !fs.existsSync(outputPath) || researchNeeded === "Unknown") {
				const diagnostics = [
					`Investigator subagent failed with exit code ${result.exitCode}.`,
					!fs.existsSync(outputPath) ? `Expected output file was not created: ${outputPath}` : "",
					researchNeeded === "Unknown" && fs.existsSync(outputPath)
						? `Expected parseable Research needed flag was not found in: ${outputPath}`
						: "",
					result.stderr.trim() ? `stderr:\n${tailText(result.stderr.trim(), DIAGNOSTIC_TEXT_CAP)}` : "",
					!result.finalText.trim() && result.stdout.trim() ? `stdout:\n${tailText(result.stdout.trim(), DIAGNOSTIC_TEXT_CAP)}` : "",
				]
					.filter(Boolean)
					.join("\n\n");

				return {
					content: [{ type: "text", text: diagnostics }],
					details: {
						cwd,
						refinedRequestFile,
						codebaseScanFile,
						outputPath,
						promptPath,
						childModel,
						observedModel: result.observedModel,
						intercomBridge,
						exitCode: result.exitCode,
						stderr: tailText(result.stderr, DIAGNOSTIC_TEXT_CAP),
						messageCount: result.messages.length,
						researchNeeded,
					},
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: truncateText(result.finalText, FINAL_TEXT_CAP) }],
				details: {
					cwd,
					refinedRequestFile,
					codebaseScanFile,
					outputPath,
					promptPath,
					childModel,
					observedModel: result.observedModel,
					intercomBridge,
					exitCode: result.exitCode,
					messageCount: result.messages.length,
					researchNeeded,
				},
			};
		},
	});
}
