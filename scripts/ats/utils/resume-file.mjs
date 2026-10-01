import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDataPath } from "../../lib/user-config.mjs";

const DEFAULT_KEY_LENGTH = 18;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 32;

function clampLength(value) {
  if (!Number.isFinite(value)) return DEFAULT_KEY_LENGTH;
  return Math.max(MIN_KEY_LENGTH, Math.min(MAX_KEY_LENGTH, Math.floor(value)));
}

function resolveKeyLength() {
  return clampLength(Number(process.env.RESUME_FOLDER_KEY_LENGTH || DEFAULT_KEY_LENGTH));
}

function toNumericHash(input) {
  const bytes = createHash("sha256").update(String(input || "")).digest();
  return Array.from(bytes, (byte) => String(byte % 10)).join("");
}

function hashUrl(url) {
  return `u${toNumericHash(url).slice(0, resolveKeyLength())}`;
}

function getLegacyResumeFolderNameFromUrl(jobUrl) {
  return encodeURIComponent(String(jobUrl || "").trim());
}

function removeJobrightTrackingParam(url) {
  const values = url.searchParams.getAll("utm_source");
  if (values.some((value) => String(value || "").toLowerCase() === "jobright")) {
    url.searchParams.delete("utm_source");
  }
}

export function normalizeAshbyApplicationUrl(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";

  try {
    const url = new URL(input);
    if (url.hostname.toLowerCase() !== "jobs.ashbyhq.com") return input;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return input;

    const companySlug = parts[0].toLowerCase();
    const jobId = parts[1].toLowerCase();
    return `https://jobs.ashbyhq.com/${companySlug}/${jobId}`;
  } catch {
    return input;
  }
}

function normalizeGreenhouseUrl(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";

  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();
    const isGreenhouseHost = hostname === "greenhouse.io" || hostname.endsWith(".greenhouse.io");
    const token = url.searchParams.get("token") || url.searchParams.get("gh_jid");
    if (/^\d+$/.test(String(token || "").trim())) {
      return `https://boards.greenhouse.io/embed/job_app?token=${encodeURIComponent(token)}`;
    }

    if (isGreenhouseHost) {
      const pathToken = url.pathname.match(/\/jobs\/(\d+)(?:\/|$)/i)?.[1];
      if (pathToken) return `https://boards.greenhouse.io/embed/job_app?token=${encodeURIComponent(pathToken)}`;
    }
  } catch {
    // Keep the original URL.
  }

  return input;
}

export function normalizeJobUrlForResumeStorage(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";

  let stripped = input;
  try {
    const url = new URL(input);
    removeJobrightTrackingParam(url);
    stripped = url.toString();
  } catch {
    stripped = input
      .replace(/([?&])utm_source=jobright(&|$)/gi, (_m, leading, trailing) => {
        if (leading === "?" && trailing === "&") return "?";
        if (leading === "&" && trailing === "&") return "&";
        return "";
      })
      .replace(/[?&]$/, "");
  }

  const greenhouse = normalizeGreenhouseUrl(stripped);
  if (greenhouse !== stripped) return greenhouse;

  const ashby = normalizeAshbyApplicationUrl(stripped);
  if (ashby !== stripped) return ashby;

  return stripped;
}

export function getResumeFolderCandidatesFromUrl(jobUrl) {
  const raw = String(jobUrl || "").trim();
  const canonical = normalizeJobUrlForResumeStorage(raw);
  const rawKey = hashUrl(raw);

  const utmStripped = (() => {
    try {
      const url = new URL(raw);
      [...url.searchParams.keys()]
        .filter((key) => key.toLowerCase().startsWith("utm_"))
        .forEach((key) => url.searchParams.delete(key));
      return url.toString();
    } catch {
      return raw;
    }
  })();

  return [...new Set([
    hashUrl(canonical),
    rawKey,
    hashUrl(utmStripped),
    getLegacyResumeFolderNameFromUrl(raw),
  ])];
}

async function readAutoApplyEmail(projectRoot) {
  try {
    const raw = await readFile(getDataPath(projectRoot, "current-emails.json"), "utf8");
    const parsed = JSON.parse(raw);
    return String(parsed?.autoApplyEmail || "").trim();
  } catch {
    return "";
  }
}

async function fetchPdf(url) {
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok || !contentType.includes("pdf")) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      error: text.slice(0, 300) || contentType || "not_pdf",
      bytes: null,
    };
  }
  return {
    ok: true,
    status: res.status,
    error: "",
    bytes: Buffer.from(await res.arrayBuffer()),
  };
}

export async function downloadResumePdfForJob({
  jobUrl,
  origin = process.env.JOBTRACK_API_ORIGIN || "http://localhost:3000",
  projectRoot = process.cwd(),
}) {
  const base = String(origin || "").replace(/\/+$/, "");
  const errors = [];

  const directUrl = `${base}/api/resume/file?jobUrl=${encodeURIComponent(jobUrl)}&download=1`;
  const direct = await fetchPdf(directUrl).catch((error) => ({
    ok: false,
    status: 0,
    error: error instanceof Error ? error.message : String(error),
    bytes: null,
  }));
  if (direct.ok && direct.bytes) return writeTempResumePdf(direct.bytes);
  errors.push(`resume/file:${direct.status}:${direct.error}`);

  const email = await readAutoApplyEmail(projectRoot);
  if (email) {
    for (const folder of getResumeFolderCandidatesFromUrl(jobUrl)) {
      const url = `${base}/api/resume-dashboard/file?email=${encodeURIComponent(email)}&mode=autoApply&folder=${encodeURIComponent(folder)}`;
      const result = await fetchPdf(url).catch((error) => ({
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : String(error),
        bytes: null,
      }));
      if (result.ok && result.bytes) return writeTempResumePdf(result.bytes);
      errors.push(`resume-dashboard/${folder}:${result.status}:${result.error}`);
    }
  } else {
    errors.push("current-emails:autoApplyEmail_missing");
  }

  throw new Error(`resume_pdf_not_found:${errors.join(" | ")}`);
}

async function writeTempResumePdf(bytes) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ashby-resume-"));
  const filePath = path.join(dir, "resume.pdf");
  await writeFile(filePath, bytes);
  return {
    filePath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
