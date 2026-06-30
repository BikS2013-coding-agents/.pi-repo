import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "test_builder_subagent";
const PROMPT_FILE = "test-builder-agent.md";
const CHILD_TOOLS = "read,write,edit,grep,find,ls,bash";
const FINAL_TEXT_CAP = 20 * 1024;
const DIAGNOSTIC_TEXT_CAP = 4 * 1024;

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
		throw new Error(`Test-builder subagent prompt file is missing: ${promptPath}`);
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
	return slug || "test-build";
}

function resolveCwd(rawCwd: string | undefined, fallback: string): string {
	return path.resolve(rawCwd?.trim() || fallback);
}

function resolveOptionalPath(rawPath: string | undefined, cwd: string): string | undefined {
	if (!rawPath?.trim()) return undefined;
	return path.resolve(cwd, rawPath.trim());
}

function resolveOutputPath(rawOutputPath: string | undefined, targetPath: string, scope: string): string {
	if (rawOutputPath?.trim()) return path.resolve(targetPath, rawOutputPath.trim());
	const date = new Date().toISOString().slice(0, 10);
	return path.join(targetPath, "docs", "reference", `test-build-${slugify(scope)}-${date}.md`);
}

function fileStatus(filePath: string | undefined): string {
	if (!filePath) return "null";
	return fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : `${filePath} (missing; child agent must warn and proceed without it)`;
}

function buildTask(options: {
	scope: string;
	targetPath: string;
	outputPath: string;
	codebaseScanFile?: string;
	requestFile?: string;
	designFile?: string;
	testDir?: string;
	mode: "write-and-run" | "write-only" | "report-only";
}): string {
	const lines = [
		"Run the test-builder workflow using the test-builder instructions in your system prompt.",
		"",
		"Launch inputs:",
		`- scope: ${options.scope}`,
		`- target_path: ${options.targetPath}`,
		`- output_path: ${options.outputPath}`,
		`- codebase_scan_file: ${fileStatus(options.codebaseScanFile)}`,
		`- request_file: ${fileStatus(options.requestFile)}`,
		`- design_file: ${fileStatus(options.designFile)}`,
		`- test_dir: ${options.testDir?.trim() || "null"}`,
		`- mode: ${options.mode}`,
		"",
		"Hard requirements from the parent extension:",
		"- Do not ask user questions. Missing or ambiguous input must be reflected in the report status/output.",
		"- Treat target_path as the project root and write exactly one markdown report at output_path.",
		"- Preserve the safety invariants: never edit production source, declare test_files_owned before writes, never edit shared test infrastructure, and run only scope-owned tests.",
		"- If mode is report-only, write the report but do not write or execute tests.",
		"- If mode is write-only, write tests and the report but do not execute tests.",
		"- If mode is write-and-run, write tests, run only the tests in test_files_owned, and capture results in the report.",
		"- Optional input files that are marked missing must be logged as warnings in the report and then ignored; do not fail solely because they are missing.",
		"- Return only the concise final caller report specified in your output_format section after writing output_path.",
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

export default function testBuilderSubagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Test Builder Subagent",
		description:
			"Delegate scoped test creation/update to an isolated Pi subagent. The subagent writes or updates only owned test files, optionally runs scope-only tests, and writes a structured markdown test-build report with mandatory YAML frontmatter.",
		promptSnippet:
			"Build or update tests for one scoped module, feature, file set, or symbol set via an isolated test-builder subagent and write a docs/reference/test-build-*.md report.",
		promptGuidelines: [
			"Use test_builder_subagent after implementation when a workflow needs tests for specific files, symbols, features, or behavior without modifying unrelated production code.",
			"Pass a concrete scope to test_builder_subagent that includes source files, symbols, or a feature name resolvable from a codebase scan; do not use it for full-suite verification.",
			"Use mode=report-only for dry runs, mode=write-only when tests must not be executed, and mode=write-and-run when scoped test execution is allowed.",
		],
		parameters: Type.Object({
			scope: Type.String({
				description:
					"Required textual description of what to test. Include source file paths, symbol names, or a feature name resolvable via codebase_scan_file.",
			}),
			target_path: Type.Optional(
				Type.String({ description: "Optional absolute or cwd-relative path to the project root. Defaults to the current Pi working directory." }),
			),
			output_path: Type.Optional(
				Type.String({
					description:
						"Optional absolute or target_path-relative path for the markdown report. Defaults to docs/reference/test-build-<scope-slug>-<ISO-date>.md.",
				}),
			),
			codebase_scan_file: Type.Optional(
				Type.String({ description: "Optional absolute or target_path-relative path to a codebase-scan markdown file. Missing files are reported as warnings by the child." }),
			),
			request_file: Type.Optional(
				Type.String({ description: "Optional absolute or target_path-relative path to a refined-request specification. Missing files are reported as warnings by the child." }),
			),
			design_file: Type.Optional(
				Type.String({ description: "Optional absolute or target_path-relative path to project design documentation. Missing files are reported as warnings by the child." }),
			),
			test_dir: Type.Optional(
				Type.String({ description: "Optional test directory. Defaults are resolved by the child according to the test-builder specification." }),
			),
			mode: Type.Optional(
				StringEnum(["write-and-run", "write-only", "report-only"] as const, {
					description: "Optional mode. Defaults to write-and-run.",
					default: "write-and-run",
				}),
			),
			cwd: Type.Optional(
				Type.String({ description: "Optional working directory for resolving target_path. Defaults to the current Pi working directory." }),
			),
			model: Type.Optional(
				Type.String({ description: "Optional Pi model selector for the child process. Defaults to the calling agent's current model; use \"same\" or omit to forward the caller model." }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const scope = params.scope?.trim();
			if (!scope) {
				return {
					content: [{ type: "text", text: "Missing required parameter: scope." }],
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

			const launchCwd = resolveCwd(params.cwd, ctx.cwd);
			if (!fs.existsSync(launchCwd) || !fs.statSync(launchCwd).isDirectory()) {
				return {
					content: [{ type: "text", text: `cwd does not exist or is not a directory: ${launchCwd}` }],
					isError: true,
				};
			}

			const targetPath = resolveCwd(params.target_path, launchCwd);
			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return {
					content: [{ type: "text", text: `target_path does not exist or is not a directory: ${targetPath}` }],
					isError: true,
				};
			}

			const outputPath = resolveOutputPath(params.output_path, targetPath, scope);
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });

			const codebaseScanFile = resolveOptionalPath(params.codebase_scan_file, targetPath);
			const requestFile = resolveOptionalPath(params.request_file, targetPath);
			const designFile = resolveOptionalPath(params.design_file, targetPath);
			const mode = params.mode ?? "write-and-run";

			const task = buildTask({
				scope,
				targetPath,
				outputPath,
				codebaseScanFile,
				requestFile,
				designFile,
				testDir: params.test_dir,
				mode,
			});
			onUpdate?.({ content: [{ type: "text", text: `Starting test-builder subagent. Output: ${outputPath}` }] });

			const result = await runChildPi({
				promptPath,
				task,
				cwd: targetPath,
				model: resolveChildModelSelector(params.model, ctx.model),
				signal,
				onText: (text) => onUpdate?.({ content: [{ type: "text", text }] }),
			});

			if (result.exitCode !== 0 || !result.finalText.trim() || !fs.existsSync(outputPath)) {
				const diagnostics = [
					`Test-builder subagent failed with exit code ${result.exitCode}.`,
					!fs.existsSync(outputPath) ? `Expected output file was not created: ${outputPath}` : "",
					result.stderr.trim() ? `stderr:\n${tailText(result.stderr.trim(), DIAGNOSTIC_TEXT_CAP)}` : "",
					!result.finalText.trim() && result.stdout.trim() ? `stdout:\n${tailText(result.stdout.trim(), DIAGNOSTIC_TEXT_CAP)}` : "",
				]
					.filter(Boolean)
					.join("\n\n");

				return {
					content: [{ type: "text", text: diagnostics }],
					details: {
						scope,
						targetPath,
						outputPath,
						codebaseScanFile,
						requestFile,
						designFile,
						testDir: params.test_dir,
						mode,
						promptPath,
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
					scope,
					targetPath,
					outputPath,
					codebaseScanFile,
					requestFile,
					designFile,
					testDir: params.test_dir,
					mode,
					promptPath,
					exitCode: result.exitCode,
					messageCount: result.messages.length,
				},
			};
		},
	});
}
