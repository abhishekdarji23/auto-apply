import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Job from "@/models/Job";
import AutoApplyJob from "@/models/AutoApplyJob";
import ResumeDashboardItem from "@/models/ResumeDashboardItem";
import { detectATS } from "@/lib/ats-map";
import { getJobrightApplyId } from "@/lib/jobrightApply";

export const runtime = "nodejs";

type ResumeClaimBody = {
  email?: string;
  ats?: "all" | "workday" | "greenhouse";
  notEligible?: boolean | string;
  excludeUrls?: string[];
  releaseUrl?: string;
  resetAll?: boolean;
  sinceDate?: string;
  dateFilter?: string;
  since?: string;
  after?: string;
  retryAfter?: string;
  minDate?: string;
};

const SUPPORTED_ATS = new Set(["workday", "greenhouse"]);
const activeResumeClaims = new Map<string, number>(); // canonicalUrl -> expiresAtMs (10 min lease)

function parseMinDate(body: ResumeClaimBody): Date | null {
  const raw = body.sinceDate || body.dateFilter || body.since || body.after || body.retryAfter || body.minDate;
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (isNaN(parsed.getTime())) return null;
  return parsed;
}

function cleanExpiredClaims() {
  const now = Date.now();
  for (const [url, exp] of activeResumeClaims.entries()) {
    if (exp <= now) {
      activeResumeClaims.delete(url);
    }
  }
}

function normalizeComparableUrl(rawUrl: string): string {
  const value = String(rawUrl || "").trim();
  if (!value) return "";

  try {
    const url = new URL(value);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");

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
    return value.toLowerCase().replace(/\/+$/, "");
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
  if (filter === "all") return SUPPORTED_ATS.has(atsId);
  return atsId === filter;
}

function shouldSkipNotEligible(value: unknown): boolean {
  if (value === false) return false;
  if (typeof value === "string" && value.trim().toLowerCase() === "false") return false;
  return true;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as ResumeClaimBody;

    // Handle resetAll request to clear all active claims immediately
    if (body.resetAll) {
      const resetCount = activeResumeClaims.size;
      activeResumeClaims.clear();
      return NextResponse.json({ success: true, resetAll: true, resetCount });
    }

    // Handle release request if worker finished or cancelled
    if (body.releaseUrl) {
      const canonical = normalizeComparableUrl(body.releaseUrl);
      if (canonical) activeResumeClaims.delete(canonical);
      return NextResponse.json({ success: true, released: true });
    }

    const minDate = parseMinDate(body);
    const rawEmail = String(body.email || "");
    const email = normalizeClaimEmail(rawEmail);
    const resumeEmail = normalizeResumeEmail(rawEmail);
    const atsFilter = (String(body.ats || "all").trim().toLowerCase() || "all") as
      | "all"
      | "workday"
      | "greenhouse";
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

    cleanExpiredClaims();
    await dbConnect();

    const jobFilter: Record<string, unknown> = {
      inactive: { $ne: true },
      applied: { $ne: true },
      manualApplied: { $ne: true },
      notInterested: { $ne: true },
    };
    if (skipNotEligible) {
      jobFilter.notEligible = { $ne: true };
    }

    if (atsFilter === "workday") {
      jobFilter.applyLink = { $regex: /myworkdayjobs\.com|myworkdaysite\.com/i };
    } else if (atsFilter === "greenhouse") {
      jobFilter.applyLink = { $regex: /greenhouse\.io/i };
    } else {
      jobFilter.applyLink = { $regex: /myworkdayjobs\.com|myworkdaysite\.com|greenhouse\.io/i };
    }

    const [trackerRows, resumeRows] = await Promise.all([
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
        {
          $or: [
            { email: { $regex: `^${escapeRegex(email)}$`, $options: "i" } },
            { email: { $regex: `^${escapeRegex(resumeEmail)}$`, $options: "i" } },
          ],
        },
        { _id: 0, jobUrlLower: 1, jobUrl: 1 }
      ).lean(),
    ]);

    const resumeSet = new Set<string>();
    for (const row of resumeRows) {
      const canonical = normalizeComparableUrl(String(row.jobUrlLower || row.jobUrl || ""));
      if (canonical) resumeSet.add(canonical);
    }

    const terminalTrackerUrls = new Set<string>();
    for (const row of trackerRows) {
      const canonical = normalizeComparableUrl(String(row.jobUrl || ""));
      if (!canonical) continue;
      const status = String(row.status || "").trim().toLowerCase();
      if (status === "success" || status === "applied" || status === "skipped") {
        terminalTrackerUrls.add(canonical);
      }
    }

    const jobs = await Job.find(
      jobFilter,
      {
        _id: 0,
        jobId: 1,
        jobrightId: 1,
        jobrightAliases: 1,
        title: 1,
        company: 1,
        applyLink: 1,
        qualifications: 1,
        roleType: 1,
        jobFunction: 1,
        industry: 1,
        postedAt: 1,
        fetchedAt: 1,
        categoryPriority: 1,
        category: 1,
      }
    ).lean();

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

    let claimedJob: {
      jobId: string;
      jobrightJobId: string | null;
      title: string;
      company: string;
      url: string;
      postedAt: Date | null;
      qualifications: string;
      roleType: string;
      jobFunction: string;
      industry: string[];
      atsId: string;
    } | null = null;

    let scannedCandidates = 0;

    for (const job of jobs) {
      const jobUrl = pickJobUrl(job);
      if (!jobUrl) continue;

      const atsId = detectATS(jobUrl)?.id || "unknown";
      if (!isAtsMatch(atsId, atsFilter)) continue;

      const canonical = normalizeComparableUrl(jobUrl);
      if (!canonical) continue;

      scannedCandidates++;

      if (terminalTrackerUrls.has(canonical)) continue;
      if (resumeSet.has(canonical)) continue;
      if (excludeSet.has(canonical) || activeResumeClaims.has(canonical)) continue;

      const jobDateRaw = job.postedAt || job.fetchedAt;
      const jobDate = jobDateRaw ? new Date(jobDateRaw as string | number | Date) : null;
      if (minDate && (!jobDate || jobDate.getTime() < minDate.getTime())) {
        continue;
      }

      claimedJob = {
        jobId: String(job.jobId || "").trim(),
        jobrightJobId: getJobrightApplyId(job),
        title: String(job.title || "").trim(),
        company: String(job.company || "").trim(),
        url: jobUrl,
        postedAt: (job.postedAt || job.fetchedAt) ? new Date((job.postedAt || job.fetchedAt) as unknown as string) : null,
        qualifications: String(job.qualifications || "").trim(),
        roleType: String(job.roleType || "").trim(),
        jobFunction: String(job.jobFunction || "").trim(),
        industry: Array.isArray(job.industry) ? job.industry : [],
        atsId,
      };

      // Lease for 3 minutes (auto-expires if process is interrupted)
      activeResumeClaims.set(canonical, Date.now() + 3 * 60 * 1000);
      break;
    }

    const stats = {
      alreadyHaveResume: resumeSet.size,
      alreadyAppliedOrSkipped: terminalTrackerUrls.size,
      activeLeasesCount: activeResumeClaims.size,
      scannedCandidates,
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
      reason: "no_pending_jobs",
      stats,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
