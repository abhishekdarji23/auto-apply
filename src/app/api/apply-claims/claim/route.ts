import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Job from "@/models/Job";
import AutoApplyJob from "@/models/AutoApplyJob";
import ResumeDashboardItem from "@/models/ResumeDashboardItem";
import { detectATS } from "@/lib/ats-map";
import { getJobrightApplyId } from "@/lib/jobrightApply";

export const runtime = "nodejs";

type ClaimBody = {
  email?: string;
  ats?: "all" | "workday" | "greenhouse";
  retry?: boolean;
  retryAfter?: string;
  defaultResume?: boolean | string;
  notEligible?: boolean | string;
  excludeUrls?: string[];
};

const SUPPORTED_APPLY_ATS = new Set(["workday", "greenhouse"]);

function normalizeComparableUrl(rawUrl: string): string {
  const value = String(rawUrl || "").trim();
  if (!value) return "";

  try {
    const url = new URL(value);
    url.hash = "";

    const keepEntries: Array<[string, string]> = [];
    for (const [key, val] of url.searchParams.entries()) {
      if (key.toLowerCase().startsWith("utm_")) continue;
      keepEntries.push([key.toLowerCase(), val.toLowerCase()]);
    }

    keepEntries.sort((a, b) => {
      if (a[0] === b[0]) return a[1].localeCompare(b[1]);
      return a[0].localeCompare(b[0]);
    });

    url.search = "";
    for (const [key, val] of keepEntries) {
      url.searchParams.append(key, val);
    }

    return url.toString().toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function pickJobUrl(job: { applyLink?: string }): string {
  return String(job.applyLink || "").trim();
}

function normalizeClaimEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

function normalizeResumeEmail(email: string): string {
  const value = normalizeClaimEmail(email);
  if (!value) return "";
  return value.replace(/[^a-z0-9@._-]/g, "_");
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAtsMatch(atsId: string, filter: "all" | "workday" | "greenhouse"): boolean {
  if (filter === "all") return SUPPORTED_APPLY_ATS.has(atsId);
  return atsId === filter;
}

function parseRetryAfterDate(raw?: string): Date | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (isNaN(parsed.getTime())) return null;
  return parsed;
}

function isTerminalStatus(
  status: string,
  retry: boolean,
  jobDate?: Date | null,
  retryAfterDate?: Date | null
): boolean {
  if (status === "success" || status === "applied" || status === "skipped") return true;
  if (status === "failed") {
    if (!retry) return true;
    if (retryAfterDate) {
      if (!jobDate) return true;
      if (jobDate.getTime() < retryAfterDate.getTime()) return true;
    }
    return false;
  }
  return false;
}

function statusPriority(status: string): number {
  switch (status) {
    case "success":
    case "applied":
      return 4;
    case "skipped":
      return 3;
    case "failed":
      return 2;
    default:
      return 1;
  }
}

function shouldSkipNotEligible(value: unknown): boolean {
  if (value === false) return false;
  if (typeof value === "string" && value.trim().toLowerCase() === "false") return false;
  return true;
}

function isTruthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as ClaimBody;
    const rawEmail = String(body.email || "");
    const email = normalizeClaimEmail(rawEmail);
    const resumeEmail = normalizeResumeEmail(rawEmail);
    const atsFilter = (String(body.ats || "all").trim().toLowerCase() || "all") as
      | "all"
      | "workday"
      | "greenhouse";
    const retryAfterDate = parseRetryAfterDate(body.retryAfter);
    const retry = Boolean(body.retry || retryAfterDate);
    const defaultResume = isTruthy(body.defaultResume);
    const skipNotEligible = shouldSkipNotEligible(body.notEligible);
    const excludeSet = new Set(
      (Array.isArray(body.excludeUrls) ? body.excludeUrls : [])
        .map((url) => normalizeComparableUrl(String(url || "")))
        .filter(Boolean)
    );

    if (!email) {
      return NextResponse.json({ success: false, error: "missing_email" }, { status: 400 });
    }
    if (!["all", "workday", "greenhouse"].includes(atsFilter)) {
      return NextResponse.json({ success: false, error: "invalid_ats_filter" }, { status: 400 });
    }

    await dbConnect();

    const jobFilter: Record<string, unknown> = {
      inactive: { $ne: true },
      manualApplied: { $ne: true },
      notInterested: { $ne: true },
    };
    if (skipNotEligible) {
      jobFilter.notEligible = { $ne: true };
    }

    const [jobs, trackerRows, resumeRows] = await Promise.all([
      Job.find(
        jobFilter,
        {
          _id: 0,
          jobId: 1,
          jobrightId: 1,
          jobrightAliases: 1,
          title: 1,
          company: 1,
          applyLink: 1,
          autoApplied: 1,
          autoAppliedAt: 1,
          manualApplied: 1,
          manualAppliedAt: 1,
          postedAt: 1,
          fetchedAt: 1,
          categoryPriority: 1,
          category: 1,
        }
      )
        .sort({ categoryPriority: 1, postedAt: -1 })
        .lean(),
      AutoApplyJob.find(
        {
          appliedEmail: {
            $regex: `^${escapeRegex(email)}$`,
            $options: "i",
          },
        },
        { _id: 0, jobUrl: 1, status: 1 }
      ).lean(),
      ResumeDashboardItem.find(
        { email: resumeEmail, mode: "autoApply" },
        { _id: 0, jobUrlLower: 1 }
      ).lean(),
    ]);

    const getCategoryPriority = (j: { categoryPriority?: number }) =>
      typeof j.categoryPriority === "number" && Number.isFinite(j.categoryPriority)
        ? j.categoryPriority
        : 15;

    const getJobTimestamp = (j: { postedAt?: Date | string; fetchedAt?: Date | string }) => {
      const d = j.postedAt || j.fetchedAt;
      if (!d) return 0;
      const t = new Date(d).getTime();
      return Number.isFinite(t) ? t : 0;
    };

    jobs.sort((a, b) => {
      const pA = getCategoryPriority(a);
      const pB = getCategoryPriority(b);
      if (pA !== pB) return pA - pB;
      return getJobTimestamp(b) - getJobTimestamp(a);
    });

    const resumeSet = new Set<string>();
    for (const row of resumeRows) {
      const canonical = normalizeComparableUrl(String(row.jobUrlLower || ""));
      if (canonical) resumeSet.add(canonical);
    }

    const trackerByCanonical = new Map<string, string>();
    for (const row of trackerRows) {
      const canonical = normalizeComparableUrl(String(row.jobUrl || ""));
      if (!canonical) continue;
      const status = String(row.status || "").trim().toLowerCase();
      const prev = trackerByCanonical.get(canonical);
      if (!prev || statusPriority(status) > statusPriority(prev)) {
        trackerByCanonical.set(canonical, status);
      }
    }

    let totalCandidates = 0;
    let skippedByAts = 0;
    let skippedByResume = 0;
    let skippedByTracker = 0;
    let skippedByRetryDate = 0;
    let skippedByExclude = 0;
    let claimedJob:
      | {
          jobId: string;
          jobrightJobId: string | null;
          title: string;
          company: string;
          url: string;
          atsId: string;
        }
      | null = null;

    for (const job of jobs) {
      const jobUrl = pickJobUrl(job);
      if (!jobUrl) continue;

      const atsId = detectATS(jobUrl)?.id || "unknown";
      if (!isAtsMatch(atsId, atsFilter)) {
        skippedByAts++;
        continue;
      }

      const canonical = normalizeComparableUrl(jobUrl);
      if (!canonical) continue;
      if (excludeSet.has(canonical)) {
        skippedByExclude++;
        continue;
      }

      totalCandidates++;

      if (!defaultResume && !resumeSet.has(canonical)) {
        skippedByResume++;
        continue;
      }

      const jobDateRaw = job.postedAt || (job as unknown as { fetchedAt?: Date | string }).fetchedAt;
      const jobDate = jobDateRaw ? new Date(jobDateRaw as string | number | Date) : null;

      const trackerStatus = trackerByCanonical.get(canonical) || "";
      if (trackerStatus && isTerminalStatus(trackerStatus, retry, jobDate, retryAfterDate)) {
        if (
          trackerStatus === "failed" &&
          retry &&
          retryAfterDate &&
          (!jobDate || jobDate.getTime() < retryAfterDate.getTime())
        ) {
          skippedByRetryDate++;
        }
        skippedByTracker++;
        continue;
      }

      if (!claimedJob) {
        claimedJob = {
          jobId: String(job.jobId || "").trim(),
          jobrightJobId: getJobrightApplyId(job),
          title: String(job.title || "").trim(),
          company: String(job.company || "").trim(),
          url: jobUrl,
          atsId,
        };
      }
    }

    const availableJobs = totalCandidates - skippedByResume - skippedByTracker;
    const stats = {
      totalCandidates,
      availableJobs,
      skippedByAts,
      skippedByResume,
      skippedByTracker,
      skippedByRetryDate,
      skippedByExclude,
      attemptedThisRun: excludeSet.size,
      skipNotEligible,
      defaultResume,
      retryAfter: retryAfterDate ? retryAfterDate.toISOString() : null,
    };

    if (claimedJob) {
      return NextResponse.json({
        success: true,
        claimed: true,
        job: claimedJob,
        stats,
      });
    }

    return NextResponse.json({
      success: true,
      claimed: false,
      reason: "no_eligible_available_job",
      stats,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
