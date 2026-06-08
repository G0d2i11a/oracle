import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunOracleOptions } from "../oracle.js";
import {
  readFiles,
  createFileSections,
  MODEL_CONFIGS,
  TOKENIZER_OPTIONS,
  formatFileSection,
} from "../oracle.js";
import { isKnownModel } from "../oracle/modelResolver.js";
import { buildPromptMarkdown } from "../oracle/promptAssembly.js";
import type { BrowserAttachment } from "./types.js";
import { buildAttachmentPlan } from "./policies.js";

const DEFAULT_BROWSER_INLINE_CHAR_BUDGET = 60_000;
const DEFAULT_BROWSER_MAX_ATTACHMENTS = 10;

const MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
  ".mp3",
  ".wav",
  ".aac",
  ".flac",
  ".ogg",
  ".m4a",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".heic",
  ".heif",
  ".pdf",
]);

export function isMediaFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return MEDIA_EXTENSIONS.has(ext);
}

export interface BrowserPromptArtifacts {
  markdown: string;
  composerText: string;
  estimatedInputTokens: number;
  attachments: BrowserAttachment[];
  inlineFileCount: number;
  tokenEstimateIncludesInlineFiles: boolean;
  attachmentsPolicy: "auto" | "never" | "always";
  attachmentMode: "inline" | "upload" | "bundle";
  fallback?: {
    composerText: string;
    attachments: BrowserAttachment[];
    bundled?: { originalCount: number; bundlePath: string } | null;
  } | null;
  bundled?: { originalCount: number; bundlePath: string } | null;
}

interface AssemblePromptDeps {
  cwd?: string;
  readFilesImpl?: typeof readFiles;
  tokenizeImpl?: (typeof MODEL_CONFIGS)["gpt-5.1"]["tokenizer"];
}

async function createBundledTextAttachment(
  sections: ReturnType<typeof createFileSections>,
): Promise<{
  attachment: BrowserAttachment;
  bundled: { originalCount: number; bundlePath: string };
  text: string;
}> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-browser-bundle-"));
  const bundlePath = path.join(bundleDir, "attachments-bundle.txt");
  const bundleLines: string[] = [];
  sections.forEach((section) => {
    bundleLines.push(formatFileSection(section.displayPath, section.content).trimEnd());
    bundleLines.push("");
  });
  const text = `${bundleLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
  await fs.writeFile(bundlePath, text, "utf8");
  return {
    attachment: {
      path: bundlePath,
      displayPath: bundlePath,
      sizeBytes: Buffer.byteLength(text, "utf8"),
    },
    bundled: { originalCount: sections.length, bundlePath },
    text,
  };
}

function resolveBrowserMaxAttachments(): number {
  const raw = process.env.ORACLE_BROWSER_MAX_ATTACHMENTS;
  if (!raw) return DEFAULT_BROWSER_MAX_ATTACHMENTS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BROWSER_MAX_ATTACHMENTS;
  return parsed;
}

export async function assembleBrowserPrompt(
  runOptions: RunOracleOptions,
  deps: AssemblePromptDeps = {},
): Promise<BrowserPromptArtifacts> {
  const cwd = deps.cwd ?? process.cwd();
  const readFilesFn = deps.readFilesImpl ?? readFiles;

  const allFilePaths = runOptions.file ?? [];
  const textFilePaths = allFilePaths.filter((f) => !isMediaFile(f));
  const mediaFilePaths = allFilePaths.filter((f) => isMediaFile(f));

  const mediaAttachments: BrowserAttachment[] = await Promise.all(
    mediaFilePaths.map(async (filePath) => {
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      const stats = await fs.stat(resolvedPath);
      return {
        path: resolvedPath,
        displayPath: path.relative(cwd, resolvedPath) || path.basename(resolvedPath),
        sizeBytes: stats.size,
      };
    }),
  );

  const files = await readFilesFn(textFilePaths, {
    cwd,
    maxFileSizeBytes: runOptions.maxFileSizeBytes,
  });
  const basePrompt = (runOptions.prompt ?? "").trim();
  const userPrompt = basePrompt;
  const systemPrompt = runOptions.system?.trim() || "";
  const sections = createFileSections(files, cwd);
  const markdown = buildPromptMarkdown(systemPrompt, userPrompt, sections);

  const attachmentsPolicy: "auto" | "never" | "always" = runOptions.browserInlineFiles
    ? "never"
    : (runOptions.browserAttachments ?? "auto");
  const bundleRequested = Boolean(runOptions.browserBundleFiles);
  const maxAttachments = resolveBrowserMaxAttachments();

  const inlinePlan = buildAttachmentPlan(sections, {
    inlineFiles: true,
    bundleRequested,
    maxAttachments,
  });
  const uploadPlan = buildAttachmentPlan(sections, {
    inlineFiles: false,
    bundleRequested,
    maxAttachments,
  });

  const baseComposerSections: string[] = [];
  if (systemPrompt) baseComposerSections.push(systemPrompt);
  if (userPrompt) baseComposerSections.push(userPrompt);

  const inlineComposerText = [...baseComposerSections, inlinePlan.inlineBlock]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  const selectedPlan =
    attachmentsPolicy === "always"
      ? uploadPlan
      : attachmentsPolicy === "never"
        ? inlinePlan
        : inlineComposerText.length <= DEFAULT_BROWSER_INLINE_CHAR_BUDGET || sections.length === 0
          ? inlinePlan
          : uploadPlan;

  const composerText = (
    selectedPlan.inlineBlock
      ? [...baseComposerSections, selectedPlan.inlineBlock]
      : baseComposerSections
  )
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const attachments: BrowserAttachment[] = [...selectedPlan.attachments, ...mediaAttachments];

  const shouldBundle = selectedPlan.shouldBundle;
  let bundleText: string | null = null;
  let bundled: { originalCount: number; bundlePath: string } | null = null;
  if (shouldBundle && sections.length > 0) {
    const bundle = await createBundledTextAttachment(sections);
    bundleText = bundle.text;
    attachments.length = 0;
    attachments.push(bundle.attachment);
    attachments.push(...mediaAttachments);
    bundled = bundle.bundled;
  }

  const inlineFileCount = selectedPlan.inlineFileCount;
  const modelConfig = isKnownModel(runOptions.model)
    ? MODEL_CONFIGS[runOptions.model]
    : MODEL_CONFIGS["gpt-5.1"];
  const tokenizer = deps.tokenizeImpl ?? modelConfig.tokenizer;
  const tokenizerUserContent =
    inlineFileCount > 0 && selectedPlan.inlineBlock
      ? [userPrompt, selectedPlan.inlineBlock]
          .filter((value) => Boolean(value?.trim()))
          .join("\n\n")
          .trim()
      : userPrompt;
  const tokenizerMessages = [
    systemPrompt ? { role: "system", content: systemPrompt } : null,
    tokenizerUserContent ? { role: "user", content: tokenizerUserContent } : null,
  ].filter(Boolean) as Array<{ role: "system" | "user"; content: string }>;
  let estimatedInputTokens = tokenizer(
    tokenizerMessages.length > 0 ? tokenizerMessages : [{ role: "user", content: "" }],
    TOKENIZER_OPTIONS,
  );
  const tokenEstimateIncludesInlineFiles = inlineFileCount > 0 && Boolean(selectedPlan.inlineBlock);
  if (!tokenEstimateIncludesInlineFiles && sections.length > 0) {
    const attachmentText =
      bundleText ??
      sections
        .map((section) => formatFileSection(section.displayPath, section.content).trimEnd())
        .join("\n\n");
    const attachmentTokens = tokenizer(
      [{ role: "user", content: attachmentText }],
      TOKENIZER_OPTIONS,
    );
    estimatedInputTokens += attachmentTokens;
  }

  let fallback: BrowserPromptArtifacts["fallback"] = null;
  if (attachmentsPolicy === "auto" && selectedPlan.mode === "inline" && sections.length > 0) {
    const fallbackComposerText = baseComposerSections.join("\n\n").trim();
    const fallbackAttachments = [...uploadPlan.attachments, ...mediaAttachments];
    let fallbackBundled: { originalCount: number; bundlePath: string } | null = null;
    if (uploadPlan.shouldBundle || sections.length > 1) {
      const bundle = await createBundledTextAttachment(sections);
      fallbackAttachments.length = 0;
      fallbackAttachments.push(bundle.attachment);
      fallbackAttachments.push(...mediaAttachments);
      fallbackBundled = bundle.bundled;
    }
    fallback = {
      composerText: fallbackComposerText,
      attachments: fallbackAttachments,
      bundled: fallbackBundled,
    };
  } else if (!shouldBundle && selectedPlan.mode === "upload" && sections.length > 1) {
    const bundle = await createBundledTextAttachment(sections);
    fallback = {
      composerText,
      attachments: [bundle.attachment, ...mediaAttachments],
      bundled: bundle.bundled,
    };
  }

  return {
    markdown,
    composerText,
    estimatedInputTokens,
    attachments,
    inlineFileCount,
    tokenEstimateIncludesInlineFiles,
    attachmentsPolicy,
    attachmentMode: selectedPlan.mode,
    fallback,
    bundled,
  };
}
