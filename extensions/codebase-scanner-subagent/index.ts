import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "codebase_scanner_subagent";
const PROMPT_FILE = "codebase-scanner-agent.md";
const CHILD_TOOLS = "read,write,grep,find,ls,bash";

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
		throw new Error(`Codebase scanner subagent prompt file is missing: ${promptPath}`);
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

function requestSlugFromFile(requestFile?: string): string {
	if (!requestFile?.trim()) return "general";
	const base = path.basename(requestFile.trim()).replace(/\.md$/i, "");
	const withoutPrefix = base.replace(/^refined-request-/i, "");
	const slug = withoutPrefix
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "general";
}

function resolveCwd(rawCwd: string | undefined, fallback: string): string {
	return path.resolve(rawCwd?.trim() || fallback);
}

function resolveRequestFile(rawRequestFile: string | undefined, cwd: string): string | undefined {
	if (!rawRequestFile?.trim()) return undefined;
	return path.resolve(cwd, rawRequestFile.trim());
}

function resolveOutputPath(rawOutputPath: string | undefined, cwd: string, requestFile?: string): string {
	if (rawOutputPath?.trim()) return path.resolve(cwd, rawOutputPath.trim());
	return path.join(cwd, "docs", "reference", `codebase-scan-${requestSlugFromFile(requestFile)}.md`);
}

function buildTask(options: { cwd: string; requestFile?: string; outputPath: string }): string {
	const lines = [
		"Run a codebase scan using the codebase-scanner instructions in your system prompt.",
		"",
		"Launch inputs:",
		`- cwd: ${options.cwd}`,
		`- output_path: ${options.outputPath}`,
		`- request_file: ${options.requestFile ?? "null"}`,
		"",
		"Requirements:",
		"- Treat cwd as the project root and write exactly one scan file at output_path.",
		"- If request_file is not null, read it and apply request-driven narrowing.",
		"- If request_file is null, produce a request-agnostic overview and omit the Integration Points section.",
		"- Return the concise caller report specified in your output_format section after writing the file.",
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

export default function codebaseScannerSubagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Codebase Scanner Subagent",
		description:
			"Delegate codebase scanning to an isolated Pi subagent. The subagent writes a concise markdown codebase overview with YAML frontmatter metadata, module map, conventions, and optional request-specific integration points.",
		promptSnippet:
			"Scan a repository and write docs/reference/codebase-scan-<slug>.md with metadata, module map, conventions, and request-specific integration points when a refined request is supplied.",
		promptGuidelines: [
			"Use codebase_scanner_subagent when downstream planning, design, implementation, or verification needs a concise codebase context document.",
			"Pass request_file to codebase_scanner_subagent when scanning for a specific refined request so integration points are narrowed to that scope.",
		],
		parameters: Type.Object({
			request_file: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path to a refined request specification. If supplied, it must exist." }),
			),
			output_path: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path for the scan markdown output. Defaults to docs/reference/codebase-scan-<slug>.md." }),
			),
			cwd: Type.Optional(
				Type.String({ description: "Optional working directory/project root for the child scanner process. Defaults to the current Pi working directory." }),
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

			const cwd = resolveCwd(params.cwd, ctx.cwd);
			if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
				return {
					content: [{ type: "text", text: `Working directory does not exist or is not a directory: ${cwd}` }],
					isError: true,
				};
			}

			const requestFile = resolveRequestFile(params.request_file, cwd);
			if (requestFile && (!fs.existsSync(requestFile) || !fs.statSync(requestFile).isFile())) {
				return {
					content: [{ type: "text", text: `request_file does not exist or is not a file: ${requestFile}` }],
					isError: true,
				};
			}

			const outputPath = resolveOutputPath(params.output_path, cwd, requestFile);
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });

			const task = buildTask({ cwd, requestFile, outputPath });
			onUpdate?.({ content: [{ type: "text", text: `Starting codebase-scanner subagent. Output: ${outputPath}` }] });

			const result = await runChildPi({
				promptPath,
				task,
				cwd,
				model: resolveChildModelSelector(params.model, ctx.model),
				signal,
				onText: (text) => onUpdate?.({ content: [{ type: "text", text }] }),
			});

			if (result.exitCode !== 0 || !result.finalText.trim() || !fs.existsSync(outputPath)) {
				const diagnostics = [
					`Codebase-scanner subagent failed with exit code ${result.exitCode}.`,
					!fs.existsSync(outputPath) ? `Expected output file was not created: ${outputPath}` : "",
					result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
					!result.finalText.trim() && result.stdout.trim() ? `stdout:\n${result.stdout.trim().slice(-4000)}` : "",
				]
					.filter(Boolean)
					.join("\n\n");

				return {
					content: [{ type: "text", text: diagnostics }],
					details: {
						cwd,
						requestFile,
						outputPath,
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
					cwd,
					requestFile,
					outputPath,
					promptPath,
					exitCode: result.exitCode,
					messageCount: result.messages.length,
					requestDrivenNarrowing: Boolean(requestFile),
				},
			};
		},
	});
}
