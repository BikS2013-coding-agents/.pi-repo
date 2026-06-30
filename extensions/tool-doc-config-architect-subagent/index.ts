import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const TOOL_NAME = "tool_doc_config_architect_subagent";
const PROMPT_FILE = "tool-doc-config-architect-agent.md";
const CHILD_TOOLS = "read,write,edit,grep,find,ls,bash";

type Mode = "scaffold" | "audit";
type LlmRequired = "yes" | "no";

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
		throw new Error(`Tool doc config architect subagent prompt file is missing: ${promptPath}`);
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

function resolveChildModelSelector(rawModel: string | undefined, currentModel: { provider?: string; id?: string } | undefined): string | undefined {
	const requested = rawModel?.trim();
	if (requested && !["same", "current", "caller", "calling-agent", "same-as-calling-agent"].includes(requested.toLowerCase())) {
		return requested;
	}
	if (currentModel?.provider && currentModel?.id) {
		return `${currentModel.provider}/${currentModel.id}`;
	}
	return undefined;
}

function resolveProjectRoot(rawProjectRoot: string | undefined, fallback: string): string {
	return path.resolve(rawProjectRoot?.trim() || fallback);
}

function validateToolName(toolName: string | undefined): string {
	const trimmed = toolName?.trim();
	if (!trimmed) throw new Error("Missing required parameter: tool_name.");
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
		throw new Error(`tool_name must be lowercase-with-hyphens: ${trimmed}`);
	}
	return trimmed;
}

function validateMode(mode: string | undefined): Mode {
	if (mode === "scaffold" || mode === "audit") return mode;
	throw new Error("Missing or invalid required parameter: mode. Expected 'scaffold' or 'audit'.");
}

function validateLlmRequired(value: string | undefined, mode: Mode): LlmRequired | undefined {
	if (mode === "audit" && !value?.trim()) return undefined;
	if (value === "yes" || value === "no") return value;
	throw new Error("Missing or invalid required parameter for scaffold mode: llm_required. Expected 'yes' or 'no'.");
}

function validateScaffoldRequired(value: string | undefined, name: string, mode: Mode): string | undefined {
	const trimmed = value?.trim();
	if (mode === "scaffold" && !trimmed) throw new Error(`Missing required parameter for scaffold mode: ${name}.`);
	return trimmed;
}

function formatExtraConfigVars(extraConfigVars: Array<{ name: string; purpose: string }> | undefined): string {
	if (!Array.isArray(extraConfigVars) || extraConfigVars.length === 0) return "[]";
	return extraConfigVars
		.map((item) => `- name: ${item.name}\n  purpose: ${item.purpose}`)
		.join("\n");
}

function buildTask(options: {
	mode: Mode;
	toolName: string;
	projectRoot: string;
	toolDescription?: string;
	toolCommand?: string;
	llmRequired?: LlmRequired;
	extraConfigVars?: Array<{ name: string; purpose: string }>;
}): string {
	const lines = [
		"Run the tool-doc-config-architect workflow using the instructions in your system prompt.",
		"",
		"Launch inputs:",
		`- mode: ${options.mode}`,
		`- tool_name: ${options.toolName}`,
		`- project_root: ${options.projectRoot}`,
		`- tool_description: ${options.toolDescription ?? "null"}`,
		`- tool_command: ${options.toolCommand ?? "null"}`,
		`- llm_required: ${options.llmRequired ?? "null"}`,
		"- extra_config_vars:",
		formatExtraConfigVars(options.extraConfigVars),
		"",
		"Requirements:",
		"- Treat project_root as the target project root.",
		"- Preserve audit mode as strictly read-only.",
		"- Never modify CLAUDE.md; provide only a recommended Tools section entry in the report.",
		"- Never print secret values; report environment variable names only.",
		"- Return exactly one markdown report in the prescribed output format.",
	];
	return lines.join("\n");
}

async function runChildPi(options: {
	promptPath: string;
	task: string;
	cwd: string;
	model?: string;
	signal?: AbortSignal;
	onText?: (text: string) => void;
}): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	messages: MessageLike[];
	finalText: string;
}> {
	const args = ["--mode", "json", "-p", "--no-session", "--tools", CHILD_TOOLS, "--append-system-prompt", options.promptPath];
	if (options.model?.trim()) args.push("--model", options.model.trim());
	args.push(options.task);

	return await new Promise((resolve) => {
		const child = spawn("pi", args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let lineBuffer = "";
		const messages: MessageLike[] = [];
		let finalText = "";
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

			if (event.type === "message_end" && event.message && typeof event.message === "object") {
				const message = event.message as MessageLike;
				messages.push(message);
				if (message.role === "assistant") {
					const text = messageToText(message).trim();
					if (text) {
						finalText = text;
						options.onText?.(text);
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
			if (wasAborted && !stderr.includes("aborted")) stderr += "Child Pi process aborted by parent signal.\n";
			resolve({ exitCode: code ?? 1, stdout, stderr, messages, finalText });
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

export default function toolDocConfigArchitectSubagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Tool Doc Config Architect Subagent",
		description:
			"Delegate TypeScript CLI tool documentation/config scaffolding or read-only convention auditing to an isolated Pi subagent. Supports scaffold and audit modes for docs/tools/<name>.md, ~/.tool-agents/<name>/, env-var conventions, provider support, and no-fallback compliance.",
		promptSnippet:
			"Scaffold or audit a project tool's documentation and configuration conventions through an isolated subagent without modifying CLAUDE.md.",
		promptGuidelines: [
			"Use tool_doc_config_architect_subagent when a user asks to scaffold tool documentation/configuration or audit an existing tool against project tool conventions.",
			"Use audit mode for read-only checks; use scaffold mode only when the required tool description, command, and LLM requirement are known.",
		],
		parameters: Type.Object({
			mode: StringEnum(["scaffold", "audit"] as const, { description: "Mode to run: scaffold writes tool docs/config artifacts; audit is read-only." }),
			tool_name: Type.String({ description: "Tool name in lowercase-with-hyphens." }),
			project_root: Type.Optional(
				Type.String({ description: "Absolute or cwd-relative path to the project root. Defaults to the current Pi working directory." }),
			),
			tool_description: Type.Optional(
				Type.String({ description: "One-or-two-sentence summary of what the tool does. Required for scaffold mode." }),
			),
			tool_command: Type.Optional(
				Type.String({ description: "Exact CLI command users will run. Required for scaffold mode." }),
			),
			llm_required: Type.Optional(
				StringEnum(["yes", "no"] as const, { description: "Whether the tool talks to LLM providers. Required for scaffold mode." }),
			),
			extra_config_vars: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "Configuration variable name." }),
						purpose: Type.String({ description: "Purpose of this configuration variable." }),
					}),
					{ description: "Optional non-LLM configuration variables needed by the tool." },
				),
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

			let mode: Mode;
			let toolName: string;
			let llmRequired: LlmRequired | undefined;
			let toolDescription: string | undefined;
			let toolCommand: string | undefined;
			try {
				mode = validateMode(params.mode);
				toolName = validateToolName(params.tool_name);
				llmRequired = validateLlmRequired(params.llm_required, mode);
				toolDescription = validateScaffoldRequired(params.tool_description, "tool_description", mode);
				toolCommand = validateScaffoldRequired(params.tool_command, "tool_command", mode);
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
				};
			}

			const projectRoot = resolveProjectRoot(params.project_root, ctx.cwd);
			if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
				return {
					content: [{ type: "text", text: `project_root does not exist or is not a directory: ${projectRoot}` }],
					isError: true,
				};
			}

			const task = buildTask({
				mode,
				toolName,
				projectRoot,
				toolDescription,
				toolCommand,
				llmRequired,
				extraConfigVars: params.extra_config_vars,
			});
			onUpdate?.({ content: [{ type: "text", text: `Starting tool-doc-config-architect subagent in ${mode} mode for ${toolName}.` }] });

			const result = await runChildPi({
				promptPath,
				task,
				cwd: projectRoot,
				model: resolveChildModelSelector(params.model, ctx.model),
				signal,
				onText: (text) => onUpdate?.({ content: [{ type: "text", text }] }),
			});

			if (result.exitCode !== 0 || !result.finalText.trim()) {
				const diagnostics = [
					`Tool-doc-config-architect subagent failed with exit code ${result.exitCode}.`,
					result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
					!result.finalText.trim() && result.stdout.trim() ? `stdout:\n${result.stdout.trim().slice(-4000)}` : "",
				]
					.filter(Boolean)
					.join("\n\n");

				return {
					content: [{ type: "text", text: diagnostics }],
					details: {
						mode,
						toolName,
						projectRoot,
						promptPath,
						exitCode: result.exitCode,
						stderr: result.stderr,
						messageCount: result.messages.length,
					},
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: result.finalText }],
				details: {
					mode,
					toolName,
					projectRoot,
					promptPath,
					exitCode: result.exitCode,
					messageCount: result.messages.length,
				},
			};
		},
	});
}
