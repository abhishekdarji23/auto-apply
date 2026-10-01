#!/usr/bin/env node
/**
 * Fetch new-grad job sources into Mongo.
 *
 * GitHub markdown sources:
 *   npm.cmd run github-jobs
 *   npm.cmd run fetch-github-repos
 *
 * Hourly loop:
 *   npm.cmd run daily-cron
 *
 * One-time broad setup/backfill:
 *   npm.cmd run jobs-setup-once
 *
 * Limit sources:
 *   npm.cmd run github-jobs -- --only=jobright-api
 *   npm.cmd run github-jobs -- --only=jobright-minisite
 *   npm.cmd run github-jobs -- --only=github
 *   npm.cmd run github-jobs -- --only=jobright-github
 *   npm.cmd run github-jobs -- --skip=jobright-api
 */

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { applyUserMongoEnv, getMongoEnvHint } from "../lib/user-config.mjs";
import { importGoogleSheet } from "../import-google-sheet.mjs";
import { classifyJobTitle } from "../lib/job-classifier.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const mongoose = require("mongoose");

const ROOT = path.resolve(__dirname, "..", "..");
const LOOP_INTERVAL_MS = Number.parseInt(process.env.GITHUB_JOBS_CRON_MS || "", 10) || 60 * 60 * 1000;
const JOBRIGHT_INFO_URL = "https://jobright.ai/jobs/info";
const JOBRIGHT_RECOMMEND_URL = "https://jobright.ai/swan/recommend/list/jobs";
const JOBRIGHT_MINISITE_URL = "https://jobright.ai/swan/mini-sites/list";
const CLI_ARGS = parseCliArgs(process.argv.slice(2));

const DAILY_JOBRIGHT_RECOMMEND_SORT_PLAN = [
  { sortCondition: "1", pages: 10 },
  { sortCondition: "0", pages: 5 },
  { sortCondition: "2", pages: 5 },
];

const SETUP_JOBRIGHT_RECOMMEND_SORT_PLAN = [
  { sortCondition: "1", pages: 50 },
  { sortCondition: "0", pages: 50 },
  { sortCondition: "2", pages: 50 },
];

const GITHUB_SOURCES = [
  {
    key: "simplify",
    url: "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md",
  },
  {
    key: "speedy-swe",
    url: "https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/NEW_GRAD_USA.md",
  },
  {
    key: "speedy-ai",
    url: "https://raw.githubusercontent.com/speedyapply/2027-AI-College-Jobs/main/NEW_GRAD_USA.md",
  },
];

const JOBRIGHT_GITHUB_SOURCES = [
  {
    key: "jobright-swe",
    source: "jobright-swe",
    url: "https://raw.githubusercontent.com/jobright-ai/2026-Software-Engineer-New-Grad/master/README.md",
  },
  {
    key: "jobright-data",
    source: "jobright-data",
    url: "https://raw.githubusercontent.com/jobright-ai/2026-Data-Analysis-New-Grad/master/README.md",
  },
];

const JOBRIGHT_MINISITE_CATEGORIES = [
  { category: "newgrad:us:swe", source: "jobright-minisite-swe", label: "JobRight Minisite SWE" },
  { category: "newgrad:us:data_analysis", source: "jobright-minisite-data-analysis", label: "JobRight Minisite Data Analysis" },
  { category: "newgrad:us:ml_ai", source: "jobright-minisite-ml-ai", label: "JobRight Minisite ML AI" },
  { category: "newgrad:us:data_engineer", source: "jobright-minisite-data-engineer", label: "JobRight Minisite Data Engineer" },
];

const SOURCE_METADATA = {
  "jobright-recommend": {
    kind: "jobright-api",
    label: "JobRight API",
    repo: "",
    url: JOBRIGHT_RECOMMEND_URL,
  },
  "jobright-minisite-swe": {
    kind: "jobright-minisite",
    label: "JobRight Minisite SWE",
    repo: "",
    url: JOBRIGHT_MINISITE_URL,
  },
  "jobright-minisite-data-analysis": {
    kind: "jobright-minisite",
    label: "JobRight Minisite Data Analysis",
    repo: "",
    url: JOBRIGHT_MINISITE_URL,
  },
  "jobright-minisite-ml-ai": {
    kind: "jobright-minisite",
    label: "JobRight Minisite ML AI",
    repo: "",
    url: JOBRIGHT_MINISITE_URL,
  },
  "jobright-minisite-data-engineer": {
    kind: "jobright-minisite",
    label: "JobRight Minisite Data Engineer",
    repo: "",
    url: JOBRIGHT_MINISITE_URL,
  },
  "jobright-swe": {
    kind: "jobright-github",
    label: "JobRight GitHub SWE",
    repo: "jobright-ai/2026-Software-Engineer-New-Grad",
    url: JOBRIGHT_GITHUB_SOURCES.find((source) => source.key === "jobright-swe")?.url || "",
  },
  "jobright-data": {
    kind: "jobright-github",
    label: "JobRight GitHub Data",
    repo: "jobright-ai/2026-Data-Analysis-New-Grad",
    url: JOBRIGHT_GITHUB_SOURCES.find((source) => source.key === "jobright-data")?.url || "",
  },
  "simplify-swe": {
    kind: "github",
    label: "SimplifyJobs SWE",
    repo: "SimplifyJobs/New-Grad-Positions",
    url: GITHUB_SOURCES.find((source) => source.key === "simplify")?.url || "",
  },
  "simplify-ds-ai-ml": {
    kind: "github",
    label: "SimplifyJobs DS AI ML",
    repo: "SimplifyJobs/New-Grad-Positions",
    url: GITHUB_SOURCES.find((source) => source.key === "simplify")?.url || "",
  },
  "simplify-quant": {
    kind: "github",
    label: "SimplifyJobs Quant",
    repo: "SimplifyJobs/New-Grad-Positions",
    url: GITHUB_SOURCES.find((source) => source.key === "simplify")?.url || "",
  },
  "speedy-swe": {
    kind: "github",
    label: "SpeedyApply SWE",
    repo: "speedyapply/2027-SWE-College-Jobs",
    url: GITHUB_SOURCES.find((source) => source.key === "speedy-swe")?.url || "",
  },
  "speedy-ai": {
    kind: "github",
    label: "SpeedyApply AI",
    repo: "speedyapply/2027-AI-College-Jobs",
    url: GITHUB_SOURCES.find((source) => source.key === "speedy-ai")?.url || "",
  },
};

const DEFAULT_JOBRIGHT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const DATE_ONLY_PACIFIC_HOUR = 0;
const DATE_ONLY_PACIFIC_MINUTE = 1;

function parseCliArgs(args) {
  const out = new Map();
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      out.set(arg.slice(2, eqIdx), arg.slice(eqIdx + 1));
      continue;
    }

    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      out.set(key, next);
      i += 1;
    } else {
      out.set(key, "true");
    }
  }

  if (positional[0] && !out.has("only")) out.set("only", positional[0]);
  return out;
}

function cliValue(...names) {
  for (const name of names) {
    if (CLI_ARGS.has(name)) return CLI_ARGS.get(name);
  }
  return "";
}

function getRunMode() {
  const raw = String(cliValue("mode") || "").trim().toLowerCase();
  if (raw === "setup" || CLI_ARGS.has("setup") || CLI_ARGS.has("setup-once") || CLI_ARGS.has("backfill")) return "setup";
  return "daily";
}

function isSetupMode() {
  return getRunMode() === "setup";
}

function getJobrightRecommendSortPlan() {
  return isSetupMode() ? SETUP_JOBRIGHT_RECOMMEND_SORT_PLAN : DAILY_JOBRIGHT_RECOMMEND_SORT_PLAN;
}

function getJobrightMinisiteMaxPages() {
  if (!isSetupMode()) return envInt("JOBRIGHT_MINISITE_DAILY_PAGES", 1);
  return envInt("JOBRIGHT_MINISITE_SETUP_MAX_PAGES", 500);
}

function splitCliList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function applySourceToken(plan, token, enabled) {
  switch (token) {
    case "all":
      plan.jobrightApi = enabled;
      plan.jobrightMinisite = enabled;
      plan.simplify = enabled;
      plan.speedy = enabled;
      plan.jobrightGithub = enabled;
      break;
    case "github":
    case "github-repos":
    case "repos":
      plan.simplify = enabled;
      plan.speedy = enabled;
      plan.jobrightGithub = enabled;
      break;
    case "public-github":
    case "non-jobright-github":
      plan.simplify = enabled;
      plan.speedy = enabled;
      break;
    case "simplify":
    case "simplifyjobs":
      plan.simplify = enabled;
      break;
    case "speedy":
    case "speedyapply":
      plan.speedy = enabled;
      break;
    case "jobright":
      plan.jobrightApi = enabled;
      plan.jobrightMinisite = enabled;
      plan.jobrightGithub = enabled;
      break;
    case "jobright-api":
    case "api":
    case "recommend":
    case "recommendation":
      plan.jobrightApi = enabled;
      break;
    case "jobright-github":
    case "jobright-repos":
      plan.jobrightGithub = enabled;
      break;
    case "jobright-minisite":
    case "jobright-minisites":
    case "minisite":
    case "mini-sites":
      plan.jobrightMinisite = enabled;
      break;
    default:
      throw new Error(`Unknown source token '${token}'. Use all, github, public-github, simplify, speedy, jobright, jobright-api, jobright-minisite, or jobright-github.`);
  }
}

function getFetchPlan() {
  const only = splitCliList(cliValue("only", "source", "sources"));
  const skip = splitCliList(cliValue("skip", "exclude"));
  const plan = only.length
    ? { jobrightApi: false, jobrightMinisite: false, simplify: false, speedy: false, jobrightGithub: false }
    : { jobrightApi: true, jobrightMinisite: true, simplify: true, speedy: true, jobrightGithub: true };

  for (const token of only) applySourceToken(plan, token, true);
  for (const token of skip) applySourceToken(plan, token, false);
  return plan;
}

function describeFetchPlan(plan) {
  const enabled = [];
  if (plan.jobrightApi) enabled.push("jobright-api");
  if (plan.jobrightMinisite) enabled.push("jobright-minisite");
  if (plan.simplify) enabled.push("simplify");
  if (plan.speedy) enabled.push("speedy");
  if (plan.jobrightGithub) enabled.push("jobright-github");
  return enabled.join(",") || "none";
}

function envInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFloat(name, fallback) {
  const parsed = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

const SIMPLIFY_SECTIONS = [
  {
    heading: "## 💻 Software Engineering New Grad Roles",
    source: "simplify-swe",
  },
  {
    heading: "## 🤖 Data Science, AI & Machine Learning New Grad Roles",
    source: "simplify-ds-ai-ml",
  },
  {
    heading: "## 📈 Quantitative Finance New Grad Roles",
    source: "simplify-quant",
  },
];

const JOBRIGHT_EXCLUDED_TITLES = [
  "AI Trainer",
  "AI Tutor",
  "AI Training",
  "AI Coach",
  "AI Reviewer",
  "AI Rater",
  "AI Content Evaluator",
  "Search Quality Rater",
  "Ads Quality Rater",
  "Annotator",
  "Annotation Specialist",
  "Data Annotation",
  "AI Annotation",
  "Data Labeler",
  "Data Labeling",
  "Labeler",
  "AI Data Specialist",
  "Data Collector",
  "Data Collection",
  "Prompt Optimization",
  "Prompt Creator",
];

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "referrer",
  "src",
  "source",
  "fbclid",
  "gclid",
]);

const STOPWORDS = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "llc",
  "plc",
  "gmbh",
  "ag",
  "srl",
  "sa",
  "bv",
  "group",
  "holding",
  "holdings",
  "systems",
  "solutions",
  "services",
  "service",
  "technology",
  "technologies",
  "innovative",
  "innovation",
  "medicine",
]);

async function loadEnv() {
  try {
    const raw = await readFile(path.join(ROOT, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) process.env[key] = value;
    }
  } catch {
    // Rely on shell env.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashId(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 24);
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<\/?br\s*\/?>/gi, ", ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCompanyOrTitle(value) {
  return stripHtml(value)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
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

      const hashMatch = url.hash.match(/(\d{6,})/);
      if (hashMatch?.[1]) return hashMatch[1];
    }
  } catch {
    // Fall through to regex extraction.
  }

  const tokenMatch = input.match(/[?&]token=(\d+)/i);
  if (tokenMatch?.[1]) return tokenMatch[1];

  const ghJidMatch = input.match(/[?&]gh_jid=(\d+)/i);
  if (ghJidMatch?.[1]) return ghJidMatch[1];

  if (/greenhouse\.io/i.test(input)) {
    const jobsPathMatch = input.match(/\/jobs\/(\d+)(?:[/?#]|$)/i);
    if (jobsPathMatch?.[1]) return jobsPathMatch[1];
  }

  return null;
}

function buildGreenhouseEmbedUrl(token) {
  return `https://boards.greenhouse.io/embed/job_app?token=${encodeURIComponent(token)}`;
}

function normalizeAshbyUrl(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";
  try {
    const url = new URL(input);
    if (url.hostname.toLowerCase() !== "jobs.ashbyhq.com") return "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    return `https://jobs.ashbyhq.com/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
  } catch {
    return "";
  }
}

function normalizeJobUrlForStorage(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";

  const token = extractGreenhouseToken(input);
  if (token) return buildGreenhouseEmbedUrl(token);

  const ashby = normalizeAshbyUrl(input);
  if (ashby) return ashby;

  try {
    const url = new URL(input);
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url.toString().replace(/\?$/, "");
  } catch {
    return input
      .replace(/[?&]utm_source=[^&#]*/gi, "")
      .replace(/[?&]utm_medium=[^&#]*/gi, "")
      .replace(/[?&]utm_campaign=[^&#]*/gi, "")
      .replace(/[?&]ref=[^&#]*/gi, "")
      .replace(/[?&]$/, "")
      .replace(/\?&/, "?");
  }
}

function cleanApplyUrl(rawUrl) {
  return normalizeJobUrlForStorage(rawUrl);
}

function isJobrightInfoUrl(value) {
  return /jobright\.ai\/jobs\/info\//i.test(String(value || ""));
}

function extractJobrightId(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) return "";
  try {
    const url = new URL(input);
    const match = url.pathname.match(/\/jobs\/info\/([^/?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    const match = input.match(/jobright\.ai\/jobs\/info\/([^/?#\s)]+)/i);
    return match?.[1] || "";
  }
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isCanadaLocation(location) {
  const loc = String(location || "").toLowerCase();
  if (!loc) return false;
  return (
    /\bcanada\b/.test(loc) ||
    /,\s*on\b/.test(loc) ||
    /,\s*bc\b/.test(loc) ||
    /,\s*qc\b/.test(loc) ||
    /,\s*ab\b/.test(loc) ||
    /\btoronto\b/.test(loc) ||
    /\bvancouver\b/.test(loc) ||
    /\bmontreal\b/.test(loc) ||
    /\bottawa\b/.test(loc) ||
    /\bcalgary\b/.test(loc)
  );
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function tokenize(raw) {
  return String(raw || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function companyMatchKeys(raw) {
  const tokens = tokenize(raw);
  if (tokens.length === 0) return [];
  const full = tokens.join("");
  const baseTokens = tokens.filter((token) => !STOPWORDS.has(token));
  const base = (baseTokens.length ? baseTokens : tokens).join("");
  return full === base ? [full] : [full, base];
}

function expandCompanyAliases(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return [];
  const parts = trimmed.split("(");
  const names = [];
  const main = parts[0].trim();
  if (main) names.push(main);
  if (parts.length > 1) {
    parts
      .slice(1)
      .join("(")
      .replace(/\)/g, "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => names.push(part));
  }

  const expanded = [];
  for (const name of names) expanded.push(...companyMatchKeys(name));
  return [...new Set(expanded.filter(Boolean))];
}

async function loadTop500TokensWithRank() {
  try {
    const raw = await readFile(path.join(ROOT, "Company_List - Sheet1.csv"), "utf8");
    const ranks = new Map();
    let currentRank = 1;
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      const [first] = parseCsvLine(line);
      if (!first) continue;
      let mappedAny = false;
      for (const token of expandCompanyAliases(first)) {
        if (!ranks.has(token)) {
          ranks.set(token, currentRank);
          mappedAny = true;
        }
      }
      if (mappedAny) currentRank += 1;
    }
    return ranks;
  } catch {
    return new Map();
  }
}

function getTop500Info(company, top500Tokens) {
  let rank = 999999;
  for (const key of companyMatchKeys(company)) {
    const candidateRank = top500Tokens.get(key);
    if (typeof candidateRank === "number") rank = Math.min(rank, candidateRank);
  }
  return { top500: rank !== 999999, rank };
}

async function downloadSource(source) {
  const attempts = envInt("GITHUB_SOURCE_MAX_ATTEMPTS", 3);
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(source.url, {
        headers: { "user-agent": "Mozilla/5.0 github-jobs-cron" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`download_failed:${res.status}`);
      return res.text();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) {
        console.warn(`[github-jobs] ${source.key} download retry=${attempt}/${attempts} error=${lastError}`);
        await sleep(envInt("GITHUB_SOURCE_RETRY_DELAY_MS", 5_000));
      }
    }
  }

  throw new Error(`download_failed:${lastError}:${source.url}`);
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
    "user-agent": process.env.JOBRIGHT_USER_AGENT || DEFAULT_JOBRIGHT_USER_AGENT,
    referer: kind === "json" ? "https://jobright.ai/jobs/recommend" : "https://jobright.ai/",
    "x-client-type": "web",
  };
  if (process.env.JOBRIGHT_COOKIE) headers.cookie = process.env.JOBRIGHT_COOKIE;
  return headers;
}

function minisiteCategoryToReferer(category) {
  const parts = String(category || "").split(":");
  const jobType = parts[0] || "newgrad";
  const country = parts[1] || "us";
  const role = parts[2] || "swe";
  return `https://jobright.ai/minisites-jobs/${encodeURIComponent(jobType)}/${encodeURIComponent(country)}/${encodeURIComponent(role)}?embed=true`;
}

function buildJobrightMinisiteHeaders(category) {
  return {
    ...buildJobrightHeaders("json"),
    "content-type": "application/json",
    origin: "https://jobright.ai",
    referer: minisiteCategoryToReferer(category),
    "sec-fetch-storage-access": "none",
  };
}

function asCleanUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return isValidHttpUrl(raw) ? raw : "";
}

function firstNonEmpty(...values) {
  for (const value of values.flat()) {
    if (Array.isArray(value)) {
      const nested = firstNonEmpty(...value);
      if (nested) return nested;
    } else if (typeof value === "string" && value.trim()) {
      return value.trim();
    } else if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

function firstDefined(...values) {
  for (const value of values.flat()) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return value;
  }
  return undefined;
}

function normalizeScore(value) {
  if (typeof value === "string") {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    value = Number.parseFloat(match[0]);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 0 && value <= 1 ? value * 100 : value;
}

function readJobrightScore(...records) {
  const values = [];
  for (const record of records.filter(Boolean)) {
    values.push(
      record.displayScore,
      record.score,
      record.matchScore,
      record.jobScore,
      record.jobNotes?.displayScore,
      record.jobNotes?.score,
      record.recommendationScores?.displayScore,
      record.recommendationScores?.score,
      record.recommendationScores?.overallScore
    );
  }
  for (const value of values) {
    const score = normalizeScore(value);
    if (score !== null) return score;
  }
  return null;
}

function passesJobrightScore(score) {
  return typeof score === "number" && Number.isFinite(score) && score > envFloat("JOBRIGHT_SCORE_THRESHOLD", 65);
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (["true", "1", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "no", "n"].includes(normalized)) return false;
  }
  return undefined;
}

function optionalBooleanEquals(value, expected) {
  const parsed = parseOptionalBoolean(value);
  if (parsed === null) return true;
  return parsed === expected;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,\s]/g, "");
    if (!cleaned) return null;
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseSalaryRange(value) {
  const raw = String(value || "");
  const values = [...raw.matchAll(/\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*[kK])?/g)].map((match) => {
    const number = Number.parseFloat(match[1].replace(/,/g, ""));
    if (!Number.isFinite(number)) return null;
    return /[kK]/.test(match[0]) ? number * 1000 : number;
  }).filter((number) => number !== null);

  if (!values.length) return { minSalary: undefined, maxSalary: undefined };
  return {
    minSalary: Math.min(...values),
    maxSalary: Math.max(...values),
  };
}

function checkJobrightOptionalRequirements(row) {
  if (!optionalBooleanEquals(row.isH1bSponsor, true)) return "h1b";
  if (!optionalBooleanEquals(row.isCitizenOnly, false)) return "citizen_only";

  const minSalary = parseOptionalNumber(row.minSalary);
  if (minSalary !== null && !(typeof minSalary === "number" && minSalary > 100_000)) return "salary";

  return "";
}

function isPhdTitle(title) {
  return /\bph\.?\s*d\b/i.test(String(title || ""));
}

function markNotEligible(row, reason) {
  return {
    ...row,
    notEligible: true,
    notEligibleReason: reason || "filtered",
  };
}

function markJobrightNotEligible(row, reason) {
  return markNotEligible(row, reason);
}

function getJobrightAliasIds(row) {
  return [
    row.jobrightId,
    ...(Array.isArray(row.jobrightAliases) ? row.jobrightAliases : []),
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function waiveTop500SalaryNotEligible(row, top500Tokens) {
  if (!row.notEligible || row.notEligibleReason !== "salary") return row;
  const top500 = getTop500Info(row.company, top500Tokens);
  if (!top500.top500) return row;
  return {
    ...row,
    notEligible: false,
    notEligibleReason: "",
  };
}

function extractJsonArray(data, pathGroups) {
  for (const pathGroup of pathGroups) {
    let cursor = data;
    for (const key of pathGroup) cursor = cursor?.[key];
    if (Array.isArray(cursor)) return cursor;
  }
  return [];
}

function extractJsonNumber(data, pathGroups) {
  for (const pathGroup of pathGroups) {
    let cursor = data;
    for (const key of pathGroup) cursor = cursor?.[key];
    if (typeof cursor === "number" && Number.isFinite(cursor)) return cursor;
    if (typeof cursor === "string" && cursor.trim() && Number.isFinite(Number(cursor))) return Number(cursor);
  }
  return null;
}

function getJobrightJobNode(record) {
  return record?.jobResult || record?.job || record?.jd || record || {};
}

function compactLocation(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const joined = value
        .map((item) => {
          if (typeof item === "string") return item;
          return firstNonEmpty(item?.jobLocation, item?.location, item?.city, item?.state, item?.name);
        })
        .filter(Boolean)
        .join(", ");
      if (joined) return joined;
    } else {
      const text = firstNonEmpty(value);
      if (text) return text;
    }
  }
  return "";
}

function pickFirstApplyHref(cellHtml) {
  const anchors = [...String(cellHtml || "").matchAll(/<a\s+href="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi)];
  if (!anchors.length) return "";
  for (const match of anchors) {
    const href = match[1];
    if (/simplify\.jobs\/p\//i.test(href)) continue;
    if (/i\.imgur\.com\/aVnQdox/i.test(match[0])) continue;
    return href;
  }
  return anchors[0]?.[1] || "";
}

function parseSimplifySections(markdown) {
  const jobs = [];

  for (let i = 0; i < SIMPLIFY_SECTIONS.length; i += 1) {
    const section = SIMPLIFY_SECTIONS[i];
    const start = markdown.indexOf(section.heading);
    if (start < 0) {
      console.warn(`[github-jobs] missing Simplify section: ${section.heading}`);
      continue;
    }
    const next = SIMPLIFY_SECTIONS[i + 1];
    const nextStart = next ? markdown.indexOf(next.heading, start + 1) : markdown.indexOf("\n## ", start + 10);
    const chunk = markdown.slice(start, nextStart > start ? nextStart : undefined);

    const rows = [
      ...chunk.matchAll(
        /<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/gi
      ),
    ];

    for (const row of rows) {
      const companyHtml = row[1];
      if (/^↳/.test(stripHtml(companyHtml))) continue;
      const company = cleanCompanyOrTitle(companyHtml.match(/<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] || companyHtml);
      const title = cleanCompanyOrTitle(row[2]);
      const location = stripHtml(row[3]);
      const applyLinkRaw = pickFirstApplyHref(row[4]);
      const age = stripHtml(row[5]);
      if (!title || !applyLinkRaw) continue;

      jobs.push({
        source: section.source,
        company,
        title,
        location,
        salary: "",
        workModel: "",
        age,
        jobrightId: "",
        applyLinkRaw,
      });
    }
  }

  return jobs;
}

function parseMarkdownLink(value) {
  const match = String(value || "").match(/\[([^\]]+)\]\(([^)]+)\)/);
  if (match) return { text: stripHtml(match[1]), href: match[2] };
  return { text: stripHtml(value), href: "" };
}

function parseSpeedyTable(markdown, source) {
  const jobs = [];
  // SpeedyApply uses two table formats:
  //   FAANG+ / Quant: | Company | Position | Location | Salary | Posting | Age | (6 cols)
  //   Other:          | Company | Position | Location | Posting | Age |          (5 cols)
  // Detect layout from each table header row.
  let hasSalaryColumn = true;
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    if (/^\|\s*-+/.test(line)) continue;
    if (/Company\s*\|\s*Position/i.test(line)) {
      hasSalaryColumn = /Salary/i.test(line);
      continue;
    }

    const cols = line.split("|").slice(1, -1).map((col) => col.trim());
    const minCols = hasSalaryColumn ? 6 : 5;
    if (cols.length < minCols) continue;

    const company = cleanCompanyOrTitle(parseMarkdownLink(cols[0].replace(/<\/?strong>/gi, "")).text);
    const title = cleanCompanyOrTitle(cols[1]);
    const location = stripHtml(cols[2]);
    const salary = hasSalaryColumn ? stripHtml(cols[3]) : "";
    const applyCol = hasSalaryColumn ? 4 : 3;
    const ageCol = hasSalaryColumn ? 5 : 4;
    const applyLinkRaw = cols[applyCol].match(/href="([^"]+)"/i)?.[1] || parseMarkdownLink(cols[applyCol]).href;
    const age = stripHtml(cols[ageCol] || "");
    if (!title || !applyLinkRaw) continue;

    jobs.push({
      source,
      company,
      title,
      location,
      salary,
      workModel: "",
      age,
      jobrightId: "",
      applyLinkRaw,
    });
  }
  return jobs;
}

function parseJobrightTable(markdown, source) {
  const jobs = [];
  let lastCompany = "";

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    if (/^\|\s*-+/.test(line) || /Company\s*\|\s*Job Title/i.test(line)) continue;

    const cols = line.split("|").slice(1, -1).map((col) => col.trim());
    if (cols.length < 5) continue;

    const companyCell = cols.slice(0, cols.length - 4).join("|").trim();
    const titleCell = cols[cols.length - 4];
    const location = stripHtml(cols[cols.length - 3]);
    const workModel = stripHtml(cols[cols.length - 2]);
    const age = stripHtml(cols[cols.length - 1]);

    const companyLink = parseMarkdownLink(companyCell.replace(/<\/?strong>/gi, ""));
    const titleLink = parseMarkdownLink(titleCell.replace(/<\/?strong>/gi, ""));
    const isSameCompanyMarker = companyLink.text === "↳" || companyLink.text === "->";
    const company = isSameCompanyMarker ? lastCompany : cleanCompanyOrTitle(companyLink.text);
    if (company && !isSameCompanyMarker) lastCompany = company;

    const jobrightId = extractJobrightId(titleLink.href);
    if (!titleLink.text || !titleLink.href || !jobrightId) continue;

    jobs.push({
      source,
      company,
      title: cleanCompanyOrTitle(titleLink.text),
      location,
      salary: "",
      workModel,
      age,
      jobrightId,
      applyLinkRaw: titleLink.href,
      score: null,
    });
  }

  return jobs;
}

async function fetchJobrightRecommendPage(position, refresh, sortCondition) {
  const url = new URL(JOBRIGHT_RECOMMEND_URL);
  url.search = new URLSearchParams({
    refresh: refresh ? "true" : "false",
    sortCondition,
    position: String(position),
    count: String(envInt("JOBRIGHT_RECOMMEND_PAGE_SIZE", 20)),
    syncRerank: "false",
  }).toString();

  const res = await fetch(url, {
    headers: buildJobrightHeaders("json"),
    signal: AbortSignal.timeout(envInt("JOBRIGHT_RECOMMEND_TIMEOUT_MS", 30_000)),
  });

  if (!res.ok) {
    const code = res.status === 401 ? "auth_required" : `http_${res.status}`;
    throw new Error(`jobright_recommend_${code}`);
  }

  const data = await res.json();
  return extractJsonArray(data, [
    ["data", "jobList"],
    ["data", "jobs"],
    ["data", "list"],
    ["result", "jobs"],
    ["result", "jobList"],
    ["jobs"],
    ["jobList"],
    ["data"],
  ]);
}

async function fetchJobrightMinisitePage(category, position) {
  const url = new URL(JOBRIGHT_MINISITE_URL);
  url.search = new URLSearchParams({
    position: String(position),
    count: String(envInt("JOBRIGHT_MINISITE_PAGE_SIZE", 500)),
  }).toString();

  const res = await fetch(url, {
    method: "POST",
    headers: buildJobrightMinisiteHeaders(category),
    body: JSON.stringify({
      category,
      excludeTitle: JOBRIGHT_EXCLUDED_TITLES,
      excludedTitle: JOBRIGHT_EXCLUDED_TITLES,
    }),
    signal: AbortSignal.timeout(envInt("JOBRIGHT_MINISITE_TIMEOUT_MS", 30_000)),
  });

  if (!res.ok) {
    const code = res.status === 401 ? "auth_required" : `http_${res.status}`;
    throw new Error(`jobright_minisite_${code}`);
  }

  const data = await res.json();
  const records = extractJsonArray(data, [
    ["data", "jobList"],
    ["data", "jobs"],
    ["data", "list"],
    ["result", "jobs"],
    ["result", "jobList"],
    ["result", "list"],
    ["jobs"],
    ["jobList"],
    ["list"],
    ["data"],
  ]);
  const total = extractJsonNumber(data, [
    ["result", "total"],
    ["result", "totalCount"],
    ["result", "count"],
    ["data", "total"],
    ["data", "totalCount"],
    ["total"],
    ["totalCount"],
  ]);
  return { records, total };
}

function jobrightRecordToRow(record, source) {
  const job = getJobrightJobNode(record);
  const properties = record?.properties || job?.properties || {};
  const company = record?.companyResult || job?.companyResult || {};
  const jobrightId = firstNonEmpty(job.jobId, job.id, record.jobId, record.id);
  const applyLinkRaw =
    asCleanUrl(firstNonEmpty(job.applyLink, job.originalUrl, job.jobUrl, job.url, record.applyLink, record.originalUrl)) ||
    (jobrightId ? `${JOBRIGHT_INFO_URL}/${encodeURIComponent(jobrightId)}` : "");
  const score = readJobrightScore(record, job);
  const salary = firstNonEmpty(job.salaryDesc, record.salaryDesc, job.salary, record.salary, properties.salary);
  const parsedSalary = parseSalaryRange(salary);

  return {
    source,
    company: cleanCompanyOrTitle(firstNonEmpty(job.companyName, company.companyName, job.company, record.companyName, properties.company)),
    title: cleanCompanyOrTitle(firstNonEmpty(job.jobTitle, job.title, record.jobTitle, record.title, properties.title)),
    location: compactLocation(job.jobLocation, job.location, record.jobLocation, record.location, job.jobLocations, properties.location),
    salary,
    workModel: firstNonEmpty(job.workModel, record.workModel, properties.workModel),
    industry: Array.isArray(properties.industry) ? properties.industry : [],
    companySize: firstNonEmpty(properties.companySize),
    qualifications: firstNonEmpty(properties.qualifications),
    expLevel: firstNonEmpty(properties.expLevel),
    jobFunction: firstNonEmpty(properties.jobFunction),
    h1bSponsored: firstNonEmpty(properties.h1bSponsored),
    isNewGrad: firstDefined(properties.isNewGrad),
    roleType: firstNonEmpty(properties.roleType),
    hireTime: firstNonEmpty(properties.hireTime),
    graduateTime: firstNonEmpty(properties.graduateTime),
    age: firstNonEmpty(job.publishTime, record.publishTime, job.publishTimeDesc, record.publishTimeDesc, record.postedAt),
    jobrightId,
    applyLinkRaw,
    recruiterName: firstNonEmpty(job.jobRecruiter, record.jobRecruiter),
    recruiterProfileUrl: firstNonEmpty(job.jobRecruiterProfileUrl, record.jobRecruiterProfileUrl),
    score,
    isH1bSponsor: firstDefined(job.isH1bSponsor, record.isH1bSponsor, properties.isH1bSponsor, properties.h1bSponsored),
    isCitizenOnly: firstDefined(job.isCitizenOnly, record.isCitizenOnly),
    minSalary: firstDefined(job.minSalary, record.minSalary, properties.minSalary, parsedSalary.minSalary),
    maxSalary: firstDefined(job.maxSalary, record.maxSalary, properties.maxSalary, parsedSalary.maxSalary),
  };
}

function collectJobrightRowsFromRecords(records, source, options = {}) {
  const requireScore = options.requireScore !== false;
  const rows = [];
  const rejectedRows = [];
  let belowScore = 0;
  let missingScore = 0;
  let requirementFiltered = 0;

  for (const record of records) {
    const row = jobrightRecordToRow(record, source);
    if (!row.jobrightId || !row.title) continue;
    if (isPhdTitle(row.title)) {
      requirementFiltered += 1;
      rejectedRows.push(markJobrightNotEligible(row, "phd_title"));
      continue;
    }
    if (row.score === null && requireScore) {
      missingScore += 1;
      rejectedRows.push(markJobrightNotEligible(row, "missing_score"));
      continue;
    }
    if (row.score !== null && !passesJobrightScore(row.score)) {
      belowScore += 1;
      rejectedRows.push(markJobrightNotEligible(row, "score_below_threshold"));
      continue;
    }
    const requirementIssue = checkJobrightOptionalRequirements(row);
    if (requirementIssue) {
      requirementFiltered += 1;
      rejectedRows.push(markJobrightNotEligible(row, requirementIssue));
      continue;
    }
    rows.push(row);
  }

  return { rows, rejectedRows, belowScore, missingScore, requirementFiltered };
}

function collectJobrightIdRowsFromMinisiteRecords(records, source) {
  const rows = [];
  let missingJobrightIds = 0;

  for (const record of records) {
    const jobrightId = firstNonEmpty(record?.jobId, record?.id);
    if (!jobrightId) {
      missingJobrightIds += 1;
      continue;
    }
    rows.push({
      source,
      company: "",
      title: "",
      location: "",
      salary: "",
      workModel: "",
      age: firstNonEmpty(record?.postedAt),
      jobrightId,
      applyLinkRaw: `${JOBRIGHT_INFO_URL}/${encodeURIComponent(jobrightId)}`,
      score: null,
    });
  }

  return { rows, missingJobrightIds };
}

async function fetchJobrightRecommendationRows() {
  const pageSize = envInt("JOBRIGHT_RECOMMEND_PAGE_SIZE", 20);
  const delayMs = envInt("JOBRIGHT_RECOMMEND_DELAY_MS", 20_000);
  const rows = [];
  const rejectedRows = [];
  const seenJobrightIds = new Set();
  let fetchedItems = 0;
  let belowScore = 0;
  let missingScore = 0;
  let requirementFiltered = 0;
  let failedPages = 0;
  let lastError = "";
  let duplicateSameRun = 0;
  const sortPlan = getJobrightRecommendSortPlan();

  for (const plan of sortPlan) {
    const pages = envInt(`JOBRIGHT_RECOMMEND_SORT_${plan.sortCondition}_PAGES`, plan.pages);
    for (let page = 0; page < pages; page += 1) {
      const position = page * pageSize;
      const attempts = envInt("JOBRIGHT_RECOMMEND_MAX_ATTEMPTS", 3);
      let records = null;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          records = await fetchJobrightRecommendPage(position, page === 0, plan.sortCondition);
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          if (lastError.includes("auth_required")) throw error;
          if (attempt < attempts) {
            console.warn(
              `[github-jobs] jobright-recommend sortCondition=${plan.sortCondition} page=${page + 1}/${pages} retry=${attempt}/${attempts} error=${lastError}`
            );
            await sleep(envInt("JOBRIGHT_RECOMMEND_RETRY_DELAY_MS", 20_000));
          }
        }
      }

      if (!records) {
        failedPages += 1;
        console.warn(`[github-jobs] jobright-recommend sortCondition=${plan.sortCondition} page=${page + 1}/${pages} failed error=${lastError}`);
        if (page + 1 < pages) await sleep(delayMs);
        continue;
      }

      fetchedItems += records.length;

      const collected = collectJobrightRowsFromRecords(records, "jobright-recommend");
      const uniqueRows = [];
      const uniqueRejectedRows = [];
      for (const row of [...collected.rows, ...collected.rejectedRows]) {
        if (row.jobrightId && seenJobrightIds.has(row.jobrightId)) {
          duplicateSameRun += 1;
          continue;
        }
        if (row.jobrightId) seenJobrightIds.add(row.jobrightId);
        if (row.notEligible) uniqueRejectedRows.push(row);
        else uniqueRows.push(row);
      }

      rows.push(...uniqueRows);
      rejectedRows.push(...uniqueRejectedRows);
      belowScore += collected.belowScore;
      missingScore += collected.missingScore;
      requirementFiltered += collected.requirementFiltered;

      console.log(
        `[github-jobs] jobright-recommend sortCondition=${plan.sortCondition} page=${page + 1}/${pages} position=${position} items=${records.length} kept=${rows.length} notEligible=${rejectedRows.length} duplicateSameRun=${duplicateSameRun}`
      );
      if (page + 1 < pages) await sleep(delayMs);
    }
    if (plan !== sortPlan.at(-1)) await sleep(delayMs);
  }

  return { rows, rejectedRows, fetchedItems, belowScore, missingScore, requirementFiltered, failedPages, lastError, duplicateSameRun };
}

async function fetchJobrightMinisiteRows(skipIds = new Set(), existingJobrightIds = new Set()) {
  const maxPages = getJobrightMinisiteMaxPages();
  const pageSize = envInt("JOBRIGHT_MINISITE_PAGE_SIZE", 500);
  const delayMs = envInt("JOBRIGHT_MINISITE_DELAY_MS", 20_000);
  const rawRows = [];
  let fetchedItems = 0;
  let failedPages = 0;
  let lastError = "";
  let missingJobrightIds = 0;

  for (const categoryConfig of JOBRIGHT_MINISITE_CATEGORIES) {
    let categoryPages = maxPages;
    for (let page = 0; page < categoryPages; page += 1) {
      const position = page * pageSize;
      const attempts = envInt("JOBRIGHT_MINISITE_MAX_ATTEMPTS", 3);
      let records = null;
      let total = null;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const pageResult = await fetchJobrightMinisitePage(categoryConfig.category, position);
          records = pageResult.records;
          total = pageResult.total;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          if (lastError.includes("auth_required")) throw error;
          if (attempt < attempts) {
            console.warn(
              `[github-jobs] jobright-minisite category=${categoryConfig.category} page=${page + 1}/${categoryPages} retry=${attempt}/${attempts} error=${lastError}`
            );
            await sleep(envInt("JOBRIGHT_MINISITE_RETRY_DELAY_MS", 20_000));
          }
        }
      }

      if (!records) {
        failedPages += 1;
        console.warn(
          `[github-jobs] jobright-minisite category=${categoryConfig.category} page=${page + 1}/${categoryPages} failed error=${lastError}`
        );
        if (page + 1 < pages) await sleep(delayMs);
        continue;
      }

      fetchedItems += records.length;
      if (page === 0 && typeof total === "number") {
        categoryPages = Math.min(maxPages, Math.max(1, Math.ceil(total / pageSize)));
      }
      const collected = collectJobrightIdRowsFromMinisiteRecords(records, categoryConfig.source);
      rawRows.push(...collected.rows);
      missingJobrightIds += collected.missingJobrightIds;

      console.log(
        `[github-jobs] jobright-minisite category=${categoryConfig.category} page=${page + 1}/${categoryPages} done=${page + 1}/${categoryPages} position=${position} total=${total ?? "unknown"} items=${records.length} ids=${rawRows.length}`
      );

      if (records.length < pageSize) break;
      if (page + 1 < categoryPages) await sleep(delayMs);
    }
  }

  const resolved = await resolveJobrightRows(rawRows, skipIds, existingJobrightIds, "jobright-minisite");
  return {
    ...resolved,
    fetchedItems,
    failedPages,
    lastError,
    missingJobrightIds: missingJobrightIds + resolved.missingJobrightIds,
  };
}

function extractJobrightDetails(html) {
  const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;

  try {
    const data = JSON.parse(match[1]);
    const dataSource = data?.props?.pageProps?.dataSource || {};
    const job = dataSource.jobResult || {};
    const company = dataSource.companyResult || {};
    const row = jobrightRecordToRow({ ...dataSource, jobResult: job, companyResult: company }, "jobright-detail");
    return { ...row, score: readJobrightScore(dataSource, job) };
  } catch {
    return null;
  }
}

async function fetchJobrightDetail(jobrightId) {
  try {
    const res = await fetch(`${JOBRIGHT_INFO_URL}/${encodeURIComponent(jobrightId)}`, {
      headers: buildJobrightHeaders("html"),
      signal: AbortSignal.timeout(envInt("JOBRIGHT_DETAIL_TIMEOUT_MS", 30_000)),
    });
    if (!res.ok) return { ok: false, code: `http_${res.status}` };
    const html = await res.text();
    const details = extractJobrightDetails(html);
    if (!details) return { ok: false, code: "parse_failed" };
    return { ok: true, details };
  } catch {
    return { ok: false, code: "fetch_error" };
  }
}

async function fetchJobrightDetailsInBatches(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (row.jobrightId && !byId.has(row.jobrightId)) byId.set(row.jobrightId, row);
  }

  const ids = [...byId.keys()];
  if (!ids.length) {
    console.log("[github-jobs] jobright-detail total=0 skipped fetch");
    return { detailsById: new Map(), failed: 0 };
  }

  const batchSize = envInt("JOBRIGHT_DETAIL_BATCH_SIZE", 20);
  const delayMs = envInt("JOBRIGHT_DETAIL_BATCH_DELAY_MS", 20_000);
  const maxAttempts = envInt("JOBRIGHT_DETAIL_MAX_ATTEMPTS", 2);
  const detailsById = new Map();
  const failures = new Map();
  let pendingIds = ids;

  for (let attempt = 1; attempt <= maxAttempts && pendingIds.length; attempt += 1) {
    const retryIds = [];
    const attemptTotal = pendingIds.length;
    for (let i = 0; i < pendingIds.length; i += batchSize) {
      const batch = pendingIds.slice(i, i + batchSize);
      const results = await Promise.all(batch.map((jobrightId) => fetchJobrightDetail(jobrightId)));

      for (let idx = 0; idx < batch.length; idx += 1) {
        const jobrightId = batch[idx];
        const result = results[idx];
        if (result.ok) {
          detailsById.set(jobrightId, result.details);
          failures.delete(jobrightId);
        } else {
          failures.set(jobrightId, result.code);
          retryIds.push(jobrightId);
        }
      }

      console.log(
        `[github-jobs] jobright-detail attempt=${attempt}/${maxAttempts} done=${Math.min(i + batch.length, attemptTotal)}/${attemptTotal} totalDone=${detailsById.size}/${ids.length} batch=${Math.floor(i / batchSize) + 1}/${Math.ceil(attemptTotal / batchSize)} failedThisAttempt=${retryIds.length}`
      );
      if (i + batchSize < pendingIds.length || attempt < maxAttempts) await sleep(delayMs);
    }
    pendingIds = retryIds;
  }

  return { detailsById, failed: failures.size };
}

async function resolveJobrightRows(rows, skipIds, existingJobrightIds = new Set(), logLabel = "jobright") {
  const uniqueById = new Map();
  const seen = new Set(skipIds);
  let skippedDuplicateIds = 0;
  let skippedExistingIds = 0;
  let missingJobrightIds = 0;

  for (const row of rows) {
    if (!row.jobrightId) {
      missingJobrightIds += 1;
      continue;
    }
    if (existingJobrightIds.has(row.jobrightId)) {
      skippedExistingIds += 1;
      seen.add(row.jobrightId);
      continue;
    }
    if (seen.has(row.jobrightId)) {
      skippedDuplicateIds += 1;
      continue;
    }
    seen.add(row.jobrightId);
    uniqueById.set(row.jobrightId, row);
  }

  for (const row of rows) {
    if (!row.jobrightId || !uniqueById.has(row.jobrightId)) continue;
    const existing = uniqueById.get(row.jobrightId);
    if (existing === row) continue;
    const sources = new Set(String(existing.source || "").split("|").filter(Boolean));
    sources.add(row.source);
    existing.source = [...sources].join("|");
  }

  const unique = [...uniqueById.values()];
  console.log(
    `[github-jobs] ${logLabel} dedup raw=${rows.length} missingId=${missingJobrightIds} ` +
    `skipIds=${skipIds.size} skippedExistingDb=${skippedExistingIds} ` +
    `skippedDuplicateSameRun=${skippedDuplicateIds} detailToFetch=${unique.length}`
  );

  const { detailsById, failed } = await fetchJobrightDetailsInBatches(unique);
  const resolved = [];
  const rejectedRows = [];
  let belowScore = 0;
  let missingScore = 0;
  let requirementFiltered = 0;
  let unresolvedApplyLink = 0;

  for (const row of unique) {
    const detail = detailsById.get(row.jobrightId);
    if (!detail) continue;

    const merged = {
      ...row,
      ...detail,
      source: row.source,
      company: detail.company || row.company,
      title: detail.title || row.title,
      location: detail.location || row.location,
      salary: detail.salary || row.salary,
      workModel: detail.workModel || row.workModel,
      age: detail.age || row.age,
      jobrightId: row.jobrightId,
      applyLinkRaw: detail.applyLinkRaw || row.applyLinkRaw,
      recruiterName: detail.recruiterName || row.recruiterName || "",
      recruiterProfileUrl: detail.recruiterProfileUrl || row.recruiterProfileUrl || "",
      score: detail.score,
    };

    if (isPhdTitle(merged.title)) {
      requirementFiltered += 1;
      rejectedRows.push(markJobrightNotEligible(merged, "phd_title"));
      continue;
    }
    if (merged.score === null) {
      missingScore += 1;
      rejectedRows.push(markJobrightNotEligible(merged, "missing_score"));
      continue;
    }
    if (!passesJobrightScore(merged.score)) {
      belowScore += 1;
      rejectedRows.push(markJobrightNotEligible(merged, "score_below_threshold"));
      continue;
    }
    const requirementIssue = checkJobrightOptionalRequirements(merged);
    if (requirementIssue) {
      requirementFiltered += 1;
      rejectedRows.push(markJobrightNotEligible(merged, requirementIssue));
      continue;
    }
    if (!merged.applyLinkRaw || isJobrightInfoUrl(merged.applyLinkRaw)) {
      unresolvedApplyLink += 1;
      rejectedRows.push(markJobrightNotEligible(
        {
          ...merged,
          applyLinkRaw: merged.applyLinkRaw || `${JOBRIGHT_INFO_URL}/${encodeURIComponent(merged.jobrightId)}`,
        },
        "unresolved_apply_link"
      ));
      continue;
    }
    resolved.push(merged);
  }

  return {
    rows: resolved,
    rejectedRows,
    skippedDuplicateIds,
    skippedExistingIds,
    missingJobrightIds,
    detailFailed: failed,
    belowScore,
    missingScore,
    requirementFiltered,
    unresolvedApplyLink,
  };
}

function sourceRank(source) {
  const value = String(source || "");
  if (value.startsWith("jobright-recommend")) return 1;
  if (value.startsWith("jobright")) return 2;
  if (value.startsWith("simplify")) return 2;
  if (value.startsWith("speedy")) return 3;
  return 9;
}

function mergeRowsByApplyLink(rows) {
  const byUrl = new Map();
  let duplicateRows = 0;
  for (const row of rows) {
    const key = String(row.applyLink || "").trim().toLowerCase();
    if (!key) continue;
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, row);
      continue;
    }

    duplicateRows += 1;
    const sources = new Set(String(existing.source || "").split("|").filter(Boolean));
    sources.add(row.source);
    existing.source = [...sources].join("|");
    if (!existing.jobrightId && row.jobrightId) existing.jobrightId = row.jobrightId;
    existing.jobrightAliases = [...new Set([
      ...getJobrightAliasIds(existing),
      ...getJobrightAliasIds(row),
    ])];
    if (existing.notEligible && !row.notEligible) {
      existing.notEligible = false;
      existing.notEligibleReason = "";
    } else if (existing.notEligible && !existing.notEligibleReason && row.notEligibleReason) {
      existing.notEligibleReason = row.notEligibleReason;
    }
    if (existing.score === null || existing.score === undefined) existing.score = row.score;
    if (existing.isH1bSponsor === null || existing.isH1bSponsor === undefined) existing.isH1bSponsor = row.isH1bSponsor;
    if (existing.isCitizenOnly === null || existing.isCitizenOnly === undefined) existing.isCitizenOnly = row.isCitizenOnly;
    if (existing.minSalary === null || existing.minSalary === undefined) existing.minSalary = row.minSalary;
    if (existing.maxSalary === null || existing.maxSalary === undefined) existing.maxSalary = row.maxSalary;
    if (!existing.recruiterName && row.recruiterName) existing.recruiterName = row.recruiterName;
    if (!existing.recruiterProfileUrl && row.recruiterProfileUrl) existing.recruiterProfileUrl = row.recruiterProfileUrl;
    // Keep the earliest posted date across all sources
    if (row.age && existing.age) {
      const existingDate = parsePostedAt(existing.age, new Date());
      const rowDate = parsePostedAt(row.age, new Date());
      if (rowDate.getTime() < existingDate.getTime()) {
        existing.age = row.age;
      }
    } else if (row.age && !existing.age) {
      existing.age = row.age;
    }
    if (sourceRank(row.source) < sourceRank(existing.source)) {
      existing.company = row.company || existing.company;
      existing.title = row.title || existing.title;
      existing.location = row.location || existing.location;
      existing.salary = row.salary || existing.salary;
      existing.workModel = row.workModel || existing.workModel;
      // age is already resolved above to the earliest date
    }
  }
  return { rows: [...byUrl.values()], duplicateRows };
}

function buildJobId(row) {
  if (row.jobrightId) return row.jobrightId;
  const ghToken = extractGreenhouseToken(row.applyLink);
  if (ghToken) return `greenhouse:${ghToken}`;
  return `github:${hashId(row.applyLink)}`;
}

function getTabCategory(row) {
  const sourceDetails = getSourceDetails(row);
  const out = [];
  if (sourceDetails.some((source) => source.kind === "github" || source.kind === "jobright-github")) out.push("github");
  if (sourceDetails.some((source) => source.kind.startsWith("jobright"))) out.push("jobright");
  if (sourceDetails.some((source) => source.kind === "jobright-api")) out.push("jobright-api");
  if (row.source) out.push(...getSourceKeys(row));
  if (row.notEligible) out.push("not-eligible");
  if (extractGreenhouseToken(row.applyLink)) out.push("greenhouse");
  return [...new Set(out)];
}

function getSourceKeys(row) {
  return [...new Set(String(row.source || "").split("|").map((value) => value.trim()).filter(Boolean))];
}

function getSourceDetails(row) {
  return getSourceKeys(row).map((key) => {
    const meta = SOURCE_METADATA[key] || {
      kind: key.startsWith("jobright") ? "jobright-github" : "github",
      label: key,
      repo: "",
      url: "",
    };
    return {
      key,
      kind: meta.kind,
      label: meta.label,
      repo: meta.repo,
      url: meta.url,
      jobrightId: row.jobrightId || "",
    };
  });
}

function joinUnique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].join(" | ");
}

function buildJobDoc(row, now, top500Tokens) {
  const companyRaw = cleanCompanyOrTitle(row.company || "");
  const top500 = getTop500Info(companyRaw, top500Tokens);
  const isResolved = Boolean(row.applyLink && !isJobrightInfoUrl(row.applyLink));
  const sourceDetails = getSourceDetails(row);
  return {
    jobId: buildJobId(row),
    jobrightId: row.jobrightId || "",
    title: cleanCompanyOrTitle(row.title || ""),
    company: cleanCompanyOrTitle(companyRaw),
    location: String(row.location || ""),
    salary: String(row.salary || ""),
    workModel: String(row.workModel || ""),
    industry: [],
    companySize: "",
    qualifications: "",
    expLevel: "",
    jobFunction: "",
    h1bSponsored: "",
    isNewGrad: true,
    roleType: "",
    hireTime: "",
    graduateTime: "",
    tabCategory: getTabCategory(row),
    postedAt: parsePostedAt(row.age, now),
    fetchedAt: now,
    createdAt: now,
    updatedAt: now,
    applied: false,
    appliedAt: null,
    autoApplied: false,
    autoAppliedAt: null,
    manualApplied: false,
    manualAppliedAt: null,
    notInterested: false,
    top500: top500.top500,
    companyRank: top500.rank,
    matchScore: typeof row.score === "number" && Number.isFinite(row.score) ? row.score : null,
    jobrightAliases: getJobrightAliasIds(row),
    sourceTags: sourceDetails.map((source) => source.label),
    sourceDetails,
    sourceKind: joinUnique(sourceDetails.map((source) => source.kind)),
    sourceRepo: joinUnique(sourceDetails.map((source) => source.repo)),
    sourceLabel: joinUnique(sourceDetails.map((source) => source.label)),
    isH1bSponsor: parseOptionalBoolean(row.isH1bSponsor),
    isCitizenOnly: parseOptionalBoolean(row.isCitizenOnly),
    minSalary: parseOptionalNumber(row.minSalary),
    maxSalary: parseOptionalNumber(row.maxSalary),
    applyLink: row.applyLink,
    recruiterName: row.recruiterName || "",
    recruiterProfileUrl: row.recruiterProfileUrl || "",
    detailsFetchedAt: isResolved ? now : null,
    detailsFetchStatus: row.notEligible ? `not_eligible:${row.notEligibleReason || "filtered"}` : isResolved ? "ok" : "failed",
    inactive: false,
    notEligible: Boolean(row.notEligible),
    notEligibleReason: row.notEligibleReason || "",
    eligibilityStatus: row.notEligible ? "not_eligible" : "eligible",
    isExtraApiJob: !row.source?.startsWith("jobright"),
    // category fields — populated async after buildJobDoc via classifyDocs()
    category: "others",
    categoryLabel: "Others",
    categoryConfidence: 0,
    categoryPriority: 15,
  };
}

async function resolveJobrightGithubRows(rows, skipIds, existingJobrightIds = new Set()) {
  return resolveJobrightRows(rows, skipIds, existingJobrightIds, "jobright-github");
}

function getPacificParts(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function getPacificOffsetMs(date) {
  const parts = getPacificParts(date);
  const wallTimeAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallTimeAsUtc - date.getTime();
}

function pacificWallTimeToDate(year, monthIndex, day, hour = DATE_ONLY_PACIFIC_HOUR, minute = DATE_ONLY_PACIFIC_MINUTE, second = 0) {
  const wallTimeAsUtc = Date.UTC(year, monthIndex, day, hour, minute, second);
  let instant = new Date(wallTimeAsUtc - getPacificOffsetMs(new Date(wallTimeAsUtc)));
  instant = new Date(wallTimeAsUtc - getPacificOffsetMs(instant));
  return instant;
}

function toPacificDateOnly(date) {
  const d = new Date(date);
  const validDate = Number.isNaN(d.getTime()) ? new Date() : d;
  const parts = getPacificParts(validDate);
  return pacificWallTimeToDate(parts.year, parts.month - 1, parts.day);
}

function parsePostedAt(age, now) {
  const raw = String(age || "").trim();
  if (!raw) return toPacificDateOnly(now);

  const ymd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (ymd) {
    const year = Number.parseInt(ymd[1], 10);
    const month = Number.parseInt(ymd[2], 10);
    const day = Number.parseInt(ymd[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const hour = ymd[4] ? Number.parseInt(ymd[4], 10) : DATE_ONLY_PACIFIC_HOUR;
      const minute = ymd[5] ? Number.parseInt(ymd[5], 10) : DATE_ONLY_PACIFIC_MINUTE;
      const second = ymd[6] ? Number.parseInt(ymd[6], 10) : 0;
      const hasTime = Boolean(ymd[4]);
      const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
      if (ymd[4] && hasExplicitZone) {
        const direct = Date.parse(raw.replace(" ", "T"));
        if (!Number.isNaN(direct)) return new Date(direct);
      }
      if (hasTime) return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
      return pacificWallTimeToDate(year, month - 1, day, hour, minute, second);
    }
  }

  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (mdy) {
    const month = Number.parseInt(mdy[1], 10);
    const day = Number.parseInt(mdy[2], 10);
    const yearRaw = Number.parseInt(mdy[3], 10);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return pacificWallTimeToDate(year, month - 1, day);
    }
  }

  // Epoch ms / seconds
  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    const ms = raw.length >= 13 ? n : n * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (hasTimeZone) {
    const direct = Date.parse(raw.replace(" ", "T"));
    if (!Number.isNaN(direct)) return new Date(direct);
  }

  const value = raw.toLowerCase();
  if (value === "just now" || value === "today" || value === "now" || value === "0d") {
    return toPacificDateOnly(now);
  }

  // Relative: 5h, 30m, 2d, 1w, 1mo, 1y (Simplify/Speedy formats)
  const rel = value.match(
    /^(\d+)\s*(mo|mos|month|months|y|yr|yrs|year|years|w|wk|wks|week|weeks|d|day|days|h|hr|hrs|hour|hours|min|mins|minute|minutes|m)\b/
  );
  if (rel) {
    const amount = Number.parseInt(rel[1], 10);
    const unit = rel[2];
    const d = new Date(now);
    if (["mo", "mos", "month", "months"].includes(unit)) d.setMonth(d.getMonth() - amount);
    else if (["y", "yr", "yrs", "year", "years"].includes(unit)) d.setFullYear(d.getFullYear() - amount);
    else if (["w", "wk", "wks", "week", "weeks"].includes(unit)) d.setDate(d.getDate() - amount * 7);
    else if (["d", "day", "days"].includes(unit)) d.setDate(d.getDate() - amount);
    else if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) d.setHours(d.getHours() - amount);
    else d.setMinutes(d.getMinutes() - amount); // m / min*
    if (["h", "hr", "hrs", "hour", "hours", "min", "mins", "minute", "minutes", "m"].includes(unit)) {
      return d;
    }
    return toPacificDateOnly(d);
  }

  const monthDayMatch = value.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if (monthDayMatch) {
    const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = monthNames.indexOf(monthDayMatch[1].slice(0, 3).toLowerCase());
    const day = Number.parseInt(monthDayMatch[2], 10);
    const nowPacific = getPacificParts(now);
    let year = monthDayMatch[3] ? Number.parseInt(monthDayMatch[3], 10) : nowPacific.year;
    if (month >= 0 && day > 0) {
      let d = pacificWallTimeToDate(year, month, day, 12, 0, 0);
      if (!monthDayMatch[3] && d.getTime() > now.getTime() + 7 * 24 * 60 * 60 * 1000) {
        year -= 1;
        d = pacificWallTimeToDate(year, month, day, 12, 0, 0);
      }
      return pacificWallTimeToDate(year, month, day);
    }
  }

  return toPacificDateOnly(now);
}

async function normalizeStoredJobUrls(jobCol) {
  const candidates = await jobCol
    .find(
      { applyLink: { $regex: /(greenhouse\.io|gh_jid=|token=\d+|utm_source=jobright|utm_source=Simplify|utm_source=GHList|jobs\.ashbyhq\.com)/i } },
      { projection: { _id: 1, applyLink: 1 } }
    )
    .toArray();

  const ops = [];
  for (const candidate of candidates) {
    const next = normalizeJobUrlForStorage(String(candidate.applyLink || ""));
    if (next && next !== String(candidate.applyLink || "")) {
      ops.push({
        updateOne: {
          filter: { _id: candidate._id },
          update: { $set: { applyLink: next } },
        },
      });
    }
  }

  if (!ops.length) return 0;
  const res = await jobCol.bulkWrite(ops, { ordered: false });
  return res.modifiedCount || 0;
}

function normalizeForDedup(rawUrl) {
  const input = normalizeJobUrlForStorage(String(rawUrl || "")).trim();
  if (!input || isJobrightInfoUrl(input)) return "";
  try {
    const url = new URL(input);
    if (!/^https?:$/i.test(url.protocol)) return "";
    // Ashby embed flag is not meaningful for uniqueness
    url.searchParams.delete("embed");
    url.searchParams.sort();
    const params = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      if (!TRACKING_PARAMS.has(key.toLowerCase())) params.append(key.toLowerCase(), value);
    }
    const pathName = url.pathname.replace(/\/+$/g, "") || "/";
    const qs = params.toString();
    return `${url.origin.toLowerCase()}${pathName.toLowerCase()}${qs ? `?${qs.toLowerCase()}` : ""}`;
  } catch {
    return input.toLowerCase();
  }
}

async function reactivateInactiveJobs(jobCol) {
  const res = await jobCol.updateMany({ inactive: true }, { $set: { inactive: false } });
  return res.modifiedCount || 0;
}

async function loadExistingJobrightIds(jobCol) {
  const [jobIds, jobrightIds, aliases] = await Promise.all([
    jobCol.distinct("jobId", {
      tabCategory: { $elemMatch: { $regex: /^jobright/ } },
    }),
    jobCol.distinct("jobrightId", {
      jobrightId: { $type: "string", $ne: "" },
    }),
    jobCol.distinct("jobrightAliases", {
      jobrightAliases: { $exists: true, $ne: [] },
    }),
  ]);
  return new Set([...jobIds, ...jobrightIds, ...aliases].map(String).filter(Boolean));
}

async function parseAllSources(existingJobrightIds = new Set(), fetchPlan = getFetchPlan()) {
  const rows = [];
  const stats = {
    sourcePlan: describeFetchPlan(fetchPlan),
    jobrightNotEligibleRows: 0,
    jobrightRecommendFetched: 0,
    jobrightRecommendRows: 0,
    jobrightRecommendBelowScore: 0,
    jobrightRecommendMissingScore: 0,
    jobrightRecommendRequirementFiltered: 0,
    jobrightRecommendFailedPages: 0,
    jobrightRecommendDuplicateSameRun: 0,
    jobrightRecommendError: "",
    jobrightMinisiteFetched: 0,
    jobrightMinisiteRows: 0,
    jobrightMinisiteBelowScore: 0,
    jobrightMinisiteMissingScore: 0,
    jobrightMinisiteRequirementFiltered: 0,
    jobrightMinisiteFailedPages: 0,
    jobrightMinisiteError: "",
    jobrightGithubRaw: 0,
    jobrightGithubRows: 0,
    jobrightGithubSkippedDuplicateIds: 0,
    jobrightGithubSkippedExistingIds: 0,
    jobrightGithubDetailFailed: 0,
    jobrightGithubBelowScore: 0,
    jobrightGithubMissingScore: 0,
    jobrightGithubRequirementFiltered: 0,
    jobrightGithubUnresolvedApplyLink: 0,
  };

  let recommendRows = [];
  let recommendRejectedRows = [];
  if (fetchPlan.jobrightApi) {
    try {
      const recommend = await fetchJobrightRecommendationRows();
      recommendRows = recommend.rows;
      recommendRejectedRows = recommend.rejectedRows;
      rows.push(...recommendRows);
      rows.push(...recommendRejectedRows);
      stats.jobrightNotEligibleRows += recommendRejectedRows.length;
      stats.jobrightRecommendFetched = recommend.fetchedItems;
      stats.jobrightRecommendRows = recommend.rows.length;
      stats.jobrightRecommendBelowScore = recommend.belowScore;
      stats.jobrightRecommendMissingScore = recommend.missingScore;
      stats.jobrightRecommendRequirementFiltered = recommend.requirementFiltered;
      stats.jobrightRecommendFailedPages = recommend.failedPages;
      stats.jobrightRecommendDuplicateSameRun = recommend.duplicateSameRun;
      stats.jobrightRecommendError = recommend.lastError && recommend.failedPages ? recommend.lastError : "";
    } catch (error) {
      stats.jobrightRecommendError = error instanceof Error ? error.message : String(error);
      console.warn(`[github-jobs] jobright-recommend skipped: ${stats.jobrightRecommendError}`);
    }
  } else {
    console.log("[github-jobs] jobright-recommend skipped by --only/--skip");
  }

  let minisiteRows = [];
  let minisiteRejectedRows = [];
  if (fetchPlan.jobrightMinisite) {
    try {
      const minisite = await fetchJobrightMinisiteRows(
        new Set([...recommendRows, ...recommendRejectedRows].map((row) => row.jobrightId).filter(Boolean)),
        existingJobrightIds
      );
      minisiteRows = minisite.rows;
      minisiteRejectedRows = minisite.rejectedRows;
      rows.push(...minisiteRows);
      rows.push(...minisiteRejectedRows);
      stats.jobrightNotEligibleRows += minisiteRejectedRows.length;
      stats.jobrightMinisiteFetched = minisite.fetchedItems;
      stats.jobrightMinisiteRows = minisite.rows.length;
      stats.jobrightMinisiteBelowScore = minisite.belowScore;
      stats.jobrightMinisiteMissingScore = minisite.missingScore;
      stats.jobrightMinisiteRequirementFiltered = minisite.requirementFiltered;
      stats.jobrightMinisiteFailedPages = minisite.failedPages;
      stats.jobrightMinisiteError = minisite.lastError && minisite.failedPages ? minisite.lastError : "";
    } catch (error) {
      stats.jobrightMinisiteError = error instanceof Error ? error.message : String(error);
      console.warn(`[github-jobs] jobright-minisite skipped: ${stats.jobrightMinisiteError}`);
    }
  } else {
    console.log("[github-jobs] jobright-minisite skipped by --only/--skip");
  }

  const selectedGithubSources = [
    ...(fetchPlan.simplify ? GITHUB_SOURCES.filter((source) => source.key === "simplify") : []),
    ...(fetchPlan.speedy ? GITHUB_SOURCES.filter((source) => source.key.startsWith("speedy-")) : []),
    ...(fetchPlan.jobrightGithub ? JOBRIGHT_GITHUB_SOURCES : []),
  ];

  console.log(`[github-jobs] downloading GitHub sources count=${selectedGithubSources.length}`);
  const texts = {};
  for (const source of selectedGithubSources) {
    texts[source.key] = await downloadSource(source);
    console.log(`[github-jobs] ${source.key}: ${texts[source.key].length} bytes`);
  }

  if (texts.simplify) rows.push(...parseSimplifySections(texts.simplify));
  if (texts["speedy-swe"]) rows.push(...parseSpeedyTable(texts["speedy-swe"], "speedy-swe"));
  if (texts["speedy-ai"]) rows.push(...parseSpeedyTable(texts["speedy-ai"], "speedy-ai"));

  const jobrightGithubRows = [];
  for (const source of JOBRIGHT_GITHUB_SOURCES) {
    if (texts[source.key]) jobrightGithubRows.push(...parseJobrightTable(texts[source.key], source.source));
  }

  stats.jobrightGithubRaw = jobrightGithubRows.length;
  if (fetchPlan.jobrightGithub && jobrightGithubRows.length) {
    const resolved = await resolveJobrightGithubRows(
      jobrightGithubRows,
      new Set([...recommendRows, ...recommendRejectedRows, ...minisiteRows, ...minisiteRejectedRows].map((row) => row.jobrightId).filter(Boolean)),
      existingJobrightIds
    );
    rows.push(...resolved.rows);
    rows.push(...resolved.rejectedRows);
    stats.jobrightNotEligibleRows += resolved.rejectedRows.length;
    stats.jobrightGithubRows = resolved.rows.length;
    stats.jobrightGithubSkippedDuplicateIds = resolved.skippedDuplicateIds;
    stats.jobrightGithubSkippedExistingIds = resolved.skippedExistingIds;
    stats.jobrightGithubDetailFailed = resolved.detailFailed;
    stats.jobrightGithubBelowScore = resolved.belowScore;
    stats.jobrightGithubMissingScore = resolved.missingScore;
    stats.jobrightGithubRequirementFiltered = resolved.requirementFiltered;
    stats.jobrightGithubUnresolvedApplyLink = resolved.unresolvedApplyLink;
  } else if (!fetchPlan.jobrightGithub) {
    console.log("[github-jobs] jobright-github detail skipped by --only/--skip");
  }

  return { rows, stats };
}

async function upsertJobs(jobCol, docs) {
  if (!docs.length) return { inserted: 0, updated: 0, skippedExistingApplyLink: 0 };

  const existingByApplyLink = new Map();
  const existingDocs = await jobCol
    .find(
      {},
      {
        projection: {
          _id: 0,
          jobId: 1,
          applyLink: 1,
          jobrightId: 1,
          jobrightAliases: 1,
          tabCategory: 1,
          sourceTags: 1,
          sourceDetails: 1,
          sourceKind: 1,
          sourceRepo: 1,
          sourceLabel: 1,
        },
      }
    )
    .toArray();
  for (const existing of existingDocs) {
    const normalized = normalizeForDedup(existing.applyLink);
    if (normalized && !existingByApplyLink.has(normalized)) {
      existingByApplyLink.set(normalized, existing);
    }
  }

  const filteredDocs = [];
  const duplicateMergeOps = [];
  let skippedExistingApplyLink = 0;
  let mergedExistingApplyLinkJobrightAliases = 0;
  for (const doc of docs) {
    const normalized = normalizeForDedup(doc.applyLink);
    const existing = normalized ? existingByApplyLink.get(normalized) : null;
    const existingJobId = String(existing?.jobId || "");
    if (existingJobId && existingJobId !== doc.jobId) {
      skippedExistingApplyLink += 1;
      const aliasIds = getJobrightAliasIds(doc);
      const sourceKind = joinUnique([existing.sourceKind, doc.sourceKind].join("|").split("|"));
      const sourceRepo = joinUnique([existing.sourceRepo, doc.sourceRepo].join("|").split("|"));
      const sourceLabel = joinUnique([existing.sourceLabel, doc.sourceLabel].join("|").split("|"));
      if (aliasIds.length) {
        mergedExistingApplyLinkJobrightAliases += aliasIds.length;
      }
      const updateObj = {
        $set: {
          sourceKind,
          sourceRepo,
          sourceLabel,
          fetchedAt: doc.fetchedAt,
          updatedAt: doc.updatedAt,
        },
        $min: {
          postedAt: doc.postedAt,
        },
        $addToSet: {
          tabCategory: { $each: doc.tabCategory },
          sourceTags: { $each: doc.sourceTags },
          sourceDetails: { $each: doc.sourceDetails },
        },
      };
      if (aliasIds.length) {
        updateObj.$set.jobrightId = existing.jobrightId || doc.jobrightId || aliasIds[0];
        updateObj.$addToSet.jobrightAliases = { $each: aliasIds };
      }
      duplicateMergeOps.push({
        updateOne: {
          filter: { jobId: existingJobId },
          update: updateObj,
        },
      });
      continue;
    }
    filteredDocs.push(doc);
    if (normalized && !existingJobId) existingByApplyLink.set(normalized, doc);
  }

  if (!filteredDocs.length) {
    for (let i = 0; i < duplicateMergeOps.length; i += 500) {
      await jobCol.bulkWrite(duplicateMergeOps.slice(i, i + 500), { ordered: false });
    }
    return { inserted: 0, updated: 0, skippedExistingApplyLink, mergedExistingApplyLinkJobrightAliases };
  }

  const existingIds = new Set(
    (await jobCol.distinct("jobId", { jobId: { $in: filteredDocs.map((doc) => doc.jobId) } })).map(String)
  );

  let inserted = 0;
  let updated = 0;
  const ops = [];

  for (const doc of filteredDocs) {
    if (!existingIds.has(doc.jobId)) inserted += 1;
    else updated += 1;

    const isResolved = doc.applyLink && !isJobrightInfoUrl(doc.applyLink);
    const insertDoc = { ...doc };
    delete insertDoc.fetchedAt;
    delete insertDoc.postedAt;
    delete insertDoc.title;
    delete insertDoc.company;
    delete insertDoc.location;
    delete insertDoc.salary;
    delete insertDoc.workModel;
    delete insertDoc.applyLink;
    delete insertDoc.recruiterName;
    delete insertDoc.recruiterProfileUrl;
    delete insertDoc.detailsFetchedAt;
    delete insertDoc.detailsFetchStatus;
    delete insertDoc.tabCategory;
    delete insertDoc.top500;
    delete insertDoc.companyRank;
    delete insertDoc.matchScore;
    delete insertDoc.jobrightId;
    delete insertDoc.jobrightAliases;
    delete insertDoc.sourceTags;
    delete insertDoc.sourceDetails;
    delete insertDoc.sourceKind;
    delete insertDoc.sourceRepo;
    delete insertDoc.sourceLabel;
    delete insertDoc.isH1bSponsor;
    delete insertDoc.isCitizenOnly;
    delete insertDoc.minSalary;
    delete insertDoc.maxSalary;
    delete insertDoc.inactive;
    delete insertDoc.notEligible;
    delete insertDoc.notEligibleReason;
    delete insertDoc.eligibilityStatus;
    delete insertDoc.updatedAt;

    const addToSet = { tabCategory: { $each: doc.tabCategory } };
    if (doc.jobrightAliases?.length) addToSet.jobrightAliases = { $each: doc.jobrightAliases };

    ops.push({
      updateOne: {
        filter: { jobId: doc.jobId },
        update: {
          $setOnInsert: insertDoc,
          $set: {
            fetchedAt: doc.fetchedAt,
            title: doc.title,
            company: doc.company,
            location: doc.location,
            salary: doc.salary,
            workModel: doc.workModel,
            applyLink: doc.applyLink,
            detailsFetchedAt: doc.detailsFetchedAt,
            detailsFetchStatus: isResolved ? "ok" : doc.detailsFetchStatus,
            recruiterName: doc.recruiterName,
            recruiterProfileUrl: doc.recruiterProfileUrl,
            top500: doc.top500,
            companyRank: doc.companyRank,
            matchScore: doc.matchScore,
            jobrightId: doc.jobrightId,
            sourceTags: doc.sourceTags,
            sourceDetails: doc.sourceDetails,
            sourceKind: doc.sourceKind,
            sourceRepo: doc.sourceRepo,
            sourceLabel: doc.sourceLabel,
            isH1bSponsor: doc.isH1bSponsor,
            isCitizenOnly: doc.isCitizenOnly,
            minSalary: doc.minSalary,
            maxSalary: doc.maxSalary,
            inactive: false,
            notEligible: doc.notEligible,
            notEligibleReason: doc.notEligibleReason,
            eligibilityStatus: doc.eligibilityStatus,
            updatedAt: doc.updatedAt,
            category: doc.category,
            categoryLabel: doc.categoryLabel,
            categoryConfidence: doc.categoryConfidence,
            categoryPriority: doc.categoryPriority,
          },
          // Keep the earliest postedAt — never bump forward on re-scrape
          $min: { postedAt: doc.postedAt },
          $addToSet: addToSet,
        },
        upsert: true,
      },
    });
  }

  ops.push(...duplicateMergeOps);

  const chunkSize = 500;
  for (let i = 0; i < ops.length; i += chunkSize) {
    await jobCol.bulkWrite(ops.slice(i, i + chunkSize), { ordered: false });
  }

  return { inserted, updated, skippedExistingApplyLink, mergedExistingApplyLinkJobrightAliases };
}

async function runOnce() {
  await loadEnv();
  const mongoUri = applyUserMongoEnv(ROOT);
  if (!mongoUri) throw new Error(`${getMongoEnvHint(ROOT)} is not set`);

  const fetchPlan = getFetchPlan();
  console.log(`[github-jobs] mode=${getRunMode()} sourcePlan=${describeFetchPlan(fetchPlan)}`);

  const now = new Date();
  await mongoose.connect(mongoUri);
  const jobCol = mongoose.connection.db.collection("jobs");
  const existingJobrightIds = await loadExistingJobrightIds(jobCol);
  console.log(`[github-jobs] existing JobRight ids=${existingJobrightIds.size}`);

  const sourceResult = await parseAllSources(existingJobrightIds, fetchPlan);
  const rawRows = sourceResult.rows;
  console.log(`[github-jobs] parsed raw rows: ${rawRows.length}`);

  // Fetch latest jobs from Google Sheet (if SHEET_ID is configured)
  await importGoogleSheet().catch((err) =>
    console.warn("[github-jobs] Google Sheet import warning:", err instanceof Error ? err.message : String(err))
  );

  const canadaRows = rawRows.filter((row) => isCanadaLocation(row.location)).length;
  console.log(`[github-jobs] marked Canada rows not eligible: ${canadaRows}`);

  const top500Tokens = await loadTop500TokensWithRank();
  const prepared = [];

  for (const row of rawRows) {
    const applyLink = cleanApplyUrl(row.applyLinkRaw);
    if (!applyLink) continue;
    const canadaRow = isCanadaLocation(row.location)
      ? markNotEligible(row, "canada_location")
      : row;
    const eligibilityRow = isPhdTitle(canadaRow.title)
      ? markNotEligible(canadaRow, "phd_title")
      : waiveTop500SalaryNotEligible(canadaRow, top500Tokens);
    prepared.push({
      ...eligibilityRow,
      applyLink,
      applySource: "source",
      detailsFailed: "",
    });
  }

  const { rows: dedupedRows, duplicateRows } = mergeRowsByApplyLink(prepared);
  const rawDocs = dedupedRows.map((row) => buildJobDoc(row, now, top500Tokens));

  // Classify all docs via Jev AI with concurrency=20
  const JEV_CONCURRENCY = 20;
  const docs = await (async () => {
    const results = [...rawDocs];
    let idx = 0;
    const workers = Array.from({ length: Math.min(JEV_CONCURRENCY, rawDocs.length) }, async () => {
      while (idx < rawDocs.length) {
        const i = idx++;
        try {
          const cls = await classifyJobTitle(rawDocs[i].title, {
            roleType: rawDocs[i].roleType,
            jobFunction: rawDocs[i].jobFunction,
          });
          results[i] = { ...rawDocs[i], ...cls };
        } catch (e) {
          // keep defaults (others) on error
        }
      }
    });
    await Promise.all(workers);
    return results;
  })();
  const top500Rows = docs.filter((doc) => doc.top500).length;
  const reactivatedInactive = await reactivateInactiveJobs(jobCol);
  const upsert = await upsertJobs(jobCol, docs);
  const inactiveSync = { reactivated: reactivatedInactive, markedInactive: 0, skipped: true, reason: "dedup_skips_inserts" };
  const normalizedUrls = await normalizeStoredJobUrls(jobCol);
  const dedupMarked = 0;

  await mongoose.disconnect();

  const result = {
    mode: "github",
    runMode: getRunMode(),
    rawRows: rawRows.length,
    removedCanada: 0,
    canadaNotEligible: canadaRows,
    prepared: prepared.length,
    dedupedRows: dedupedRows.length,
    duplicateRows,
    top500Rows,
    ...sourceResult.stats,
    inserted: upsert.inserted,
    updated: upsert.updated,
    skippedExistingApplyLink: upsert.skippedExistingApplyLink,
    mergedExistingApplyLinkJobrightAliases: upsert.mergedExistingApplyLinkJobrightAliases,
    inactiveSync,
    normalizedUrls,
    dedupMarked,
  };

  console.log("[github-jobs] done", JSON.stringify(result, null, 2));
  return result;
}

async function runLoop() {
  for (;;) {
    try {
      await runOnce();
    } catch (error) {
      console.error("[github-jobs] run failed:", error instanceof Error ? error.message : String(error));
      try {
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
      } catch {
        // ignore disconnect failures
      }
    }
    console.log(`[github-jobs] sleeping ${(LOOP_INTERVAL_MS / 60000).toFixed(0)}m`);
    await sleep(LOOP_INTERVAL_MS);
  }
}

if (process.argv.includes("--watch") || process.argv.includes("--cron")) {
  await runLoop();
} else {
  await runOnce();
}
