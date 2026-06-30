import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "plan_builder_subagent";
const PROMPT_FILE = "plan-builder-agent.md";
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
		throw new Error(`Plan builder subagent prompt file is missing: ${promptPath}`);
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
		.slice(0, 6)
		.join("-");
	return slug || "implementation-plan";
}

function slugFromRequestFile(filePath: string): string {
	const base = path.basename(filePath).replace(/\.md$/i, "");
	return slugify(base.replace(/^refined-request-/i, ""));
}

function resolveCwd(rawCwd: string | undefined, fallback: string): string {
	return path.resolve(rawCwd?.trim() || fallback);
}

function resolveRequiredFile(rawFile: string | undefined, cwd: string, name: string): string {
	if (!rawFile?.trim()) throw new Error(`Missing required parameter: ${name}.`);
	const resolved = path.resolve(cwd, rawFile.trim());
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
		throw new Error(`${name} does not exist or is not a file: ${resolved}`);
	}
	return resolved;
}

function resolveOptionalFile(rawFile: string | undefined, cwd: string, name: string): string | undefined {
	if (!rawFile?.trim()) return undefined;
	const resolved = path.resolve(cwd, rawFile.trim());
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
		throw new Error(`${name} does not exist or is not a file: ${resolved}`);
	}
	return resolved;
}

function resolveResearchFiles(rawFiles: string[] | undefined, cwd: string): string[] {
	if (!Array.isArray(rawFiles)) return [];
	return rawFiles
		.map((file) => file?.trim())
		.filter(Boolean)
		.map((file, index) => resolveRequiredFile(file, cwd, `research_files[${index}]`));
}

function nextPlanNumber(cwd: string): string {
	const designDir = path.join(cwd, "docs", "design");
	let max = 0;
	try {
		for (const entry of fs.readdirSync(designDir)) {
			const match = entry.match(/^plan-(\d{3})-/i);
			if (match) max = Math.max(max, Number(match[1]));
		}
	} catch {
		return "001";
	}
	return String(max + 1).padStart(3, "0");
}

function resolveOutputPath(rawOutputPath: string | undefined, cwd: string, requestFile: string, outputSlug?: string): { outputPath: string; planNumber: string; slug: string } {
	const slug = outputSlug?.trim() ? slugify(outputSlug.trim()) : slugFromRequestFile(requestFile);
	let planNumber = nextPlanNumber(cwd);
	if (rawOutputPath?.trim()) {
		let resolved = path.resolve(cwd, rawOutputPath.trim());
		if (resolved.includes("NNN")) {
			planNumber = nextPlanNumber(cwd);
			resolved = resolved.replace(/NNN/g, planNumber);
		} else {
			const match = path.basename(resolved).match(/^plan-(\d{3})-/i);
			if (match) planNumber = match[1];
		}
		return { outputPath: resolved, planNumber, slug };
	}
	return { outputPath: path.join(cwd, "docs", "design", `plan-${planNumber}-${slug}.md`), planNumber, slug };
}

function buildTask(options: {
	cwd: string;
	requestFile: string;
	investigationFile?: string;
	researchFiles: string[];
	codebaseScanFile?: string;
	designFile?: string;
	outputPath: string;
	duplicationDirective?: string;
	originalRequest?: string;
}): string {
	const lines = [
		"Create one implementation plan using the plan-builder instructions in your system prompt.",
		"",
		"Launch inputs:",
		`- cwd: ${options.cwd}`,
		`- request_file: ${options.requestFile}`,
		`- investigation_file: ${options.investigationFile ?? "null"}`,
		`- research_files: ${options.researchFiles.length > 0 ? options.researchFiles.join("; ") : "[]"}`,
		`- codebase_scan_file: ${options.codebaseScanFile ?? "null"}`,
		`- design_file: ${options.designFile ?? "null"}`,
		`- output_path: ${options.outputPath}`,
		`- duplication_directive: ${options.duplicationDirective?.trim() || "null"}`,
		`- original_request: ${options.originalRequest?.trim() || "null"}`,
		"",
		"Requirements:",
		"- Treat request_file as authoritative for scope and acceptance criteria.",
		"- Write exactly one main plan file at output_path using the mandatory frontmatter and plan structure.",
		"- Do not modify source files. The only files you may write are output_path and project-functions if the plan introduces new functional requirements.",
		"- Use supplied investigation/research/scan/design files when present; if they conflict, flag the conflict in Risks and Open Questions rather than silently changing approach.",
		"- Include the Deviation Rules for Executors section with the solo-vs-parallel shared-file distinction.",
		"- Return the concise caller report specified in your output_format section after writing the plan.",
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

export default function planBuilderSubagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Plan Builder Subagent",
		description:
			"Delegate implementation-plan creation to an isolated Pi subagent. The subagent writes docs/design/plan-NNN-<slug>.md with mandatory YAML frontmatter, dependency-ordered atomic steps, implementation units, verification, risks, and acceptance-criteria mapping.",
		promptSnippet:
			"Create an executable implementation plan from a refined request and optional investigation, research, codebase scan, and design context.",
		promptGuidelines: [
			"Use plan_builder_subagent after request refinement and any needed scan/investigation/research artifacts are available, when downstream implementation needs an executable plan.",
			"Pass request_file to plan_builder_subagent; do not use it without a refined request specification.",
		],
		parameters: Type.Object({
			request_file: Type.String({ description: "Required absolute or cwd-relative path to the refined request specification. Must exist." }),
			investigation_file: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path to the investigation document. If supplied, it must exist." }),
			),
			research_files: Type.Optional(
				Type.Array(Type.String(), { description: "Optional list of absolute or cwd-relative paths to technical research documents. Each supplied file must exist." }),
			),
			codebase_scan_file: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path to the codebase scan document. If supplied, it must exist." }),
			),
			design_file: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path to project design documentation. If supplied, it must exist." }),
			),
			output_path: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path for the plan output. Defaults to docs/design/plan-NNN-<slug>.md." }),
			),
			output_slug: Type.Optional(
				Type.String({ description: "Optional lowercase hyphenated slug used when output_path is omitted." }),
			),
			duplication_directive: Type.Optional(
				Type.String({ description: "Optional binding instruction from duplication analysis, e.g. extend an existing module instead of creating a parallel implementation." }),
			),
			original_request: Type.Optional(
				Type.String({ description: "Optional raw user request text used as a drift guard." }),
			),
			cwd: Type.Optional(
				Type.String({ description: "Optional working directory/project root for the child plan-builder process. Defaults to the current Pi working directory." }),
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

			let requestFile: string;
			let investigationFile: string | undefined;
			let codebaseScanFile: string | undefined;
			let designFile: string | undefined;
			let researchFiles: string[];
			try {
				requestFile = resolveRequiredFile(params.request_file, cwd, "request_file");
				investigationFile = resolveOptionalFile(params.investigation_file, cwd, "investigation_file");
				codebaseScanFile = resolveOptionalFile(params.codebase_scan_file, cwd, "codebase_scan_file");
				designFile = resolveOptionalFile(params.design_file, cwd, "design_file");
				researchFiles = resolveResearchFiles(params.research_files, cwd);
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
				};
			}

			const { outputPath, planNumber, slug } = resolveOutputPath(params.output_path, cwd, requestFile, params.output_slug);
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });

			const task = buildTask({
				cwd,
				requestFile,
				investigationFile,
				researchFiles,
				codebaseScanFile,
				designFile,
				outputPath,
				duplicationDirective: params.duplication_directive,
				originalRequest: params.original_request,
			});
			onUpdate?.({ content: [{ type: "text", text: `Starting plan-builder subagent. Output: ${outputPath}` }] });

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
					`Plan-builder subagent failed with exit code ${result.exitCode}.`,
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
						investigationFile,
						researchFiles,
						codebaseScanFile,
						designFile,
						outputPath,
						planNumber,
						slug,
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
					investigationFile,
					researchFiles,
					codebaseScanFile,
					designFile,
					outputPath,
					planNumber,
					slug,
					promptPath,
					exitCode: result.exitCode,
					messageCount: result.messages.length,
				},
			};
		},
	});
}
