import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDFParse } from "pdf-parse";
import { getResumeFolderNameFromUrl } from "@/lib/resumeFolderKey";
import { normalizeJobUrlForStorage } from "@/lib/jobUrlNormalization";
import {
  prepareDriveJobFolder,
  uploadPreparedDriveFiles,
  uploadFilesToDriveFolder,
  PreparedDriveFileEntry,
} from "@/lib/googleDriveResume";
import { upsertResumeDashboardItem } from "@/lib/resumeDashboardIndex";
import { buildDriveProxyUrl } from "@/lib/driveProxyLinks";
import { getDataPath } from "@/lib/userConfig";
import { DEFAULT_RESUME_FOLDER_NAME, DEFAULT_RESUME_JOB_URL, isTruthy } from "@/lib/defaultResume";

import { recordResumeFailure } from "@/lib/resumeFailureTracker";

const execFileAsync = promisify(execFile);

const TEMPLATE_PROFILE_PATH = getDataPath("sample.json");
const TEMPLATE_RESUME_PATH = getDataPath("resume_sample.json");
const TEMPLATE_RESUME_PAGINATE_PATH = getDataPath("resume_paginate_sample.json");
const JOB_URL_FILE_NAME = "job-url.txt";
const RESUME_TXT_FILE_NAME = "resume.txt";
const TEX_FILE_NAME = "resume.tex";
const LATEX_OUTPUT_PDF_FILE_NAME = "resume.pdf";

function buildGeneratedPdfFileName(): string {
  try {
    const raw = readFileSync(TEMPLATE_RESUME_PATH, "utf8");
    const resumeSample = JSON.parse(raw) as { name?: string };
    const name = (resumeSample.name ?? "").trim();
    if (name) return `${name}.pdf`;
  } catch {
    // fall through to default
  }
  return "resume_output.pdf";
}

const GENERATED_PDF_FILE_NAME = buildGeneratedPdfFileName();
const PROFILE_FILE_NAME = "profile.json";
const RESUME_JSON_FILE_NAME = "resume.json";
const RESUME_PAGINATE_JSON_FILE_NAME = "resume_paginate.json";
const META_FILE_NAME = "meta.json";
const DEFAULT_RESUME_BASE_URL = "http://localhost:3000";
const LATEX_TIMEOUT_MS = 120_000;
const LATEX_TAIL_LINES = 40;
const TEX_PATH_HINTS = [
  path.join(os.homedir(), "texlive", "usr", "local", "texlive", "2026", "bin", "universal-darwin"),
  path.join(os.homedir(), "AppData", "Local", "Programs", "MiKTeX", "miktex", "bin", "x64"),
  "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64",
  "/Library/TeX/texbin",
  "/usr/texbin",
];
const PDF_PARSE_TIMEOUT_MS = 30_000;
const PDFLATEX_CANDIDATES = [
  "pdflatex",
  path.join(os.homedir(), "texlive", "usr", "local", "texlive", "2026", "bin", "universal-darwin", "pdflatex"),
  path.join(os.homedir(), "AppData", "Local", "Programs", "MiKTeX", "miktex", "bin", "x64", "pdflatex.exe"),
  "C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\pdflatex.exe",
  "/Library/TeX/texbin/pdflatex",
  "/usr/texbin/pdflatex",
];

PDFParse.setWorker(
  pathToFileURL(
    path.join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs")
  ).href
);

export const runtime = "nodejs";

type ResumeRequestBody = {
  jobUrl?: unknown;
  latex?: unknown;
  mode?: unknown;
  defaultResume?: unknown;
};

type CompileResult =
  | { ok: true; pdfPath: string }
  | {
    ok: false;
    error: "pdflatex_not_found" | "latex_compile_failed" | "pdf_missing";
    details: string;
  };

type ProfileLinks = {
  resume_download: string;
  resume_preview: string;
  resume: string;
};

type TemplateProfile = {
  experience?: Array<Record<string, unknown>>;
  resume_download?: string;
  resume_preview?: string;
  resume?: string;
  [key: string]: unknown;
};

type TemplateResume = {
  resume_download?: string;
  resume_preview?: string;
  resume?: string;
  [key: string]: unknown;
};

type TemplateResumePaginate = {
  items?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type ExperienceDescription = {
  description: string;
  company: string;
  title: string;
  index: number;
};

function getFolderNameFromUrl(jobUrl: string): string {
  return getResumeFolderNameFromUrl(jobUrl);
}

function tailLines(text: string, maxLines: number): string {
  if (!text) return "";
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return lines.slice(-maxLines).join("\n");
}

function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, "");
}

function resolveResumeBaseUrl(request: NextRequest): string {
  const envBase = String(process.env.RESUME_BASE_URL || "").trim();
  if (/^https?:\/\//i.test(envBase)) {
    return normalizeBaseUrl(envBase);
  }

  // Use the Host header sent by the browser — correct when running behind Docker/proxies
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost || request.headers.get("host");
  if (host) {
    const proto =
      request.headers.get("x-forwarded-proto") ||
      request.nextUrl.protocol.replace(/:$/, "");
    return normalizeBaseUrl(`${proto}://${host}`);
  }

  return DEFAULT_RESUME_BASE_URL;
}

function isInsideLatexComment(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  for (let i = lineStart; i < index; i++) {
    if (text[i] === "%" && !isEscaped(text, i)) return true;
  }
  return false;
}

function isEscaped(str: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && str[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function normalizeLatexInlineText(input: string): string {
  let output = input;
  for (let i = 0; i < 6; i += 1) {
    const next = output
      .replace(/\\href\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, "$1")
      .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*])?\{([^{}]*)\}/g, "$1");
    if (next === output) break;
    output = next;
  }

  return output
    .replace(/\\%/g, "%")
    .replace(/\\&/g, "&")
    .replace(/\\#/g, "#")
    .replace(/\\\$/g, "$")
    .replace(/\\_/g, "_")
    .replace(/\\textbackslash/g, "\\")
    .replace(/\\textasciitilde/g, "~")
    .replace(/\\\\/g, " ")
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*])?/g, " ")
    .replace(/[{}~$]/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEmailFromLatex(latex: string): string {
  // Match \href{mailto:email@domain.com} — greedily finds the first mailto link
  const match = /\\href\{mailto:([^}]+)\}/i.exec(latex);
  return match ? match[1].trim() : "";
}

function skipLatexWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function readBracedArgument(text: string, openBraceIndex: number): { value: string; end: number } {
  if (text[openBraceIndex] !== "{") {
    throw new Error("Malformed LaTeX: expected braced argument");
  }

  let depth = 1;
  let i = openBraceIndex + 1;

  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "{" && !isEscaped(text, i)) {
      depth += 1;
    } else if (ch === "}" && !isEscaped(text, i)) {
      depth -= 1;
    }
    i += 1;
  }

  if (depth !== 0) {
    throw new Error("Malformed LaTeX: unbalanced braces");
  }

  return { value: text.slice(openBraceIndex + 1, i - 1), end: i };
}

function readCommandArgumentsAt(
  text: string,
  commandStart: number,
  commandName: string
): { args: string[]; end: number } {
  const commandPrefix = `\\${commandName}`;
  if (!text.startsWith(commandPrefix, commandStart)) {
    throw new Error(`Malformed LaTeX: expected \\${commandName}`);
  }

  let cursor = commandStart + commandPrefix.length;
  if (text[cursor] === "*") cursor += 1;

  const args: string[] = [];
  while (cursor < text.length) {
    cursor = skipLatexWhitespace(text, cursor);
    if (text[cursor] !== "{") break;
    const arg = readBracedArgument(text, cursor);
    args.push(arg.value);
    cursor = arg.end;
  }

  return { args, end: cursor };
}

function findLatexCommandCalls(
  text: string,
  commandNames: string[]
): Array<{ commandName: string; start: number; end: number; args: string[] }> {
  const wanted = new Set(commandNames);
  const calls: Array<{ commandName: string; start: number; end: number; args: string[] }> = [];
  const commandRegex = /\\([a-zA-Z@]+)\*?/g;
  let match: RegExpExecArray | null;

  while ((match = commandRegex.exec(text)) !== null) {
    const commandName = match[1];
    const start = match.index;
    if (!wanted.has(commandName) || isInsideLatexComment(text, start)) continue;

    const parsed = readCommandArgumentsAt(text, start, commandName);
    calls.push({ commandName, start, end: parsed.end, args: parsed.args });
    commandRegex.lastIndex = Math.max(commandRegex.lastIndex, parsed.end);
  }

  return calls;
}

function extractCommandArguments(text: string, commandName: string): string[] {
  return findLatexCommandCalls(text, [commandName]).map((call) => call.args[0] || "");
}

function normalizeMatchKey(value: unknown): string {
  return normalizeLatexInlineText(String(value || ""))
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function getTemplateCompanyName(experience: Record<string, unknown>): string {
  const company = experience.company;
  if (company && typeof company === "object" && "name" in company) {
    return String((company as { name?: unknown }).name || "");
  }
  return String(
    experience.company_name ||
    experience.companyName ||
    experience.employer ||
    experience.organization ||
    company ||
    ""
  );
}

function getTemplateTitle(experience: Record<string, unknown>): string {
  return String(
    experience.title ||
    experience.position ||
    experience.role ||
    experience.job_title ||
    experience.jobTitle ||
    ""
  );
}

function parseHeadingLabel(args: string[]): { company: string; title: string } {
  const label = normalizeLatexInlineText(args[0] || "");
  const parts = label
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    company: parts[0] || "",
    title: parts[1] || "",
  };
}

function sectionNameMatches(rawName: string, wanted: string[]): boolean {
  const name = normalizeLatexInlineText(rawName).toLowerCase().replace(/[^a-z]/g, "");
  return wanted.some((value) => name === value.toLowerCase().replace(/[^a-z]/g, ""));
}

function extractExperienceSection(tex: string): string {
  const sectionCalls = findLatexCommandCalls(tex, ["section"]);
  const wantedNames = ["Professional Experience", "Experience", "Work Experience"];

  for (let i = 0; i < sectionCalls.length; i += 1) {
    const section = sectionCalls[i];
    if (!sectionNameMatches(section.args[0] || "", wantedNames)) continue;
    const nextSection = sectionCalls[i + 1]?.start ?? tex.length;
    return tex.slice(section.start, nextSection);
  }

  throw new Error(
    "Could not find \\section{Professional Experience}, \\section{Experience}, or \\section*{Experience} in resume LaTeX"
  );
}

function extractResumeItems(block: string): string[] {
  return extractCommandArguments(block, "resumeItem")
    .map((item) => normalizeLatexInlineText(item))
    .filter(Boolean);
}

function extractPlainItems(block: string): string[] {
  const positions: number[] = [];
  const itemRegex = /\\item\b/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(block)) !== null) {
    if (!isInsideLatexComment(block, match.index)) positions.push(match.index);
  }

  return positions
    .map((start, index) => {
      const contentStart = start + "\\item".length;
      const contentEnd = positions[index + 1] ?? block.length;
      return normalizeLatexInlineText(
        block.slice(contentStart, contentEnd).replace(/^\s*(?:\[[^\]]*])?\s*/, "")
      );
    })
    .filter(Boolean);
}

function extractCustomExperienceEntries(experienceSection: string): ExperienceDescription[] {
  const headingCalls = findLatexCommandCalls(experienceSection, [
    "resumeExperienceHeading",
    "resumeSubheading",
  ]);
  const entries: ExperienceDescription[] = [];

  headingCalls.forEach((heading, index) => {
    const nextHeadingStart = headingCalls[index + 1]?.start ?? experienceSection.length;
    const listStartToken = "\\resumeItemListStart";
    const listEndToken = "\\resumeItemListEnd";
    const listStart = experienceSection.indexOf(listStartToken, heading.end);
    if (listStart === -1 || listStart > nextHeadingStart) return;

    const contentStart = listStart + listStartToken.length;
    const listEnd = experienceSection.indexOf(listEndToken, contentStart);
    if (listEnd === -1) {
      throw new Error(
        "Malformed LaTeX: found \\resumeItemListStart without matching \\resumeItemListEnd"
      );
    }

    const items = extractResumeItems(experienceSection.slice(contentStart, listEnd));
    if (items.length === 0) return;

    const label = parseHeadingLabel(heading.args);
    entries.push({
      ...label,
      index: entries.length,
      description: items.map((line) => `• ${line}`).join("\n"),
    });
  });

  return entries;
}

function extractPlainItemizeExperienceEntries(experienceSection: string): ExperienceDescription[] {
  const beginToken = "\\begin{itemize}";
  const endToken = "\\end{itemize}";
  const entries: ExperienceDescription[] = [];
  let cursor = 0;

  while (cursor < experienceSection.length) {
    const start = experienceSection.indexOf(beginToken, cursor);
    if (start === -1) break;
    const contentStart = start + beginToken.length;
    const end = experienceSection.indexOf(endToken, contentStart);
    if (end === -1) break;

    const items = extractPlainItems(experienceSection.slice(contentStart, end));
    if (items.length > 0) {
      entries.push({
        company: "",
        title: "",
        index: entries.length,
        description: items.map((line) => `• ${line}`).join("\n"),
      });
    }
    cursor = end + endToken.length;
  }

  return entries;
}

function getExperienceDescriptionsFromLatex(tex: string): ExperienceDescription[] {
  const section = extractExperienceSection(tex);
  const entries = extractCustomExperienceEntries(section);
  const fallbackEntries = entries.length > 0 ? entries : extractPlainItemizeExperienceEntries(section);

  if (fallbackEntries.length === 0) {
    throw new Error("No experience bullet lists found in experience section");
  }

  return fallbackEntries;
}

function buildDriveResumeLinks(baseUrl: string, fileId: string): ProfileLinks {
  return {
    resume_download: buildDriveProxyUrl(baseUrl, fileId, true),
    resume_preview: buildDriveProxyUrl(baseUrl, fileId, false),
    resume: buildDriveProxyUrl(baseUrl, fileId, true),
  };
}

function buildLocalResumeLinks(baseUrl: string, jobUrl: string): ProfileLinks {
  const endpoint = `${normalizeBaseUrl(baseUrl)}/api/resume/file?jobUrl=${encodeURIComponent(
    jobUrl
  )}`;
  return {
    resume_download: `${endpoint}&download=1`,
    resume_preview: `${endpoint}&download=0`,
    resume: `${endpoint}&download=1`,
  };
}

function cloneTemplate(template: TemplateProfile): TemplateProfile {
  return JSON.parse(JSON.stringify(template)) as TemplateProfile;
}

function mergeDescriptionsIntoTemplate(
  template: TemplateProfile,
  descriptions: ExperienceDescription[],
  links: ProfileLinks
): TemplateProfile {
  if (!Array.isArray(template.experience)) {
    throw new Error("Template JSON does not contain an 'experience' array");
  }

  const next = cloneTemplate(template);
  const nextExperience = next.experience;
  if (!Array.isArray(nextExperience)) {
    throw new Error("Template JSON does not contain an 'experience' array");
  }

  const used = new Set<number>();
  next.experience = nextExperience.map((experience, index) => {
    const templateExperience = experience as Record<string, unknown>;
    const templateCompany = normalizeMatchKey(getTemplateCompanyName(templateExperience));
    const templateTitle = normalizeMatchKey(getTemplateTitle(templateExperience));

    let bestMatch: ExperienceDescription | undefined;
    let bestScore = 0;
    for (const candidate of descriptions) {
      if (used.has(candidate.index)) continue;
      const candidateCompany = normalizeMatchKey(candidate.company);
      const candidateTitle = normalizeMatchKey(candidate.title);
      let score = 0;

      if (templateCompany && candidateCompany) {
        if (templateCompany === candidateCompany) score += 6;
        else if (templateCompany.includes(candidateCompany) || candidateCompany.includes(templateCompany)) score += 4;
      }
      if (templateTitle && candidateTitle) {
        if (templateTitle === candidateTitle) score += 3;
        else if (templateTitle.includes(candidateTitle) || candidateTitle.includes(templateTitle)) score += 2;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    const orderedFallback = descriptions.find(
      (candidate) => !used.has(candidate.index) && candidate.index === index
    );
    const selected = bestScore >= 4 ? bestMatch : orderedFallback;
    if (!selected) return experience;

    used.add(selected.index);
    return {
      ...experience,
      description: selected.description,
    };
  });

  next.resume_download = links.resume_download;
  next.resume_preview = links.resume_preview;
  next.resume = links.resume;
  return next;
}

let cachedTemplateProfile: TemplateProfile | null = null;
let cachedTemplateResume: TemplateResume | null = null;
let cachedTemplateResumePaginate: TemplateResumePaginate | null = null;

async function getTemplateProfile(): Promise<TemplateProfile> {
  if (cachedTemplateProfile) return cachedTemplateProfile;
  const raw = await fs.readFile(TEMPLATE_PROFILE_PATH, "utf8");
  cachedTemplateProfile = JSON.parse(raw) as TemplateProfile;
  return cachedTemplateProfile;
}

async function getTemplateResume(): Promise<TemplateResume> {
  if (cachedTemplateResume) return cachedTemplateResume;
  const raw = await fs.readFile(TEMPLATE_RESUME_PATH, "utf8");
  cachedTemplateResume = JSON.parse(raw) as TemplateResume;
  return cachedTemplateResume;
}

async function getTemplateResumePaginate(): Promise<TemplateResumePaginate> {
  if (cachedTemplateResumePaginate) return cachedTemplateResumePaginate;
  const raw = await fs.readFile(TEMPLATE_RESUME_PAGINATE_PATH, "utf8");
  cachedTemplateResumePaginate = JSON.parse(raw) as TemplateResumePaginate;
  return cachedTemplateResumePaginate;
}

async function generateProfileJson(
  folderPath: string,
  jobUrl: string,
  latex: string,
  baseUrl: string,
  overrideLinks?: ProfileLinks,
  preparsedDescriptions?: ExperienceDescription[],
  preparsedEmail?: string | null
): Promise<{ profilePath: string; profileBytes: number; links: ProfileLinks }> {
  const templateJson = await getTemplateProfile();
  const descriptions = preparsedDescriptions ?? getExperienceDescriptionsFromLatex(latex);
  const links = overrideLinks ?? buildLocalResumeLinks(baseUrl, jobUrl);
  const merged = mergeDescriptionsIntoTemplate(templateJson, descriptions, links);

  // Patch email extracted from LaTeX into profile
  const extractedEmail = preparsedEmail !== undefined ? preparsedEmail : extractEmailFromLatex(latex);
  if (extractedEmail) {
    (merged as Record<string, unknown>).email = extractedEmail;
  }

  const profilePath = path.join(folderPath, PROFILE_FILE_NAME);
  await fs.writeFile(profilePath, `${JSON.stringify(merged, null, 4)}\n`, "utf8");
  const stats = await fs.stat(profilePath);
  return { profilePath, profileBytes: stats.size, links };
}

function mergeResumeLinksIntoTemplate(
  template: TemplateResume,
  links: ProfileLinks
): TemplateResume {
  const next = JSON.parse(JSON.stringify(template)) as TemplateResume;
  next.resume_download = links.resume_download;
  next.resume_preview = links.resume_preview;
  next.resume = links.resume;
  return next;
}

async function generateResumeJson(
  folderPath: string,
  links: ProfileLinks
): Promise<{ resumeJsonPath: string; resumeJsonBytes: number }> {
  const templateJson = await getTemplateResume();
  const merged = mergeResumeLinksIntoTemplate(templateJson, links);
  const resumeJsonPath = path.join(folderPath, RESUME_JSON_FILE_NAME);
  await fs.writeFile(resumeJsonPath, `${JSON.stringify(merged, null, 4)}\n`, "utf8");
  const stats = await fs.stat(resumeJsonPath);
  return { resumeJsonPath, resumeJsonBytes: stats.size };
}

function mergeResumeLinksIntoPaginateTemplate(
  template: TemplateResumePaginate,
  links: ProfileLinks
): TemplateResumePaginate {
  const next = JSON.parse(JSON.stringify(template)) as TemplateResumePaginate;
  if (Array.isArray(next.items)) {
    next.items = next.items.map((item) => ({
      ...item,
      resume_download: links.resume_download,
      resume_preview: links.resume_preview,
      resume: links.resume,
    }));
  }
  return next;
}

async function generateResumePaginateJson(
  folderPath: string,
  links: ProfileLinks
): Promise<{ resumePaginateJsonPath: string; resumePaginateJsonBytes: number }> {
  const templateJson = await getTemplateResumePaginate();
  const merged = mergeResumeLinksIntoPaginateTemplate(templateJson, links);
  const resumePaginateJsonPath = path.join(folderPath, RESUME_PAGINATE_JSON_FILE_NAME);
  await fs.writeFile(
    resumePaginateJsonPath,
    `${JSON.stringify(merged, null, 4)}\n`,
    "utf8"
  );
  const stats = await fs.stat(resumePaginateJsonPath);
  return { resumePaginateJsonPath, resumePaginateJsonBytes: stats.size };
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim())));
}

function getPdflatexCandidates(): string[] {
  return dedupe(PDFLATEX_CANDIDATES);
}

function buildTexExecEnv(): NodeJS.ProcessEnv {
  const currentPath = process.env.PATH || "";
  const mergedPathParts = dedupe([
    ...TEX_PATH_HINTS,
    ...currentPath.split(path.delimiter),
  ]);
  return {
    ...process.env,
    PATH: mergedPathParts.join(path.delimiter),
  };
}

async function runLatexPass(
  folderPath: string,
  pdflatexBinary: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  await execFileAsync(
    pdflatexBinary,
    ["-interaction=nonstopmode", "-halt-on-error", TEX_FILE_NAME],
    {
      cwd: folderPath,
      timeout: LATEX_TIMEOUT_MS,
      env,
    }
  );
}

async function compilePdf(folderPath: string): Promise<CompileResult> {
  const candidates = getPdflatexCandidates();
  const execEnv = buildTexExecEnv();

  for (const pdflatexBinary of candidates) {
    try {
      await runLatexPass(folderPath, pdflatexBinary, execEnv);
      await runLatexPass(folderPath, pdflatexBinary, execEnv);
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        signal?: string | null;
      };

      if (err.code === "ENOENT") {
        continue;
      }

      const mergedOutput = [err.stdout || "", err.stderr || ""]
        .join("\n")
        .trim();
      const tail = tailLines(mergedOutput, LATEX_TAIL_LINES);
      const signalSuffix = err.signal ? ` (signal: ${err.signal})` : "";
      return {
        ok: false,
        error: "latex_compile_failed",
        details:
          `LaTeX compile failed using '${pdflatexBinary}'.\n` +
          (tail || `pdflatex failed${signalSuffix}`),
      };
    }

    const latexPdfPath = path.join(folderPath, LATEX_OUTPUT_PDF_FILE_NAME);
    const generatedPdfPath = path.join(folderPath, GENERATED_PDF_FILE_NAME);
    try {
      await fs.access(latexPdfPath);
    } catch {
      return {
        ok: false,
        error: "pdf_missing",
        details:
          `LaTeX command succeeded using '${pdflatexBinary}', but ${LATEX_OUTPUT_PDF_FILE_NAME} was not produced.`,
      };
    }

    if (path.basename(latexPdfPath) !== path.basename(generatedPdfPath)) {
      try {
        await fs.unlink(generatedPdfPath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          return {
            ok: false,
            error: "pdf_missing",
            details: `Failed preparing output file '${GENERATED_PDF_FILE_NAME}': ${err.message}`,
          };
        }
      }

      try {
        await fs.rename(latexPdfPath, generatedPdfPath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        return {
          ok: false,
          error: "pdf_missing",
          details:
            `Generated '${LATEX_OUTPUT_PDF_FILE_NAME}' but failed to rename to '${GENERATED_PDF_FILE_NAME}': ` +
            err.message,
        };
      }
    }

    try {
      await fs.access(generatedPdfPath);
      // Clean up pdflatex side-effect files — keep only the PDF + our own files
      await Promise.allSettled([
        fs.unlink(path.join(folderPath, "resume.aux")),
        fs.unlink(path.join(folderPath, "resume.log")),
        fs.unlink(path.join(folderPath, "resume.out")),
        fs.unlink(path.join(folderPath, TEX_FILE_NAME)),
      ]);
      return { ok: true, pdfPath: generatedPdfPath };
    } catch {
      return {
        ok: false,
        error: "pdf_missing",
        details: `Expected final PDF '${GENERATED_PDF_FILE_NAME}' was not found.`,
      };
    }
  }

  return {
    ok: false,
    error: "pdflatex_not_found",
    details:
      `Could not find pdflatex. Tried: ${candidates.join(", ")}.\n` +
      `PATH used by API: ${execEnv.PATH || "(empty)"}`,
  };
}

function normalizeExtractedPdfText(input: string): string {
  return input
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractTextFromPdf(pdfPath: string): Promise<string | null> {
  const pdfBuffer = await fs.readFile(pdfPath);
  const parser = new PDFParse({ data: pdfBuffer });

  try {
    const parsed = (await Promise.race([
      parser.getText(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("PDF text extraction timed out"));
        }, PDF_PARSE_TIMEOUT_MS);
      }),
    ])) as { text?: string };
    const normalized = normalizeExtractedPdfText(parsed.text || "");
    return normalized || null;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function extractTextFromPdfOrThrow(pdfPath: string): Promise<string> {
  try {
    const text = await extractTextFromPdf(pdfPath);
    if (text) {
      return text;
    }
    throw new Error("PDF text extraction returned empty text");
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not extract resume text from PDF using pdf-parse: ${details}`);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as ResumeRequestBody;
    const isDefaultResume = body.mode === "autoApply" && isTruthy(body.defaultResume);
    const jobUrlRaw = typeof body.jobUrl === "string" ? body.jobUrl.trim() : "";
    // Normalise through the same pipeline used for the job DB so the folder
    // hash always matches regardless of URL variant (embed vs direct, utm params, etc.)
    const jobUrl = isDefaultResume
      ? DEFAULT_RESUME_JOB_URL
      : normalizeJobUrlForStorage(jobUrlRaw) || jobUrlRaw;
    const latex = typeof body.latex === "string" ? body.latex : "";
    const mode = body.mode === "autoApply" ? "autoApply" : "manualApply";

    if (!jobUrl) {
      return NextResponse.json(
        { error: "jobUrl is required" },
        { status: 400 }
      );
    }

    if (!latex.trim()) {
      return NextResponse.json(
        { error: "latex is required" },
        { status: 400 }
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(jobUrl);
    } catch {
      return NextResponse.json(
        { error: "jobUrl must be a valid URL" },
        { status: 400 }
      );
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return NextResponse.json(
        { error: "jobUrl must start with http:// or https://" },
        { status: 400 }
      );
    }

    const folderName = isDefaultResume ? DEFAULT_RESUME_FOLDER_NAME : getFolderNameFromUrl(jobUrl);

    // Extract email from LaTeX to use as the email folder layer
    const emailFromLatex = extractEmailFromLatex(latex);
    if (!emailFromLatex) {
      return NextResponse.json(
        { error: "Could not extract email from LaTeX. Add \\href{mailto:your@email.com} to your resume header." },
        { status: 400 }
      );
    }

    const folderPath = await fs.mkdtemp(path.join(os.tmpdir(), `resume-${mode}-${folderName}-`));
    const baseUrl = resolveResumeBaseUrl(request);

    const meta = {
      jobUrl,
      createdAt: new Date().toISOString(),
      folderName,
    };

    // ── Branch A: PDF Compilation & Text Extraction ──
    const compilePromise = (async () => {
      await Promise.all([
        fs.writeFile(path.join(folderPath, JOB_URL_FILE_NAME), `${jobUrl}\n`, "utf8"),
        fs.writeFile(path.join(folderPath, TEX_FILE_NAME), latex, "utf8"),
        fs.writeFile(path.join(folderPath, META_FILE_NAME), `${JSON.stringify(meta, null, 2)}\n`, "utf8"),
      ]);

      const compileResult = await compilePdf(folderPath);
      if (compileResult.ok === false) {
        return {
          ok: false as const,
          error: "latex_compile_failed" as const,
          compileError: compileResult.error,
          compileDetails: compileResult.details,
        };
      }

      const pdfStats = await fs.stat(compileResult.pdfPath);

      let resumePlainText: string;
      try {
        resumePlainText = await extractTextFromPdfOrThrow(compileResult.pdfPath);
        await fs.writeFile(path.join(folderPath, RESUME_TXT_FILE_NAME), resumePlainText, "utf8");
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        return {
          ok: false as const,
          error: "resume_text_extraction_failed" as const,
          details,
          pdfPath: compileResult.pdfPath,
        };
      }

      return {
        ok: true as const,
        compileResult,
        pdfStats,
        resumePlainText,
      };
    })();

    // ── Branch B: Drive Folder Prep, LaTeX Bullet Parsing & JSON Generation ──
    const driveAndJsonPromise = (async () => {
      // Parse LaTeX descriptions in parallel (CPU)
      const descriptions = getExperienceDescriptionsFromLatex(latex);

      // Prepare Drive job folder & pregenerate PDF file ID in parallel (Network)
      const drivePrep = await prepareDriveJobFolder({
        mode,
        email: emailFromLatex,
        folderName,
      });

      if (!drivePrep.ok || !drivePrep.jobFolderId || !drivePrep.drive) {
        return {
          ok: false as const,
          error: "drive_prep_failed" as const,
          details: drivePrep.error || "Drive job folder preparation failed",
        };
      }

      let pdfFileId = drivePrep.pregeneratedPdfId;
      const initialLinks = pdfFileId
        ? buildDriveResumeLinks(baseUrl, pdfFileId)
        : buildLocalResumeLinks(baseUrl, jobUrl);

      // Generate all 3 JSONs in parallel
      const [profileResult, resumeJsonResult, resumePaginateJsonResult] = await Promise.all([
        generateProfileJson(folderPath, jobUrl, latex, baseUrl, initialLinks, descriptions, emailFromLatex),
        generateResumeJson(folderPath, initialLinks),
        generateResumePaginateJson(folderPath, initialLinks),
      ]);

      return {
        ok: true as const,
        drivePrep,
        pdfFileId,
        activeDriveLinks: initialLinks,
        profileResult,
        resumeJsonResult,
        resumePaginateJsonResult,
      };
    })();

    // ── Synchronize Branch A & Branch B ──
    const [compileOutcome, prepOutcome] = await Promise.all([
      compilePromise,
      driveAndJsonPromise,
    ]);

    if (!compileOutcome.ok) {
      const errorReason = compileOutcome.error === "latex_compile_failed" ? (compileOutcome.compileError || "latex_compile_failed") : "resume_text_extraction_failed";
      const errorDetails = compileOutcome.error === "latex_compile_failed" ? compileOutcome.compileDetails : compileOutcome.details;

      await recordResumeFailure({
        jobUrl,
        email: emailFromLatex,
        errorReason,
        errorDetails,
      });

      if (compileOutcome.error === "latex_compile_failed") {
        return NextResponse.json(
          {
            success: false,
            error: compileOutcome.compileError,
            details: compileOutcome.compileDetails,
            folderName,
            folderPath,
            files: {
              jobUrl: path.join(folderPath, JOB_URL_FILE_NAME),
              latex: path.join(folderPath, TEX_FILE_NAME),
            },
          },
          { status: 500 }
        );
      } else {
        return NextResponse.json(
          {
            success: false,
            error: "resume_text_extraction_failed",
            details: compileOutcome.details,
            folderName,
            folderPath,
            files: {
              jobUrl: path.join(folderPath, JOB_URL_FILE_NAME),
              latex: path.join(folderPath, TEX_FILE_NAME),
              pdf: compileOutcome.pdfPath,
              log: path.join(folderPath, "resume.log"),
              meta: path.join(folderPath, META_FILE_NAME),
            },
          },
          { status: 500 }
        );
      }
    }

    if (!prepOutcome.ok) {
      await recordResumeFailure({
        jobUrl,
        email: emailFromLatex,
        errorReason: "drive_upload_failed",
        errorDetails: prepOutcome.details,
      });

      return NextResponse.json(
        {
          success: false,
          error: "drive_upload_failed",
          details: prepOutcome.details,
          folderName,
        },
        { status: 502 }
      );
    }

    const { compileResult, pdfStats } = compileOutcome;
    const { drivePrep, profileResult, resumeJsonResult, resumePaginateJsonResult } = prepOutcome;
    let { pdfFileId, activeDriveLinks } = prepOutcome;

    const pdfFileName = path.basename(compileResult.pdfPath);

    // Fallback: If pregenerated ID was not obtained, upload PDF first to get ID, then patch JSONs
    if (!pdfFileId) {
      const pdfUpload = await uploadPreparedDriveFiles({
        drive: drivePrep.drive!,
        jobFolderId: drivePrep.jobFolderId,
        files: [
          {
            name: pdfFileName,
            buffer: await fs.readFile(compileResult.pdfPath),
            mimeType: "application/pdf",
          },
        ],
        existingFiles: drivePrep.existingFiles,
      });

      const uploadedPdf = pdfUpload.files[pdfFileName];
      if (!uploadedPdf?.fileId) {
        return NextResponse.json(
          {
            success: false,
            error: "drive_pdf_upload_incomplete",
            details: pdfUpload.error || "Drive did not return a PDF file ID",
            folderName,
          },
          { status: 502 }
        );
      }

      pdfFileId = uploadedPdf.fileId;
      activeDriveLinks = buildDriveResumeLinks(baseUrl, pdfFileId);

      // Re-generate JSONs with activeDriveLinks in parallel
      await Promise.all([
        generateProfileJson(folderPath, jobUrl, latex, baseUrl, activeDriveLinks),
        generateResumeJson(folderPath, activeDriveLinks),
        generateResumePaginateJson(folderPath, activeDriveLinks),
      ]);
    }

    // ── Phase C: Upload All 7 Files in ONE Single Parallel Batch ──
    const filesToUpload: PreparedDriveFileEntry[] = [
      {
        name: pdfFileName,
        buffer: await fs.readFile(compileResult.pdfPath),
        mimeType: "application/pdf",
        pregeneratedId: pdfFileId,
      },
      {
        name: RESUME_TXT_FILE_NAME,
        buffer: await fs.readFile(path.join(folderPath, RESUME_TXT_FILE_NAME)),
        mimeType: "text/plain",
      },
      {
        name: META_FILE_NAME,
        buffer: await fs.readFile(path.join(folderPath, META_FILE_NAME)),
        mimeType: "application/json",
      },
      {
        name: JOB_URL_FILE_NAME,
        buffer: await fs.readFile(path.join(folderPath, JOB_URL_FILE_NAME)),
        mimeType: "text/plain",
      },
      {
        name: PROFILE_FILE_NAME,
        buffer: await fs.readFile(profileResult.profilePath),
        mimeType: "application/json",
      },
      {
        name: RESUME_JSON_FILE_NAME,
        buffer: await fs.readFile(resumeJsonResult.resumeJsonPath),
        mimeType: "application/json",
      },
      {
        name: RESUME_PAGINATE_JSON_FILE_NAME,
        buffer: await fs.readFile(resumePaginateJsonResult.resumePaginateJsonPath),
        mimeType: "application/json",
      },
    ];

    const batchUploadResult = await uploadPreparedDriveFiles({
      drive: drivePrep.drive!,
      jobFolderId: drivePrep.jobFolderId,
      files: filesToUpload,
      existingFiles: drivePrep.existingFiles,
    });

    if (!batchUploadResult.ok || !batchUploadResult.files[pdfFileName]?.fileId) {
      console.error(
        `[Drive] ❌ batch upload incomplete | folderName=${folderName} | error=${batchUploadResult.error || "unknown"}`
      );
      return NextResponse.json(
        {
          success: false,
          error: "drive_upload_failed",
          details: batchUploadResult.error || "Drive upload incomplete",
          folderName,
        },
        { status: 502 }
      );
    }

    const driveJobFolderId = drivePrep.jobFolderId;
    const finalPdfDrive = batchUploadResult.files[pdfFileName];
    activeDriveLinks = buildDriveResumeLinks(baseUrl, finalPdfDrive.fileId);
    console.log(`[Drive] ✅ all 7 files uploaded in parallel | folderName=${folderName} | jobFolderId=${driveJobFolderId}`);

    // Phase D: Update Mongo Dashboard Index
    await upsertResumeDashboardItem({
      mode,
      email: emailFromLatex,
      folder: folderName,
      jobUrl,
      pdfFile: pdfFileName,
      createdAt: meta.createdAt,
    });

    return NextResponse.json({
      success: true,
      folderName,
      folderPath,
      pdfBytes: pdfStats.size,
      profileBytes: profileResult.profileBytes,
      resumeJsonBytes: resumeJsonResult.resumeJsonBytes,
      resumePaginateJsonBytes: resumePaginateJsonResult.resumePaginateJsonBytes,
      links: activeDriveLinks,
      files: {
        jobUrl: path.join(folderPath, JOB_URL_FILE_NAME),
        latex: path.join(folderPath, TEX_FILE_NAME),
        pdf: compileResult.pdfPath,
        profile: profileResult.profilePath,
        resumeJson: resumeJsonResult.resumeJsonPath,
        resumePaginateJson: resumePaginateJsonResult.resumePaginateJsonPath,
        log: path.join(folderPath, "resume.log"),
        meta: path.join(folderPath, META_FILE_NAME),
      },
    });
  } catch (error) {
    console.error("Resume generation error:", error);
    return NextResponse.json(
      { error: "Internal server error", details: String(error) },
      { status: 500 }
    );
  }
}
