import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "technical_researcher_subagent";
const PROMPT_FILE = "technical-researcher-agent.md";
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
			onUpdate?.({ content: [{ type: "text", text: `Starting technical-researcher subagent. Output: ${outputPath}` }] });

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
					`Technical-researcher subagent failed with exit code ${result.exitCode}.`,
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
						investigationFile,
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
					investigationFile,
					outputPath,
					promptPath,
					exitCode: result.exitCode,
					messageCount: result.messages.length,
				},
			};
		},
	});
}
