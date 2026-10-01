#!/usr/bin/env node
/**
 * One-time JobRight recommendation importer.
 *
 * Defaults match the browser request:
 *   page 1 refresh=true at position=0, later pages refresh=false, count=20, pages=20, delay=20s
 *
 * Choose another sort condition with:
 *   npm run jobright-recommend-once -- --sortCondition=2
 */

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { applyUserMongoEnv, getMongoEnvHint } from "../lib/user-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const mongoose = require("mongoose");

const ROOT = path.resolve(__dirname, "..", "..");
const JOBRIGHT_RECOMMEND_URL = "https://jobright.ai/swan/recommend/list/jobs";
const DEFAULT_JOBRIGHT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const DATE_ONLY_PACIFIC_HOUR = 0;
const DATE_ONLY_PACIFIC_MINUTE = 1;
const CLI_ARGS = parseCliArgs(process.argv.slice(2));

const SOURCE_METADATA = {
  "jobright-recommend-once": {
    kind: "jobright-api",
    label: "JobRight API",
    repo: "",
    url: JOBRIGHT_RECOMMEND_URL,
  },
};

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
  "group",
  "holding",
  "holdings",
  "systems",
  "solutions",
  "services",
  "service",
  "technology",
  "technologies",
]);

async function loadEnv() {
  try {
    const raw = await readFile(path.join(ROOT, ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
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

function envInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

  if (positional[0] && !out.has("sortCondition")) out.set("sortCondition", positional[0]);
  return out;
}

function cliValue(...names) {
  for (const name of names) {
    if (CLI_ARGS.has(name)) return CLI_ARGS.get(name);
  }
  return "";
}

function getSortCondition() {
  const raw = cliValue("sortCondition", "sort-condition", "sort") || process.env.JOBRIGHT_ONCE_SORT_CONDITION || "0";
  const parsed = Number.parseInt(raw, 10);
  if (![0, 1, 2].includes(parsed)) {
    throw new Error(`Invalid sortCondition '${raw}'. Use 0, 1, or 2.`);
  }
  return parsed;
}

function envFloat(name, fallback) {
  const parsed = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<\/?br\s*\/?>/gi, ", ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCompanyOrTitle(value) {
  return stripHtml(value)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
    // Fall through.
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

function normalizeForDedup(rawUrl) {
  const input = normalizeJobUrlForStorage(String(rawUrl || "")).trim();
  if (!input) return "";
  try {
    const url = new URL(input);
    if (!/^https?:$/i.test(url.protocol)) return "";
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

function buildHeaders() {
  const headers = {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.5",
    priority: "u=1, i",
    referer: "https://jobright.ai/jobs/recommend",
    "sec-ch-ua": '"Chromium";v="152", "Not?A_Brand";v="24", "Brave";v="152"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-gpc": "1",
    "user-agent": process.env.JOBRIGHT_USER_AGENT || DEFAULT_JOBRIGHT_USER_AGENT,
    "x-client-type": "web",
  };
  if (process.env.JOBRIGHT_COOKIE) headers.cookie = process.env.JOBRIGHT_COOKIE;
  return headers;
}

function extractJsonArray(data) {
  const candidates = [
    data?.result?.jobList,
    data?.result?.jobs,
    data?.data?.jobList,
    data?.data?.jobs,
    data?.jobs,
    data?.jobList,
    data?.data,
  ];
  return candidates.find(Array.isArray) || [];
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

function asCleanUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? raw : "";
  } catch {
    return "";
  }
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

function readScore(record, job) {
  for (const value of [
    record?.displayScore,
    record?.score,
    record?.jobNotes?.displayScore,
    job?.displayScore,
    job?.score,
    job?.jobNotes?.displayScore,
    job?.recommendationScores?.displayScore,
  ]) {
    const score = normalizeScore(value);
    if (score !== null) return score;
  }
  return null;
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

function markJobrightNotEligible(row, reason) {
  return {
    ...row,
    notEligible: true,
    notEligibleReason: reason || "filtered",
  };
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

function getJobNode(record) {
  return record?.jobResult || record?.job || record || {};
}

function recordToRow(record) {
  const job = getJobNode(record);
  const company = record?.companyResult || job?.companyResult || {};
  const jobrightId = firstNonEmpty(job.jobId, job.id, record.jobId, record.id);
  const applyLinkRaw =
    asCleanUrl(firstNonEmpty(job.applyLink, job.originalUrl, job.jobUrl, job.url, record.applyLink, record.originalUrl)) ||
    (jobrightId ? `https://jobright.ai/jobs/info/${encodeURIComponent(jobrightId)}` : "");
  const score = readScore(record, job);

  return {
    source: "jobright-recommend-once",
    company: cleanCompanyOrTitle(firstNonEmpty(job.companyName, company.companyName, job.company, record.companyName)),
    title: cleanCompanyOrTitle(firstNonEmpty(job.jobTitle, job.title, record.jobTitle, record.title)),
    location: compactLocation(job.jobLocation, job.location, record.jobLocation, record.location, job.jobLocations),
    salary: firstNonEmpty(job.salaryDesc, record.salaryDesc, job.salary, record.salary),
    workModel: firstNonEmpty(job.workModel, record.workModel),
    age: firstNonEmpty(job.publishTime, record.publishTime, job.publishTimeDesc, record.publishTimeDesc),
    jobrightId,
    applyLinkRaw,
    recruiterName: firstNonEmpty(job.jobRecruiter, record.jobRecruiter),
    recruiterProfileUrl: firstNonEmpty(job.jobRecruiterProfileUrl, record.jobRecruiterProfileUrl),
    score,
    isH1bSponsor: firstDefined(job.isH1bSponsor, record.isH1bSponsor),
    isCitizenOnly: firstDefined(job.isCitizenOnly, record.isCitizenOnly),
    minSalary: firstDefined(job.minSalary, record.minSalary),
    maxSalary: firstDefined(job.maxSalary, record.maxSalary),
  };
}

async function fetchPage(position, refresh) {
  const url = new URL(JOBRIGHT_RECOMMEND_URL);
  url.search = new URLSearchParams({
    refresh: refresh ? "true" : "false",
    sortCondition: String(getSortCondition()),
    position: String(position),
    count: String(envInt("JOBRIGHT_ONCE_PAGE_SIZE", 20)),
    syncRerank: "false",
  }).toString();

  const res = await fetch(url, {
    headers: buildHeaders(),
    signal: AbortSignal.timeout(envInt("JOBRIGHT_ONCE_TIMEOUT_MS", 30_000)),
  });
  if (!res.ok) throw new Error(`jobright_recommend_http_${res.status}`);
  const data = await res.json();
  return extractJsonArray(data);
}

async function fetchRows() {
  const sortCondition = getSortCondition();
  const startPosition = envInt("JOBRIGHT_ONCE_START_POSITION", 0);
  const pages = envInt("JOBRIGHT_ONCE_PAGES", 20);
  const pageSize = envInt("JOBRIGHT_ONCE_PAGE_SIZE", 20);
  const delayMs = envInt("JOBRIGHT_ONCE_DELAY_MS", 20_000);
  const attempts = envInt("JOBRIGHT_ONCE_MAX_ATTEMPTS", 3);
  const threshold = envFloat("JOBRIGHT_SCORE_THRESHOLD", 65);
  const rows = [];
  const rejectedRows = [];
  let fetched = 0;
  let belowScore = 0;
  let missingScore = 0;
  let missingApplyLink = 0;
  let requirementFiltered = 0;
  let failedPages = 0;

  for (let page = 0; page < pages; page += 1) {
    const position = startPosition + page * pageSize;
    let records = null;
    let lastError = "";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        records = await fetchPage(position, page === 0 && startPosition === 0);
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < attempts) await sleep(envInt("JOBRIGHT_ONCE_RETRY_DELAY_MS", 20_000));
      }
    }
    if (!records) {
      failedPages += 1;
      console.warn(`[jobright-once] page=${page + 1}/${pages} position=${position} failed error=${lastError}`);
      if (page + 1 < pages) await sleep(delayMs);
      continue;
    }

    fetched += records.length;
    for (const record of records) {
      const row = recordToRow(record);
      if (!row.jobrightId || !row.title) continue;
      if (isPhdTitle(row.title)) {
        requirementFiltered += 1;
        rejectedRows.push(markJobrightNotEligible(row, "phd_title"));
        continue;
      }
      if (!row.applyLinkRaw) {
        missingApplyLink += 1;
        rejectedRows.push(markJobrightNotEligible(row, "missing_apply_link"));
        continue;
      }
      if (row.score === null) {
        missingScore += 1;
        rejectedRows.push(markJobrightNotEligible(row, "missing_score"));
        continue;
      }
      if (row.score <= threshold) {
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

    console.log(
      `[jobright-once] sortCondition=${sortCondition} page=${page + 1}/${pages} done=${page + 1}/${pages} refresh=${page === 0 && startPosition === 0} position=${position} items=${records.length} kept=${rows.length}`
    );
    if (page + 1 < pages) await sleep(delayMs);
  }

  return { rows, rejectedRows, fetched, belowScore, missingScore, missingApplyLink, requirementFiltered, failedPages };
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
      if (hasTime && hasExplicitZone) {
        const direct = Date.parse(raw.replace(" ", "T"));
        if (!Number.isNaN(direct)) return new Date(direct);
      }
      if (hasTime) return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
      return pacificWallTimeToDate(year, month - 1, day, hour, minute, second);
    }
  }

  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    const ms = raw.length >= 13 ? n : n * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const value = raw.toLowerCase();
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
    else d.setMinutes(d.getMinutes() - amount);
    if (["h", "hr", "hrs", "hour", "hours", "min", "mins", "minute", "minutes", "m"].includes(unit)) return d;
    return toPacificDateOnly(d);
  }

  return toPacificDateOnly(now);
}

function buildJobId(row) {
  if (row.jobrightId) return row.jobrightId;
  const ghToken = extractGreenhouseToken(row.applyLink);
  if (ghToken) return `greenhouse:${ghToken}`;
  return `jobright-once:${hashId(row.applyLink)}`;
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
  return [...new Set(out.filter(Boolean))];
}

function getSourceKeys(row) {
  return [...new Set(String(row.source || "").split("|").map((value) => value.trim()).filter(Boolean))];
}

function getSourceDetails(row) {
  return getSourceKeys(row).map((key) => {
    const meta = SOURCE_METADATA[key] || {
      kind: key.startsWith("jobright") ? "jobright-api" : "github",
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
    detailsFetchedAt: now,
    detailsFetchStatus: row.notEligible ? `not_eligible:${row.notEligibleReason || "filtered"}` : "ok",
    inactive: false,
    notEligible: Boolean(row.notEligible),
    notEligibleReason: row.notEligibleReason || "",
    eligibilityStatus: row.notEligible ? "not_eligible" : "eligible",
    isExtraApiJob: false,
  };
}

function dedupRowsByJobId(rows) {
  const byJobId = new Map();
  let duplicateJobIds = 0;
  for (const row of rows) {
    if (!row.jobrightId) continue;
    if (byJobId.has(row.jobrightId)) {
      duplicateJobIds += 1;
      continue;
    }
    byJobId.set(row.jobrightId, row);
  }
  return { rows: [...byJobId.values()], duplicateJobIds };
}

function dedupRowsByApplyLink(rows) {
  const byApplyLink = new Map();
  let duplicateApplyLinks = 0;
  for (const row of rows) {
    const key = normalizeForDedup(row.applyLink);
    if (!key) continue;
    if (byApplyLink.has(key)) {
      duplicateApplyLinks += 1;
      continue;
    }
    byApplyLink.set(key, row);
  }
  return { rows: [...byApplyLink.values()], duplicateApplyLinks };
}

async function skipExistingDocs(jobCol, docs) {
  const existingJobIds = new Set((await jobCol.distinct("jobId", { jobId: { $in: docs.map((doc) => doc.jobId) } })).map(String));
  const existingByApplyLink = new Map();
  const existingDocs = await jobCol.find({}, { projection: { _id: 0, jobId: 1, applyLink: 1 } }).toArray();
  for (const existing of existingDocs) {
    const normalized = normalizeForDedup(existing.applyLink);
    if (normalized && !existingByApplyLink.has(normalized)) existingByApplyLink.set(normalized, String(existing.jobId || ""));
  }

  const filtered = [];
  let skippedExistingJobId = 0;
  let skippedExistingApplyLink = 0;
  for (const doc of docs) {
    if (existingJobIds.has(doc.jobId)) {
      skippedExistingJobId += 1;
      continue;
    }
    const normalized = normalizeForDedup(doc.applyLink);
    if (normalized && existingByApplyLink.has(normalized)) {
      skippedExistingApplyLink += 1;
      continue;
    }
    filtered.push(doc);
    if (normalized) existingByApplyLink.set(normalized, doc.jobId);
  }

  return { docs: filtered, skippedExistingJobId, skippedExistingApplyLink };
}

async function main() {
  await loadEnv();
  const mongoUri = applyUserMongoEnv(ROOT);
  if (!mongoUri) throw new Error(`${getMongoEnvHint(ROOT)} is not set`);
  if (!process.env.JOBRIGHT_COOKIE) throw new Error("JOBRIGHT_COOKIE is not set");

  const now = new Date();
  const fetched = await fetchRows();
  const withApplyLink = [...fetched.rows, ...fetched.rejectedRows]
    .map((row) => ({ ...row, applyLink: normalizeJobUrlForStorage(row.applyLinkRaw) }))
    .filter((row) => row.applyLink);
  const byJobId = dedupRowsByJobId(withApplyLink);
  const byApplyLink = dedupRowsByApplyLink(byJobId.rows);
  const top500Tokens = await loadTop500TokensWithRank();
  const docs = byApplyLink.rows.map((row) => buildJobDoc(row, now, top500Tokens));

  await mongoose.connect(mongoUri);
  const jobCol = mongoose.connection.db.collection("jobs");
  await jobCol.updateMany({ inactive: true }, { $set: { inactive: false } });
  const filtered = await skipExistingDocs(jobCol, docs);

  let inserted = 0;
  if (filtered.docs.length) {
    try {
      const res = await jobCol.insertMany(filtered.docs, { ordered: false });
      inserted = Object.keys(res.insertedIds || {}).length;
    } catch (error) {
      inserted = error?.result?.insertedCount || 0;
      console.warn(`[jobright-once] insert warning: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await mongoose.disconnect();

  const result = {
    mode: "jobright-recommend-once",
    sortCondition: getSortCondition(),
    fetched: fetched.fetched,
    belowScore: fetched.belowScore,
    missingScore: fetched.missingScore,
    missingApplyLink: fetched.missingApplyLink,
    requirementFiltered: fetched.requirementFiltered,
    notEligibleRows: fetched.rejectedRows.length,
    failedPages: fetched.failedPages,
    afterScoreFilter: fetched.rows.length,
    duplicateJobIds: byJobId.duplicateJobIds,
    duplicateApplyLinks: byApplyLink.duplicateApplyLinks,
    skippedExistingJobId: filtered.skippedExistingJobId,
    skippedExistingApplyLink: filtered.skippedExistingApplyLink,
    inserted,
  };
  console.log("[jobright-once] done", JSON.stringify(result, null, 2));
}

try {
  await main();
} catch (error) {
  try {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  } catch {
    // ignore disconnect failures
  }
  console.error("[jobright-once] failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
