#!/usr/bin/env node
/**
 * Import Jobs from Google Spreadsheet to MongoDB.
 *
 * Reads job listings from Google Spreadsheet tabs (e.g. Jobright, Jobright-Internships,
 * Simplify-Jobs, Simplify-Internships, Jobs, Jobs-Internships).
 *
 * Filters by:
 *   1. Posted date (default: >= 2026-09-15 for initial setup).
 *   2. ATS Type: ONLY Greenhouse, Workday, or JobRight links (which resolve to ATS).
 *
 * Usage:
 *   npm run import-sheet
 *   npm run import-sheet -- --sheetId=YOUR_SPREADSHEET_ID
 *   npm run import-sheet -- --since=2026-09-15
 *   npm run import-sheet -- --sheetId=YOUR_SPREADSHEET_ID --since=2026-09-15
 *
 * Required Env Vars (or CLI options):
 *   SHEET_ID (or GOOGLE_SHEET_ID) - Google Spreadsheet ID
 *   GOOGLE_SERVICE_ACCOUNT_FILE / GOOGLE_SERVICE_ACCOUNT_JSON - Service Account credentials (defaults to gen-lang-client.json if present)
 *   MONGODB_URI - Database connection string (automatically loaded from user env)
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import { applyUserMongoEnv } from "./lib/user-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const mongoose = require("mongoose");

// Parse CLI arguments
function parseCliArgs(args) {
  const out = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      out.set(arg.slice(2, eqIdx), arg.slice(eqIdx + 1));
    } else {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        out.set(key, next);
        i += 1;
      } else {
        out.set(key, "true");
      }
    }
  }
  return out;
}

const CLI_ARGS = parseCliArgs(process.argv.slice(2));

function getCliOrEnv(key, envKeys = []) {
  if (CLI_ARGS.has(key)) return CLI_ARGS.get(key);
  for (const envKey of envKeys) {
    if (process.env[envKey]) return process.env[envKey];
  }
  return "";
}

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "ref", "referrer", "src", "source", "fbclid", "gclid"
]);

function hashId(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 24);
}

function isNumericToken(value) {
  return typeof value === "string" && /^\d+$/.test(value.trim());
}

function extractGreenhouseToken(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return null;
  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();
    const isGreenhouseHost = hostname === "greenhouse.io" || hostname.endsWith(".greenhouse.io");

    const token = url.searchParams.get("token");
    if (isNumericToken(token)) return token;

    const ghJid = url.searchParams.get("gh_jid");
    if (isNumericToken(ghJid)) return ghJid;

    if (isGreenhouseHost) {
      const jobsMatch = url.pathname.match(/\/jobs\/(\d+)(?:\/|$)/i);
      if (jobsMatch?.[1]) return jobsMatch[1];
    }
  } catch {
    // Fall through
  }

  const tokenMatch = input.match(/[?&]token=(\d+)/i);
  if (tokenMatch?.[1]) return tokenMatch[1];
  const ghJidMatch = input.match(/[?&]gh_jid=(\d+)/i);
  if (ghJidMatch?.[1]) return ghJidMatch[1];
  return null;
}

function buildGreenhouseEmbedUrl(token) {
  return `https://boards.greenhouse.io/embed/job_app?token=${encodeURIComponent(token)}`;
}

function normalizeJobUrlForStorage(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";

  const token = extractGreenhouseToken(input);
  if (token) return buildGreenhouseEmbedUrl(token);

  try {
    const url = new URL(input);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url.toString().replace(/\?$/, "");
  } catch {
    return input;
  }
}

function extractJobrightId(urlStr) {
  const match = String(urlStr || "").match(/jobright\.ai\/jobs\/info\/([a-f0-9]{24})/i);
  if (match?.[1]) return match[1];
  const idMatch = String(urlStr || "").match(/\b([a-f0-9]{24})\b/i);
  if (idMatch?.[1] && urlStr.includes("jobright")) return idMatch[1];
  return null;
}

function isWorkdayUrl(urlStr) {
  const lower = String(urlStr || "").toLowerCase();
  return lower.includes("myworkdayjobs.com") || lower.includes("myworkdaysite.com") || lower.includes("workday");
}

function isGreenhouseUrl(urlStr) {
  const lower = String(urlStr || "").toLowerCase();
  return lower.includes("greenhouse.io") || Boolean(extractGreenhouseToken(urlStr));
}

function isSupportedAts(urlStr) {
  return isGreenhouseUrl(urlStr) || isWorkdayUrl(urlStr);
}

const INTERN_REGEX = /\b(intern|interns|internship|internships|co-op|coop)\b/i;

function isInternship(title, jobType = "", sheetTitle = "") {
  if (sheetTitle && sheetTitle.toLowerCase().includes("intern")) return true;
  if (title && INTERN_REGEX.test(title)) return true;
  if (jobType && INTERN_REGEX.test(jobType)) return true;
  return false;
}

function buildJobrightHeaders(kind = "html") {
  const headers = {
    accept:
      kind === "json"
        ? "application/json, text/plain, */*"
        : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    priority: "u=1, i",
    "sec-ch-ua": '"Chromium";v="152", "Not?A_Brand";v="24", "Brave";v="152"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": kind === "json" ? "empty" : "document",
    "sec-fetch-mode": kind === "json" ? "cors" : "navigate",
    "sec-fetch-site": "same-origin",
    ...(kind === "html" ? { "sec-fetch-user": "?1", "upgrade-insecure-requests": "1" } : {}),
    "sec-gpc": "1",
    "user-agent":
      process.env.JOBRIGHT_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    referer: kind === "json" ? "https://jobright.ai/jobs/recommend" : "https://jobright.ai/",
    "x-client-type": "web",
  };
  if (process.env.JOBRIGHT_COOKIE) headers.cookie = process.env.JOBRIGHT_COOKIE;
  return headers;
}

const jobrightUrlCache = new Map();

async function resolveJobrightOriginalUrl(jobrightId) {
  if (!jobrightId) return null;
  if (jobrightUrlCache.has(jobrightId)) return jobrightUrlCache.get(jobrightId);

  try {
    const res = await fetch(`https://jobright.ai/jobs/info/${encodeURIComponent(jobrightId)}`, {
      headers: buildJobrightHeaders("html"),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      jobrightUrlCache.set(jobrightId, null);
      return null;
    }
    const html = await res.text();
    const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match?.[1]) {
      jobrightUrlCache.set(jobrightId, null);
      return null;
    }
    const data = JSON.parse(match[1]);
    const job = data?.props?.pageProps?.dataSource?.jobResult;
    const rawLink = job?.applyLink || job?.originalUrl || null;
    jobrightUrlCache.set(jobrightId, rawLink);
    return rawLink;
  } catch {
    jobrightUrlCache.set(jobrightId, null);
    return null;
  }
}

async function resolveJobrightBatch(jobrightIds) {
  const unique = [...new Set(jobrightIds.filter((id) => id && !jobrightUrlCache.has(id)))];
  if (!unique.length) return;

  const BATCH_SIZE = 15;
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE);
    await Promise.all(chunk.map((id) => resolveJobrightOriginalUrl(id)));
  }
}

async function getSheetsClient(customServiceAccountFile) {
  const jsonContent = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const jsonFile = customServiceAccountFile || getCliOrEnv("serviceAccountFile", ["GOOGLE_SERVICE_ACCOUNT_FILE", "GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE"]) || "gen-lang-client.json";

  let credentials = null;

  if (jsonContent) {
    try {
      credentials = JSON.parse(jsonContent);
    } catch (err) {
      console.warn("Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:", err.message);
    }
  }

  if (!credentials) {
    const resolvedPath = path.isAbsolute(jsonFile) ? jsonFile : path.resolve(ROOT, jsonFile);
    try {
      const raw = await fs.readFile(resolvedPath, "utf8");
      credentials = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Could not load Google Service Account JSON from ${resolvedPath}: ${err.message}`);
    }
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  return google.sheets({ version: "v4", auth });
}

function parseRowDate(dateStr) {
  if (!dateStr || !dateStr.trim()) return null;
  const str = dateStr.trim();
  const d = new Date(str);
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}

export async function importGoogleSheet(options = {}) {
  const sheetId = options.sheetId || getCliOrEnv("sheetId", ["SHEET_ID", "GOOGLE_SHEET_ID", "SPREADSHEET_ID"]);
  const sinceDateStr = options.since || getCliOrEnv("since", ["IMPORT_CUTOFF_DATE"]) || "2026-09-15";

  if (!sheetId) {
    console.log("[import-sheet] No SHEET_ID configured. Skipping Google Sheet import.");
    return { success: false, reason: "missing_sheet_id" };
  }

  const cutoffDate = new Date(sinceDateStr);
  if (Number.isNaN(cutoffDate.getTime())) {
    console.error(`[import-sheet] Invalid cutoff date: ${sinceDateStr}`);
    return { success: false, reason: "invalid_cutoff_date" };
  }
  console.log(`[import-sheet] Starting import for Sheet ID: ${sheetId} (since ${cutoffDate.toISOString().slice(0, 10)}) [Filtering: Greenhouse & Workday ONLY, Excluding Internships]`);

  const mongoUri = applyUserMongoEnv(ROOT);
  if (!mongoUri) {
    console.error("[import-sheet] No MONGODB_URI found.");
    return { success: false, reason: "missing_mongo_uri" };
  }

  const disconnectOnFinish = mongoose.connection.readyState === 0;
  if (disconnectOnFinish) {
    await mongoose.connect(mongoUri);
  }

  const JobSchema = new mongoose.Schema(
    {
      jobId: { type: String, required: true, unique: true, index: true },
      title: { type: String, default: "" },
      company: { type: String, default: "" },
      location: { type: String, default: "" },
      salary: { type: String, default: "" },
      workModel: { type: String, default: "" },
      industry: { type: [String], default: [] },
      companySize: { type: String, default: "" },
      qualifications: { type: String, default: "" },
      expLevel: { type: String, default: "" },
      jobFunction: { type: String, default: "" },
      h1bSponsored: { type: String, default: "" },
      isNewGrad: { type: Boolean, default: false },
      roleType: { type: String, default: "" },
      hireTime: { type: String, default: "" },
      graduateTime: { type: String, default: "" },
      tabCategory: { type: [String], default: [] },
      postedAt: { type: Date, default: Date.now },
      fetchedAt: { type: Date, default: Date.now },
      applied: { type: Boolean, default: false },
      appliedAt: { type: Date, default: null },
      autoApplied: { type: Boolean, default: false, index: true },
      autoAppliedAt: { type: Date, default: null },
      manualApplied: { type: Boolean, default: false, index: true },
      manualAppliedAt: { type: Date, default: null },
      notInterested: { type: Boolean, default: false },
      top500: { type: Boolean, default: false },
      companyRank: { type: Number, default: 999999 },
      matchScore: { type: Number, default: null, index: true },
      jobrightId: { type: String, default: "", index: true },
      jobrightAliases: { type: [String], default: [], index: true },
      sourceTags: { type: [String], default: [], index: true },
      sourceDetails: { type: Array, default: [] },
      sourceKind: { type: String, default: "", index: true },
      sourceRepo: { type: String, default: "", index: true },
      sourceLabel: { type: String, default: "" },
      isH1bSponsor: { type: Boolean, default: null },
      isCitizenOnly: { type: Boolean, default: null },
      minSalary: { type: Number, default: null },
      maxSalary: { type: Number, default: null },
      notEligible: { type: Boolean, default: false },
      notEligibleReason: { type: String, default: "" },
      eligibilityStatus: { type: String, default: "eligible" },
      applyLink: { type: String, default: "" },
      recruiterName: { type: String, default: "" },
      recruiterProfileUrl: { type: String, default: "" },
      detailsFetchedAt: { type: Date, default: null },
      detailsFetchStatus: { type: String, default: "pending" },
      inactive: { type: Boolean, default: false },
      isExtraApiJob: { type: Boolean, default: false },
    },
    { timestamps: true }
  );

  const Job = mongoose.models.Job || mongoose.model("Job", JobSchema);

  // 1. Clean up any existing internships originating from Google Sheet
  const internCleanup = await Job.deleteMany({
    sourceKind: { $in: ["google-sheet", "jobright-sheet"] },
    $or: [
      { title: { $regex: "\\b(intern|interns|internship|internships|co-op|coop)\\b", $options: "i" } },
      { tabCategory: { $regex: "intern", $options: "i" } },
    ],
  });
  if (internCleanup.deletedCount > 0) {
    console.log(`[import-sheet] Cleaned up ${internCleanup.deletedCount} internship jobs from DB.`);
  }

  // 2. Clean up any sheet jobs that are NOT Greenhouse or Workday
  const nonAtsCleanup = await Job.deleteMany({
    sourceKind: { $in: ["google-sheet", "jobright-sheet"] },
    applyLink: { $not: { $regex: "greenhouse|myworkdayjobs|myworkdaysite|workday", $options: "i" } },
  });
  if (nonAtsCleanup.deletedCount > 0) {
    console.log(`[import-sheet] Cleaned up ${nonAtsCleanup.deletedCount} non-Greenhouse/Workday sheet jobs from DB.`);
  }

  const sheets = await getSheetsClient(options.serviceAccountFile);
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const sheetNames = (meta.data.sheets || [])
    .map((s) => s.properties?.title)
    .filter((title) => title && !title.startsWith("_"));

  let totalParsed = 0;
  let totalImported = 0;
  let totalSkippedDate = 0;
  let totalSkippedAts = 0;
  let totalSkippedIntern = 0;
  let totalDuplicates = 0;

  for (const sheetTitle of sheetNames) {
    if (sheetTitle.toLowerCase().includes("intern")) {
      console.log(`[import-sheet] Skipping internship tab: "${sheetTitle}"`);
      continue;
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetTitle}!A1:Z`,
    });

    const rows = res.data.values || [];
    if (rows.length <= 1) continue;

    const header = rows[0].map((h) => String(h || "").trim().toLowerCase());
    const companyIdx = header.indexOf("company") !== -1 ? header.indexOf("company") : 0;
    const positionIdx = header.indexOf("position") !== -1 ? header.indexOf("position") : (header.indexOf("title") !== -1 ? header.indexOf("title") : 1);
    const linkIdx = header.indexOf("apply link") !== -1 ? header.indexOf("apply link") : (header.indexOf("link") !== -1 ? header.indexOf("link") : 2);
    const dateIdx = header.indexOf("posted date") !== -1 ? header.indexOf("posted date") : (header.indexOf("date") !== -1 ? header.indexOf("date") : 3);
    const jobTypeIdx = header.indexOf("job type") !== -1 ? header.indexOf("job type") : 5;

    const dataRows = rows.slice(1);

    // Collect candidate jobright IDs for batch resolution
    const jobrightIdsToFetch = [];
    for (const row of dataRows) {
      const company = String(row[companyIdx] || "").trim();
      const title = String(row[positionIdx] || "").trim();
      const rawApplyLink = String(row[linkIdx] || "").trim();
      const jobType = String(row[jobTypeIdx] || "").trim();
      if (!company || !title || !rawApplyLink) continue;
      if (isInternship(title, jobType, sheetTitle)) continue;

      const jrId = extractJobrightId(rawApplyLink);
      if (jrId) jobrightIdsToFetch.push(jrId);
    }

    // Resolve JobRight links in parallel batches
    if (jobrightIdsToFetch.length > 0) {
      await resolveJobrightBatch(jobrightIdsToFetch);
    }

    const bulkOps = [];

    for (const row of dataRows) {
      totalParsed += 1;
      const company = String(row[companyIdx] || "").trim();
      const title = String(row[positionIdx] || "").trim();
      const rawApplyLink = String(row[linkIdx] || "").trim();
      const dateStr = String(row[dateIdx] || "").trim();
      const jobType = String(row[jobTypeIdx] || "").trim() || "Full-Time";

      if (!company || !title || !rawApplyLink) continue;

      // 1. Check Internship Filter: Skip any internship jobs
      if (isInternship(title, jobType, sheetTitle)) {
        totalSkippedIntern += 1;
        continue;
      }

      // 2. Check Date Filter
      const postedAt = parseRowDate(dateStr) || new Date();
      if (postedAt < cutoffDate) {
        totalSkippedDate += 1;
        continue;
      }

      // 3. Resolve Apply Link & Check ATS Filter (Greenhouse or Workday ONLY)
      const jobrightId = extractJobrightId(rawApplyLink);
      let targetApplyUrl = rawApplyLink;

      if (jobrightId) {
        const resolved = jobrightUrlCache.get(jobrightId);
        if (resolved) {
          targetApplyUrl = resolved;
        } else {
          // Could not resolve JobRight link
          totalSkippedAts += 1;
          continue;
        }
      }

      if (!isSupportedAts(targetApplyUrl)) {
        totalSkippedAts += 1;
        continue;
      }

      const normalizedApplyLink = normalizeJobUrlForStorage(targetApplyUrl);
      const ghToken = extractGreenhouseToken(normalizedApplyLink);
      let jobId = "";

      if (ghToken) {
        jobId = `greenhouse:${ghToken}`;
      } else {
        jobId = `sheet:${hashId(normalizedApplyLink)}`;
      }

      const doc = {
        jobId,
        jobrightId: jobrightId || "",
        title,
        company,
        location: "",
        postedAt,
        fetchedAt: new Date(),
        tabCategory: [jobType.toLowerCase(), "google-sheet", sheetTitle.toLowerCase()],
        sourceKind: jobrightId ? "jobright-sheet" : "google-sheet",
        sourceLabel: `Google Sheet: ${sheetTitle}`,
        applyLink: normalizedApplyLink,
        detailsFetchStatus: "ok",
      };

      bulkOps.push({
        updateOne: {
          filter: { jobId },
          update: {
            $setOnInsert: doc,
          },
          upsert: true,
        },
      });
    }

    if (bulkOps.length > 0) {
      const result = await Job.bulkWrite(bulkOps, { ordered: false });
      const upserted = result.upsertedCount || 0;
      totalImported += upserted;
      totalDuplicates += (bulkOps.length - upserted);
    }
  }

  console.log(`[import-sheet] Finished: ${totalImported} new jobs imported (${totalDuplicates} dupes skipped, ${totalSkippedAts} non-Greenhouse/Workday skipped, ${totalSkippedIntern} internships skipped, ${totalSkippedDate} before ${sinceDateStr}).`);

  if (disconnectOnFinish) {
    await mongoose.disconnect();
  }

  return {
    success: true,
    totalParsed,
    totalImported,
    totalDuplicates,
    totalSkippedAts,
    totalSkippedIntern,
    totalSkippedDate,
  };
}

// Direct CLI Execution
if (process.argv[1] && process.argv[1].endsWith("import-google-sheet.mjs")) {
  importGoogleSheet().catch((err) => {
    console.error("\n[FATAL] Import pipeline error:", err);
    process.exit(1);
  });
}
