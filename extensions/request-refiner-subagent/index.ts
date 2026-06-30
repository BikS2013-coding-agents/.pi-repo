import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "request_refiner_subagent";
const PROMPT_FILE = "request-refiner-agent.md";
const CHILD_TOOLS = "read,write,grep,find,ls";

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
			resolve({
				exitCode: code ?? 1,
				stdout,
				stderr,
				messages,
				finalText,
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
			onUpdate?.({ content: [{ type: "text", text: "Starting request-refiner subagent..." }] });

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
					`Request-refiner subagent failed with exit code ${result.exitCode}.`,
					result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
					!result.finalText.trim() && result.stdout.trim() ? `stdout:\n${result.stdout.trim().slice(-4000)}` : "",
				]
					.filter(Boolean)
					.join("\n\n");

				return {
					content: [{ type: "text", text: diagnostics }],
					details: {
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
					projectRoot,
					promptPath,
					exitCode: result.exitCode,
					messageCount: result.messages.length,
				},
			};
		},
	});
}
