import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "technical_researcher_subagent";
const PROMPT_FILE = "technical-researcher-agent.md";
const CHILD_TOOLS = "read,write,grep,find,ls,bash,contact_supervisor,intercom";
const CHILD_AGENT_NAME = "technical-researcher";
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
		throw new Error(`Technical researcher subagent prompt file is missing: ${promptPath}`);
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
		`Technical researcher called contact_supervisor with reason=${reason}.`,
		"The technical researcher is paused waiting for the supervisor reply; this is expected for need_decision/interview_request.",
		bridge ? `Supervisor target: ${bridge.orchestratorTarget}` : undefined,
		bridge ? `Child intercom session: ${bridge.childSessionName}` : undefined,
		"Reply from the parent Pi session with the immediate slash command:",
		"/intercom-reply <your decision>",
		"",
		"Do not type a normal steering message like 'reply to the technical researcher...': steering is queued until the current technical_researcher_subagent tool finishes, so it cannot unblock the waiting child.",
		"If the agent is already idle, the regular tool form also works: intercom({ action: \"reply\", message: \"<your decision>\" })",
		"",
		"Technical researcher message:",
		message,
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

function formatSupervisorReplyEvidence(event: JsonEvent): string | undefined {
	if (event.toolName !== "contact_supervisor") return undefined;
	const candidate = event.message ?? event.result ?? event.output;
	const text = messageToText(candidate).trim() || (typeof candidate === "string" ? candidate.trim() : "");
	if (!text) return "Technical researcher contact_supervisor call completed; supervisor reply was delivered to the child.";
	return `Technical researcher contact_supervisor completed. Child-visible result:\n${truncateText(text, 2000)}`;
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
		.slice(0, 8)
		.join("-");
	return slug || "technical-topic";
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

function resolveOutputPath(rawOutputPath: string | undefined, cwd: string, topic: string): string {
	if (rawOutputPath?.trim()) return path.resolve(cwd, rawOutputPath.trim());
	return path.join(cwd, "docs", "research", `${slugify(topic)}.md`);
}

function buildTask(options: {
	topic: string;
	cwd: string;
	outputPath: string;
	whyNeeded?: string;
	focusAreas?: string[];
	depthLevel?: string;
	investigationFile?: string;
}): string {
	const lines = [
		"Run technical research using the technical-researcher instructions in your system prompt.",
		"",
		"Launch inputs:",
		`- cwd: ${options.cwd}`,
		`- output_path: ${options.outputPath}`,
		`- topic: ${options.topic}`,
		`- depth_level: ${options.depthLevel?.trim() || "Intermediate"}`,
		`- investigation_file: ${options.investigationFile ?? "null"}`,
		`- why_needed: ${options.whyNeeded?.trim() || "null"}`,
		`- focus_areas: ${options.focusAreas && options.focusAreas.length > 0 ? options.focusAreas.join("; ") : "null"}`,
		"",
		"Requirements:",
		"- Treat cwd as the project root and write exactly one main technical research document at output_path.",
		"- If investigation_file is not null, read it first and align the research with the matching Technical Research Guidance topic when present.",
		"- Cover every focus area explicitly when focus_areas are supplied.",
		"- Include assumptions, uncertainties/gaps, clarifying questions, and references in the output document and final report.",
		"- If external web, Context7, or documentation lookup tools are unavailable, document that limitation instead of fabricating sources.",
		"- Return the concise caller report specified in your output_requirements section after writing the file.",
	];
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
			if (wasAborted && !stderr.includes("aborted")) stderr += "Child Pi technical-researcher process aborted by parent signal.\n";
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

export default function technicalResearcherSubagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Technical Researcher Subagent",
		description:
			"Delegate implementation-level technical research on a chosen technology, API, library, SDK, protocol, platform, framework, or pattern to an isolated Pi subagent. The subagent writes docs/research/<topic>.md and returns the saved file path plus sources, assumptions, uncertainties, and follow-up questions.",
		promptSnippet:
			"Create source-backed technical research for a specific implementation topic and write docs/research/<topic-slug>.md via an isolated subagent.",
		promptGuidelines: [
			"Use technical_researcher_subagent after investigator_subagent recommends technical research for a specific topic, or when the user directly asks for implementation-level technical documentation.",
			"Pass investigation_file to technical_researcher_subagent when the topic came from an investigation document so research stays aligned with the selected approach.",
		],
		parameters: Type.Object({
			topic: Type.String({ description: "Exact technology, library, API, SDK, protocol, platform, framework, or implementation pattern to research." }),
			why_needed: Type.Optional(
				Type.String({ description: "Optional explanation of what decision or implementation detail depends on this research." }),
			),
			focus_areas: Type.Optional(
				Type.Array(Type.String(), { description: "Optional specific aspects to investigate, such as APIs, setup, configuration, security, testing, error handling, or examples." }),
			),
			depth_level: Type.Optional(
				Type.Union([Type.Literal("Overview"), Type.Literal("Intermediate"), Type.Literal("Deep dive")], {
					description: "Optional research depth. Defaults to Intermediate.",
				}),
			),
			investigation_file: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path to the investigation document that identified this topic. If supplied, it must exist." }),
			),
			output_path: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path for the research markdown output. Defaults to docs/research/<topic-slug>.md." }),
			),
			cwd: Type.Optional(
				Type.String({ description: "Optional working directory/project root for the child technical researcher process. Defaults to the current Pi working directory." }),
			),
			model: Type.Optional(
				Type.String({ description: "Optional Pi model selector for the child process. Defaults to the calling agent's current model; use \"same\" or omit to forward the caller model." }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const topic = params.topic?.trim();
			if (!topic) {
				return {
					content: [{ type: "text", text: "Missing required parameter: topic." }],
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

			const investigationFile = resolveOptionalFile(params.investigation_file, cwd);
			if (investigationFile && (!fs.existsSync(investigationFile) || !fs.statSync(investigationFile).isFile())) {
				return {
					content: [{ type: "text", text: `investigation_file does not exist or is not a file: ${investigationFile}` }],
					isError: true,
				};
			}

			const outputPath = resolveOutputPath(params.output_path, cwd, topic);
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });

			const focusAreas = Array.isArray(params.focus_areas)
				? params.focus_areas.map((area: string) => area.trim()).filter(Boolean)
				: undefined;

			const task = buildTask({
				topic,
				cwd,
				outputPath,
				whyNeeded: params.why_needed,
				focusAreas,
				depthLevel: params.depth_level,
				investigationFile,
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
						text: `Starting technical-researcher subagent. Output: ${outputPath}${childModel ? ` Model: ${childModel}.` : ""} Supervisor target: ${orchestratorTarget}. Child intercom session: ${childSessionName}.`,
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

			if (result.exitCode !== 0 || !result.finalText.trim() || !fs.existsSync(outputPath)) {
				const diagnostics = [
					`Technical-researcher subagent failed with exit code ${result.exitCode}.`,
					!fs.existsSync(outputPath) ? `Expected output file was not created: ${outputPath}` : "",
					result.stderr.trim() ? `stderr:\n${tailText(result.stderr.trim(), DIAGNOSTIC_TEXT_CAP)}` : "",
					!result.finalText.trim() && result.stdout.trim() ? `stdout:\n${tailText(result.stdout.trim(), DIAGNOSTIC_TEXT_CAP)}` : "",
				]
					.filter(Boolean)
					.join("\n\n");

				return {
					content: [{ type: "text", text: diagnostics }],
					details: {
						cwd,
						investigationFile,
						outputPath,
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
					cwd,
					investigationFile,
					outputPath,
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
