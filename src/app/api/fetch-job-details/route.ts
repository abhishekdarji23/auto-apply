import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Job from "@/models/Job";
import { deduplicateByApplyUrl } from "@/lib/deduplicateByApplyUrl";
import { normalizeJobUrlForStorage } from "@/lib/jobUrlNormalization";
import { normalizeStoredJobUrls } from "@/lib/normalizeStoredJobUrls";

import { chromium } from "playwright";

const JOBRIGHT_INFO_URL = "https://jobright.ai/jobs/info";
const ASHBY_CONCURRENCY = 5; // parallel tabs for ashby resolution
const ASHBY_PAGE_TIMEOUT_MS = 30000;

const CONCURRENCY = 20;
const BURST_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 9000;

type JobDetailsPatch = {
  jobId: string;
  applyLink?: string;
  recruiterName?: string;
  recruiterProfileUrl?: string;
  isH1bSponsor?: boolean | null;
  isCitizenOnly?: boolean | null;
  minSalary?: number | null;
  maxSalary?: number | null;
  detailsFetchedAt: string;
  detailsFetchStatus: string;
};

let inFlightFetch: Promise<{
  success: true;
  candidates: number;
  processed: number;
  updated: number;
  failed: number;
  dedupMarked: number;
  ashbyResolved: number;
  ashbyFailed: number;
  patches: JobDetailsPatch[];
}> | null = null;

let cachedHeaders: Record<string, string> | null = null;

function buildHeaders() {
  if (cachedHeaders) return cachedHeaders;
  cachedHeaders = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "max-age=0",
    "priority": "u=0, i",
    "sec-ch-ua": '"Not:A-Brand";v="99", "Brave";v="145", "Chromium";v="145"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "sec-gpc": "1",
    "upgrade-insecure-requests": "1",
    "user-agent": process.env.JOBRIGHT_USER_AGENT ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    "cookie": process.env.JOBRIGHT_COOKIE || "",
  };
  return cachedHeaders;
}

function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null);
}

function parseOptionalBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(text)) return true;
  if (["false", "no", "n", "0"].includes(text)) return false;
  return null;
}

function optionalBooleanEquals(value: unknown, expected: boolean) {
  const parsed = parseOptionalBoolean(value);
  return parsed === null || parsed === expected;
}

function parseOptionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function checkJobrightOptionalRequirements(details: {
  isH1bSponsor?: unknown;
  isCitizenOnly?: unknown;
  minSalary?: unknown;
}) {
  if (!optionalBooleanEquals(details.isH1bSponsor, true)) return "h1b";
  if (!optionalBooleanEquals(details.isCitizenOnly, false)) return "citizen_only";
  const minSalary = parseOptionalNumber(details.minSalary);
  if (minSalary !== null && minSalary <= 100_000) return "salary";
  return "";
}

function extractDetails(html: string) {
  const match = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match?.[1]) return null;
  try {
    const data = JSON.parse(match[1]);
    // console.log(data?.props?.pageProps?.dataSource?.jobResult)
    const dataSource = data?.props?.pageProps?.dataSource || {};
    const job = dataSource.jobResult;
    if (!job) return null;
    const clean = (s: unknown) => {
      const str = typeof s === "string" ? s.trim() : "";
      if (!str) return "";
      try {
        const u = new URL(str);
        return ["http:", "https:"].includes(u.protocol) ? str : "";
      } catch {
        return "";
      }
    };
    const applyLink = normalizeJobUrlForStorage(clean(job.applyLink)) ||
      normalizeJobUrlForStorage(clean(job.originalUrl));
    return {
      applyLink,
      recruiterName: typeof job.jobRecruiter === "string" ? job.jobRecruiter.trim() : "",
      recruiterProfileUrl: typeof job.jobRecruiterProfileUrl === "string" ? job.jobRecruiterProfileUrl.trim() : "",
      isH1bSponsor: parseOptionalBoolean(firstDefined(job.isH1bSponsor, dataSource.isH1bSponsor)),
      isCitizenOnly: parseOptionalBoolean(firstDefined(job.isCitizenOnly, dataSource.isCitizenOnly)),
      minSalary: parseOptionalNumber(firstDefined(job.minSalary, dataSource.minSalary)),
      maxSalary: parseOptionalNumber(firstDefined(job.maxSalary, dataSource.maxSalary)),
    };
  } catch {
    return null;
  }
}

async function fetchOne(jobId: string) {
  try {
    const res = await fetch(`${JOBRIGHT_INFO_URL}/${encodeURIComponent(jobId)}`, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false as const, code: `http_${res.status}` };
    const html = await res.text();
    const details = extractDetails(html);
    if (!details) return { ok: false as const, code: "parse_failed" };
    const requirementIssue = checkJobrightOptionalRequirements(details);
    if (requirementIssue) return { ok: false as const, code: `filtered_${requirementIssue}`, details };
    return { ok: true as const, details };
  } catch (err) {
    console.error(`[fetch-details] fetch error jobId=${jobId}:`, err instanceof Error ? err.message : err);
    return { ok: false as const, code: "fetch_error" };
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveAshbyLinks(): Promise<{ resolved: number; failed: number }> {
  // Find active jobs where ashby_jid appears in applyLink — regardless of fetch status
  const candidates = await Job.find(
    {
      inactive: { $ne: true },
      applyLink: { $regex: "ashby_jid", $options: "i" },
    },
    { _id: 0, jobId: 1, applyLink: 1 }
  ).lean();

  console.log(`[ashby-resolve] candidates=${candidates.length}`);
  if (candidates.length === 0) return { resolved: 0, failed: 0 };

  let resolved = 0;
  let failed = 0;

  const browser = await chromium.launch({ headless: true });

  try {
    for (let i = 0; i < candidates.length; i += ASHBY_CONCURRENCY) {
      const chunk = candidates.slice(i, i + ASHBY_CONCURRENCY);

      const results = await Promise.all(
        chunk.map(async (c) => {
          const { jobId, applyLink } = c as { jobId: string; applyLink: string };
          const pageUrl = applyLink;
          if (!pageUrl) return { jobId, ashbyUrl: null };

          const ashbyJid = (() => {
            try { return new URL(pageUrl).searchParams.get("ashby_jid"); } catch { return null; }
          })();

          if (!ashbyJid) return { jobId, ashbyUrl: null };

          const page = await browser.newPage();
          let ashbyUrl: string | null = null;
          const seen = new Set<string>();

          page.on("request", (request) => {
            const reqUrl = request.url();
            if (
              request.method() === "GET" &&
              reqUrl.includes("jobs.ashbyhq.com") &&
              reqUrl.includes(ashbyJid) &&
              !seen.has(reqUrl)
            ) {
              seen.add(reqUrl);
              if (!ashbyUrl) ashbyUrl = reqUrl;
            }
          });

          try {
            await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: ASHBY_PAGE_TIMEOUT_MS });
            await page.waitForTimeout(4000);
          } catch {
            // timeout or nav error — use whatever we captured so far
          } finally {
            await page.close();
          }

          return { jobId, ashbyUrl };
        })
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bulkOps: any[] = [];
      for (const { jobId, ashbyUrl } of results) {
        if (ashbyUrl) {
          resolved++;
          // Strip all query params and remove trailing /application path segment
          let cleanAshbyUrl: string = ashbyUrl;
          try {
            const u = new URL(ashbyUrl);
            // Remove all query params
            u.search = "";
            // Remove trailing /application segment
            u.pathname = u.pathname.replace(/\/application\/?$/, "");
            cleanAshbyUrl = u.toString();
          } catch { /* keep original */ }
          bulkOps.push({
            updateOne: {
              filter: { jobId },
              update: { $set: { applyLink: cleanAshbyUrl } },
            },
          });
          console.log(`[ashby-resolve] resolved jobId=${jobId} → ${cleanAshbyUrl}`);
        } else {
          failed++;
          console.warn(`[ashby-resolve] no ashby network request found for jobId=${jobId}`);
        }
      }

      if (bulkOps.length > 0) {
        await Job.bulkWrite(bulkOps, { ordered: false });
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`[ashby-resolve] done resolved=${resolved} failed=${failed}`);
  return { resolved, failed };
}

function buildCleanAshbyUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = "";
    u.pathname = u.pathname.replace(/\/application\/?$/, "");
    return u.toString();
  } catch {
    return raw;
  }
}

async function cleanAshbyUrls(): Promise<number> {
  // Find ALL active jobs that already have a jobs.ashbyhq.com applyLink
  const candidates = await Job.find(
    {
      inactive: { $ne: true },
      applyLink: { $regex: "jobs\\.ashbyhq\\.com", $options: "i" },
    },
    { _id: 0, jobId: 1, applyLink: 1 }
  ).lean();

  console.log(`[ashby-clean] candidates=${candidates.length}`);
  if (candidates.length === 0) return 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bulkOps: any[] = [];
  for (const c of candidates) {
    const { jobId, applyLink } = c as { jobId: string; applyLink: string };
    const cleanApply = applyLink?.includes("jobs.ashbyhq.com") ? buildCleanAshbyUrl(applyLink) : applyLink;
    if (cleanApply !== applyLink) {
      bulkOps.push({
        updateOne: {
          filter: { jobId },
          update: { $set: { applyLink: cleanApply } },
        },
      });
    }
  }

  if (bulkOps.length > 0) {
    await Job.bulkWrite(bulkOps, { ordered: false });
  }

  console.log(`[ashby-clean] cleaned=${bulkOps.length}`);
  return bulkOps.length;
}

async function runFetchDetails() {
  await dbConnect();

  // Find jobs where applyLink is empty/null AND not already successfully fetched
  const candidates = await Job.find(
    {
      $or: [{ applyLink: { $in: [null, ""] } }, { applyLink: { $exists: false } }],
    },
    { _id: 0, jobId: 1 }
  )
    .sort({ postedAt: -1 })
    .lean();

  console.log(`[fetch-details] candidates=${candidates.length}`);

  if (candidates.length === 0) {
    console.log("[fetch-details] no candidates, resolving ashby links...");
    const { resolved: ashbyResolved, failed: ashbyFailed } = await resolveAshbyLinks();
    console.log("[fetch-details] cleaning all ashby urls...");
    await cleanAshbyUrls();
    console.log("[fetch-details] normalizing stored urls...");
    await normalizeStoredJobUrls();
    console.log("[fetch-details] running dedup...");
    const dedupMarked = await deduplicateByApplyUrl();
    console.log(`[fetch-details] done updated=0 failed=0 ashbyResolved=${ashbyResolved} ashbyFailed=${ashbyFailed} dedupMarked=${dedupMarked}`);
    return { success: true as const, candidates: 0, processed: 0, updated: 0, failed: 0, dedupMarked, ashbyResolved, ashbyFailed, patches: [] as JobDetailsPatch[] };
  }

  let updated = 0;
  let failed = 0;
  const patches: JobDetailsPatch[] = [];

  // Process in bursts of CONCURRENCY
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const chunk = candidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (c) => {
        const jobId = String((c as { jobId: string }).jobId);
        return { jobId, result: await fetchOne(jobId) };
      })
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bulkOps: any[] = [];
    for (const { jobId, result } of results) {
      const now = new Date();
      if (result.ok) {
        // console.log(jobId, result.details);
        bulkOps.push({
          updateOne: {
            filter: { jobId },
            update: {
              $set: {
                applyLink: result.details.applyLink,
                recruiterName: result.details.recruiterName,
                recruiterProfileUrl: result.details.recruiterProfileUrl,
                jobrightId: jobId,
                isH1bSponsor: result.details.isH1bSponsor,
                isCitizenOnly: result.details.isCitizenOnly,
                minSalary: result.details.minSalary,
                maxSalary: result.details.maxSalary,
                notEligible: false,
                notEligibleReason: "",
                eligibilityStatus: "eligible",
                detailsFetchedAt: now,
                detailsFetchStatus: "ok",
              },
            },
          },
        });
        patches.push({
          jobId,
          applyLink: result.details.applyLink,
          recruiterName: result.details.recruiterName,
          recruiterProfileUrl: result.details.recruiterProfileUrl,
          isH1bSponsor: result.details.isH1bSponsor,
          isCitizenOnly: result.details.isCitizenOnly,
          minSalary: result.details.minSalary,
          maxSalary: result.details.maxSalary,
          detailsFetchedAt: now.toISOString(),
          detailsFetchStatus: "ok",
        });
      } else {
        failed++;
        console.error(`[fetch-details] FAILED jobId=${jobId} code=${result.code}`);
        const maybeDetails = "details" in result ? result.details : null;
        const isFiltered = result.code.startsWith("filtered_");
        const filteredReason = isFiltered ? result.code.replace(/^filtered_/, "") : "";
        const updateSet = {
          detailsFetchedAt: now,
          detailsFetchStatus: result.code,
          ...(isFiltered
            ? {
                jobrightId: jobId,
                isH1bSponsor: maybeDetails?.isH1bSponsor ?? null,
                isCitizenOnly: maybeDetails?.isCitizenOnly ?? null,
                minSalary: maybeDetails?.minSalary ?? null,
                maxSalary: maybeDetails?.maxSalary ?? null,
                notEligible: true,
                notEligibleReason: filteredReason,
                eligibilityStatus: "not_eligible",
              }
            : {}),
        };
        bulkOps.push({
          updateOne: {
            filter: { jobId },
            update: { $set: updateSet },
          },
        });
        patches.push({ jobId, detailsFetchedAt: now.toISOString(), detailsFetchStatus: result.code });
      }
    }

    if (bulkOps.length > 0) {
      const writeResult = await Job.bulkWrite(bulkOps, { ordered: false });
      updated += writeResult.modifiedCount || 0;
    }

    const done = Math.min(i + CONCURRENCY, candidates.length);
    console.log(`[fetch-details] progress=${done}/${candidates.length} (updated=${updated} failed=${failed})`);

    // Wait between bursts
    if (i + CONCURRENCY < candidates.length && BURST_DELAY_MS > 0) {
      await delay(BURST_DELAY_MS);
    }
  }

  // After ALL details fetched, resolve Ashby links → clean all Ashby URLs → dedup last
  console.log("[fetch-details] resolving ashby links...");
  const { resolved: ashbyResolved, failed: ashbyFailed } = await resolveAshbyLinks();

  console.log("[fetch-details] cleaning all ashby urls...");
  await cleanAshbyUrls();

  console.log("[fetch-details] normalizing stored urls...");
  await normalizeStoredJobUrls();

  console.log("[fetch-details] running dedup...");
  const dedupMarked = await deduplicateByApplyUrl();

  console.log(`[fetch-details] done updated=${updated} failed=${failed} ashbyResolved=${ashbyResolved} ashbyFailed=${ashbyFailed} dedupMarked=${dedupMarked}`);
  return { success: true as const, candidates: candidates.length, processed: candidates.length, updated, failed, dedupMarked, ashbyResolved, ashbyFailed, patches };
}

export async function POST() {
  try {
    if (!inFlightFetch) {
      inFlightFetch = runFetchDetails().finally(() => {
        inFlightFetch = null;
      });
    }
    const result = await inFlightFetch;
    return NextResponse.json(result);
  } catch (error) {
    console.error("Fetch job details error:", error);
    return NextResponse.json(
      { error: "Internal server error", details: String(error) },
      { status: 500 }
    );
  }
}
