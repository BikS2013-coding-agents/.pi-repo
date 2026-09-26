import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const TOOL_NAME = "dependency_validator_subagent";
const PROMPT_FILE = "dependency-validator-agent.md";
const CHILD_TOOLS = "read,write,edit,grep,find,ls,bash,contact_supervisor,intercom";
const DEFAULT_MAX_ITERATIONS = 5;
const FINAL_TEXT_CAP = 24 * 1024;
const DIAGNOSTIC_TEXT_CAP = 6 * 1024;

const SAME_MODEL_ALIASES = new Set(["same", "current", "caller", "calling-agent", "same-as-calling-agent"]);
const DEFAULT_INTERCOM_TARGET_PREFIX = "subagent-chat";
const SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET";
const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
const SUBAGENT_CHILD_INDEX_ENV = "PI_SUBAGENT_CHILD_INDEX";
const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";

type ValidationMode = "report-only" | "fix" | "interactive";

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
		throw new Error(`Dependency-validator subagent prompt file is missing: ${promptPath}`);
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
		`Dependency-validator subagent called contact_supervisor with reason=${reason}.`,
		"The dependency-validator subagent is paused waiting for the supervisor reply; this is expected for need_decision/interview_request.",
		bridge ? `Supervisor target: ${bridge.orchestratorTarget}` : undefined,
		bridge ? `Child intercom session: ${bridge.childSessionName}` : undefined,
		"Reply from the parent Pi session with the immediate slash command:",
		'/intercom-reply <your decision>',
		"",
		"Do not type a normal steering message like 'reply to the dependency-validator...': steering is queued until the current dependency_validator_subagent tool finishes, so it cannot unblock the waiting child.",
		"If the agent is already idle, the regular tool form also works: intercom({ action: \"reply\", message: \"<your decision>\" })",
		"",
		"Dependency-validator message:",
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

function resolveTargetPath(rawTargetPath: string | undefined, fallback: string): string {
	return path.resolve(rawTargetPath?.trim() || fallback);
}

function resolveOptionalPath(rawPath: string | undefined, cwd: string): string | undefined {
	if (!rawPath?.trim()) return undefined;
	return path.resolve(cwd, rawPath.trim());
}

function safeTimestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveOutputPath(rawOutputPath: string | undefined, targetPath: string): string {
	if (rawOutputPath?.trim()) return path.resolve(targetPath, rawOutputPath.trim());
	return path.join(targetPath, "docs", "reference", `dependency-validation-${safeTimestamp()}.md`);
}

function buildTask(options: {
	targetPath: string;
	outputPath: string;
	requestFile?: string;
	mode: ValidationMode;
	maxIterations: number;
	includeSecurityAudit: boolean;
}): string {
	return [
		"Run the dependency-validator workflow exactly as specified in your system prompt.",
		"",
		"Launch inputs:",
		`- target_path: ${options.targetPath}`,
		`- output_path: ${options.outputPath}`,
		`- request_file: ${options.requestFile ?? "null"}`,
		`- mode: ${options.mode}`,
		`- max_iterations: ${options.maxIterations}`,
		`- include_security_audit: ${options.includeSecurityAudit}`,
		"",
		"Execution requirements:",
		"- Treat target_path as the project to validate and the working directory for package-manager commands.",
		"- If target_path does not exist, stop and report; do not proceed.",
		"- If request_file is not null but does not exist, log a warning in the report and proceed without it.",
		"- In report-only mode, preserve the read-only invariant: do not run install commands that mutate files; use dry-run or lockfile/manifests as described by your prompt.",
		"- Write exactly one markdown report at output_path, including all mandatory YAML frontmatter fields.",
		"- Return only the concise final caller summary required by your output_format section after writing the report.",
	].join("\n");
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
			if (wasAborted && !stderr.includes("aborted")) stderr += "Child Pi dependency-validator process aborted by parent signal.\n";
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

export default function dependencyValidatorSubagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Dependency Validator Subagent",
		description:
			"Delegate dependency hygiene validation to an isolated Pi subagent. The subagent detects deprecated packages and optional security advisories across Node and Python package managers, can run in report-only/fix/interactive mode, and writes a structured markdown report with mandatory YAML frontmatter.",
		promptSnippet:
			"Validate project dependencies for deprecated modules and security advisories through an isolated dependency-validator subagent.",
		promptGuidelines: [
			"Use dependency_validator_subagent for dependency hygiene checks, deprecated package detection, security advisory checks, or safe surgical dependency fixes.",
			"Pass mode: \"report-only\" to dependency_validator_subagent when the user only asks to inspect dependencies without modifying the project.",
			"Do not use dependency_validator_subagent for broad refactors or major-version migrations; it is a validator and surgical fixer only.",
		],
		parameters: Type.Object({
			target_path: Type.Optional(
				Type.String({ description: "Absolute or cwd-relative path to the project to validate. Defaults to the current Pi working directory." }),
			),
			output_path: Type.Optional(
				Type.String({ description: "Absolute or target_path-relative path where the markdown report should be written. Defaults to target_path/docs/reference/dependency-validation-<ISO-timestamp>.md." }),
			),
			request_file: Type.Optional(
				Type.String({ description: "Optional absolute or target_path-relative refined-request specification path for context. Missing files are warned about by the subagent, not fatal." }),
			),
			mode: Type.Optional(
				StringEnum(["report-only", "fix", "interactive"] as const, {
					description: "Validation mode. report-only never modifies the project; fix applies safe replacements; interactive writes a planned, unapplied fix plan.",
					default: "fix",
				}),
			),
			max_iterations: Type.Optional(
				Type.Number({ description: "Maximum validate-replace cycles. Defaults to 5. The subagent treats this as a hard cap.", default: DEFAULT_MAX_ITERATIONS }),
			),
			include_security_audit: Type.Optional(
				Type.Boolean({ description: "Whether to run the package manager's security audit command where supported. Defaults to true.", default: true }),
			),
			model: Type.Optional(
				Type.String({ description: "Optional Pi model selector for the child process. Defaults to the calling agent's current model; use \"same\" or omit to forward the caller model." }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let promptPath: string;
			try {
				promptPath = requirePromptPath();
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
				};
			}

			const targetPath = resolveTargetPath(params.target_path, ctx.cwd);
			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return {
					content: [{ type: "text", text: `target_path does not exist or is not a directory: ${targetPath}` }],
					isError: true,
				};
			}

			const outputPath = resolveOutputPath(params.output_path, targetPath);
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });

			const requestFile = resolveOptionalPath(params.request_file, targetPath);
			const mode = (params.mode ?? "fix") as ValidationMode;
			const maxIterations = Number.isFinite(params.max_iterations) && params.max_iterations > 0 ? Math.floor(params.max_iterations) : DEFAULT_MAX_ITERATIONS;
			const includeSecurityAudit = params.include_security_audit ?? true;

			const task = buildTask({
				targetPath,
				outputPath,
				requestFile,
				mode,
				maxIterations,
				includeSecurityAudit,
			});
			const childModel = resolveChildModelSelector(params.model, ctx.model);
			const runId = randomUUID();
			const childIndex = 0;
			const orchestratorTarget = resolveIntercomSessionTarget(pi.getSessionName(), ctx.sessionManager.getSessionId());
			const childSessionName = resolveSubagentIntercomTarget(runId, "dependency-validator", childIndex);
			const intercomBridge = {
				orchestratorTarget,
				runId,
				childAgent: "dependency-validator",
				childIndex,
				childSessionName,
			};

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Starting dependency-validator subagent. Output: ${outputPath}${childModel ? ` Model: ${childModel}.` : ""} Supervisor target: ${orchestratorTarget}.`,
					},
				],
			});

			const result = await runChildPi({
				promptPath,
				task,
				cwd: targetPath,
				model: childModel,
				intercomBridge,
				signal,
				onText: (text) => onUpdate?.({ content: [{ type: "text", text }] }),
			});

			if (result.exitCode !== 0 || !result.finalText.trim() || !fs.existsSync(outputPath)) {
				const diagnostics = [
					`Dependency-validator subagent failed with exit code ${result.exitCode}.`,
					!fs.existsSync(outputPath) ? `Expected output file was not created: ${outputPath}` : "",
					result.stderr.trim() ? `stderr:\n${tailText(result.stderr.trim(), DIAGNOSTIC_TEXT_CAP)}` : "",
					!result.finalText.trim() && result.stdout.trim() ? `stdout:\n${tailText(result.stdout.trim(), DIAGNOSTIC_TEXT_CAP)}` : "",
				]
					.filter(Boolean)
					.join("\n\n");

				return {
					content: [{ type: "text", text: diagnostics }],
					details: {
						targetPath,
						outputPath,
						requestFile,
						mode,
						maxIterations,
						includeSecurityAudit,
						promptPath,
						exitCode: result.exitCode,
						childModel,
						observedModel: result.observedModel,
						intercomBridge,
						stderr: tailText(result.stderr, DIAGNOSTIC_TEXT_CAP),
						messageCount: result.messages.length,
					},
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: truncateText(result.finalText, FINAL_TEXT_CAP) }],
				details: {
					targetPath,
					outputPath,
					requestFile,
					mode,
					maxIterations,
					includeSecurityAudit,
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
