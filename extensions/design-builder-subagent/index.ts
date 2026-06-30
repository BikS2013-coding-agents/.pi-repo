import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "design_builder_subagent";
const PROMPT_FILE = "design-builder-agent.md";
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

type PlanMetadata = {
	planNumber?: string;
	slug?: string;
};

function extensionDir(): string {
	return __dirname;
}

function requirePromptPath(): string {
	const promptPath = path.join(extensionDir(), PROMPT_FILE);
	if (!fs.existsSync(promptPath)) {
		throw new Error(`Design builder subagent prompt file is missing: ${promptPath}`);
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
	return slug || "technical-design";
}

function normalizeDesignNumber(value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	const match = value.trim().match(/\d+/);
	if (!match) return undefined;
	return String(Number(match[0])).padStart(3, "0");
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

function resolveOptionalExistingFile(rawFile: string | undefined, cwd: string, name: string): string | undefined {
	if (!rawFile?.trim()) return undefined;
	const resolved = path.resolve(cwd, rawFile.trim());
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
		throw new Error(`${name} does not exist or is not a file: ${resolved}`);
	}
	return resolved;
}

function resolveOptionalWritableFile(rawFile: string | undefined, cwd: string): string | undefined {
	if (!rawFile?.trim()) return undefined;
	return path.resolve(cwd, rawFile.trim());
}

function resolveResearchFiles(rawFiles: string[] | undefined, cwd: string): string[] {
	if (!Array.isArray(rawFiles)) return [];
	return rawFiles
		.map((file) => file?.trim())
		.filter(Boolean)
		.map((file, index) => resolveRequiredFile(file, cwd, `research_files[${index}]`));
}

function parsePlanMetadata(planFile: string): PlanMetadata {
	let text = "";
	try {
		text = fs.readFileSync(planFile, "utf8");
	} catch {
		return {};
	}
	if (!text.startsWith("---")) return {};
	const end = text.indexOf("\n---", 3);
	if (end === -1) return {};
	const frontmatter = text.slice(3, end);
	const planNumber = normalizeDesignNumber(frontmatter.match(/^\s*plan_number\s*:\s*["']?([^"'\n#]+)/im)?.[1]);
	const rawSlug = frontmatter.match(/^\s*slug\s*:\s*["']?([^"'\n#]+)/im)?.[1]?.trim();
	const slug = rawSlug ? slugify(rawSlug) : undefined;
	return { planNumber, slug };
}

function nextDesignNumber(cwd: string): string {
	const designDir = path.join(cwd, "docs", "design");
	let max = 0;
	try {
		for (const entry of fs.readdirSync(designDir)) {
			const match = entry.match(/^design-(\d{3})-/i);
			if (match) max = Math.max(max, Number(match[1]));
		}
	} catch {
		return "001";
	}
	return String(max + 1).padStart(3, "0");
}

function resolveOutputPath(
	rawOutputPath: string | undefined,
	cwd: string,
	requestFile: string,
	planFile: string,
	outputSlug?: string,
): { outputPath: string; designNumber: string; slug: string; metadataSource: "plan" | "fallback" } {
	const metadata = parsePlanMetadata(planFile);
	const metadataSource = metadata.planNumber || metadata.slug ? "plan" : "fallback";
	let designNumber = metadata.planNumber ?? nextDesignNumber(cwd);
	const slug = outputSlug?.trim() ? slugify(outputSlug.trim()) : metadata.slug ?? slugFromRequestFile(requestFile);

	if (rawOutputPath?.trim()) {
		let resolved = path.resolve(cwd, rawOutputPath.trim());
		if (resolved.includes("NNN")) {
			resolved = resolved.replace(/NNN/g, designNumber);
		} else {
			const match = path.basename(resolved).match(/^design-(\d{3})-/i);
			if (match) designNumber = match[1];
		}
		return { outputPath: resolved, designNumber, slug, metadataSource };
	}

	return {
		outputPath: path.join(cwd, "docs", "design", `design-${designNumber}-${slug}.md`),
		designNumber,
		slug,
		metadataSource,
	};
}

function buildTask(options: {
	cwd: string;
	requestFile: string;
	planFile: string;
	investigationFile?: string;
	researchFiles: string[];
	codebaseScanFile?: string;
	projectDesignFile: string;
	outputPath: string;
	integrationDirective?: string;
	resolvedOpenQuestions?: string;
	originalRequest?: string;
}): string {
	const lines = [
		"Create one technical design using the design-builder instructions in your system prompt.",
		"",
		"Launch inputs:",
		`- cwd: ${options.cwd}`,
		`- request_file: ${options.requestFile}`,
		`- plan_file: ${options.planFile}`,
		`- investigation_file: ${options.investigationFile ?? "null"}`,
		`- research_files: ${options.researchFiles.length > 0 ? options.researchFiles.join("; ") : "[]"}`,
		`- codebase_scan_file: ${options.codebaseScanFile ?? "null"}`,
		`- project_design_file: ${options.projectDesignFile}`,
		`- output_path: ${options.outputPath}`,
		`- integration_directive: ${options.integrationDirective?.trim() || "null"}`,
		`- resolved_open_questions: ${options.resolvedOpenQuestions?.trim() || "null"}`,
		`- original_request: ${options.originalRequest?.trim() || "null"}`,
		"",
		"Requirements:",
		"- Treat request_file and plan_file as authoritative. If they conflict, preserve the plan/request scope and flag the conflict in Risks and in the final report.",
		"- Write exactly one per-request technical design file at output_path using the mandatory frontmatter and design structure.",
		"- Update project_design_file as the cumulative living project design document; create it if it does not exist.",
		"- Do not modify production/source files. The only files you may write are output_path and project_design_file.",
		"- Preserve the plan's implementation-unit partition unless architecture requires a change; every plan step must map to exactly one unit and unit file sets must be disjoint.",
		"- Specify between-unit contracts once and ensure exposes/consumes references match exactly.",
		"- If Serena MCP tools are unavailable, use local read/grep/find/ls/bash verification and document any symbol-verification limitations.",
		"- Return the concise caller report specified in your output_format section after writing the design and updating the living design document.",
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

export default function designBuilderSubagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Design Builder Subagent",
		description:
			"Delegate technical-design creation to an isolated Pi subagent. The subagent writes docs/design/design-NNN-<slug>.md with mandatory YAML frontmatter, precise API/module contracts, implementation-unit interfaces, risks, and updates docs/design/project-design.md.",
		promptSnippet:
			"Create a technical design from a refined request, implementation plan, and optional investigation, research, codebase scan, and project design context.",
		promptGuidelines: [
			"Use design_builder_subagent after request refinement and plan_builder_subagent have produced authoritative request and plan artifacts, and before parallel implementation begins.",
			"Pass request_file and plan_file to design_builder_subagent; do not use it without both artifacts.",
			"Use design_builder_subagent when coders need exact module, API, data, and between-unit contract definitions before implementation.",
		],
		parameters: Type.Object({
			request_file: Type.String({ description: "Required absolute or cwd-relative path to the refined request specification. Must exist." }),
			plan_file: Type.String({ description: "Required absolute or cwd-relative path to the implementation plan. Must exist." }),
			investigation_file: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path to the investigation document. If supplied, it must exist." }),
			),
			research_files: Type.Optional(
				Type.Array(Type.String(), { description: "Optional list of absolute or cwd-relative paths to technical research documents. Each supplied file must exist." }),
			),
			codebase_scan_file: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path to the codebase scan document. If supplied, it must exist." }),
			),
			project_design_file: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path to the living project design document. Defaults to docs/design/project-design.md and may be created by the child process." }),
			),
			output_path: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path for the design output. Defaults to docs/design/design-NNN-<slug>.md using plan metadata when available." }),
			),
			output_slug: Type.Optional(
				Type.String({ description: "Optional lowercase hyphenated slug used when output_path is omitted and the plan does not provide a slug, or to override the plan slug." }),
			),
			integration_directive: Type.Optional(
				Type.String({ description: "Optional binding orchestrator instruction from duplication/integration analysis." }),
			),
			resolved_open_questions: Type.Optional(
				Type.String({ description: "Optional binding record of user answers to the plan's open questions." }),
			),
			original_request: Type.Optional(
				Type.String({ description: "Optional raw user request text used as a drift guard." }),
			),
			cwd: Type.Optional(
				Type.String({ description: "Optional working directory/project root for the child design-builder process. Defaults to the current Pi working directory." }),
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
			let planFile: string;
			let investigationFile: string | undefined;
			let codebaseScanFile: string | undefined;
			let projectDesignFile: string;
			let researchFiles: string[];
			try {
				requestFile = resolveRequiredFile(params.request_file, cwd, "request_file");
				planFile = resolveRequiredFile(params.plan_file, cwd, "plan_file");
				investigationFile = resolveOptionalExistingFile(params.investigation_file, cwd, "investigation_file");
				codebaseScanFile = resolveOptionalExistingFile(params.codebase_scan_file, cwd, "codebase_scan_file");
				researchFiles = resolveResearchFiles(params.research_files, cwd);
				projectDesignFile = resolveOptionalWritableFile(params.project_design_file, cwd) ?? path.join(cwd, "docs", "design", "project-design.md");
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
				};
			}

			const { outputPath, designNumber, slug, metadataSource } = resolveOutputPath(params.output_path, cwd, requestFile, planFile, params.output_slug);
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });
			fs.mkdirSync(path.dirname(projectDesignFile), { recursive: true });

			const task = buildTask({
				cwd,
				requestFile,
				planFile,
				investigationFile,
				researchFiles,
				codebaseScanFile,
				projectDesignFile,
				outputPath,
				integrationDirective: params.integration_directive,
				resolvedOpenQuestions: params.resolved_open_questions,
				originalRequest: params.original_request,
			});
			onUpdate?.({ content: [{ type: "text", text: `Starting design-builder subagent. Output: ${outputPath}` }] });

			const result = await runChildPi({
				promptPath,
				task,
				cwd,
				model: resolveChildModelSelector(params.model, ctx.model),
				signal,
				onText: (text) => onUpdate?.({ content: [{ type: "text", text }] }),
			});

			if (result.exitCode !== 0 || !result.finalText.trim() || !fs.existsSync(outputPath) || !fs.existsSync(projectDesignFile)) {
				const diagnostics = [
					`Design-builder subagent failed with exit code ${result.exitCode}.`,
					!fs.existsSync(outputPath) ? `Expected output file was not created: ${outputPath}` : "",
					!fs.existsSync(projectDesignFile) ? `Expected project design file was not created or updated: ${projectDesignFile}` : "",
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
						planFile,
						investigationFile,
						researchFiles,
						codebaseScanFile,
						projectDesignFile,
						outputPath,
						designNumber,
						slug,
						metadataSource,
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
					planFile,
					investigationFile,
					researchFiles,
					codebaseScanFile,
					projectDesignFile,
					outputPath,
					designNumber,
					slug,
					metadataSource,
					promptPath,
					exitCode: result.exitCode,
					messageCount: result.messages.length,
				},
			};
		},
	});
}
