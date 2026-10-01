import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import ResumeDashboardItem from "@/models/ResumeDashboardItem";
import ResumeFailure from "@/models/ResumeFailure";
import AutoApplyJob from "@/models/AutoApplyJob";
import Job from "@/models/Job";
import { detectATS } from "@/lib/ats-map";

export const runtime = "nodejs";

export type ResumeAnalyticsFailedJob = {
  id: string;
  jobUrl: string;
  title: string;
  company: string;
  ats: string;
  email: string;
  errorReason: string;
  errorDetails: string;
  failedAt: string;
  source: "resume_failure" | "auto_apply_skipped" | "auto_apply_failed";
};

export async function GET(request: NextRequest) {
  try {
    await dbConnect();
    const { searchParams } = request.nextUrl;

    const emailFilter = (searchParams.get("email") || "").trim().toLowerCase();
    const searchFilter = (searchParams.get("search") || "").trim().toLowerCase();
    const atsFilter = (searchParams.get("ats") || "").trim().toLowerCase();
    const reasonFilter = (searchParams.get("reason") || "").trim().toLowerCase();

    // 1. Fetch successfully saved resumes from ResumeDashboardItem
    const resumeQuery: Record<string, unknown> = {};
    if (emailFilter) {
      resumeQuery.email = { $regex: `^${emailFilter}$`, $options: "i" };
    }

    const savedResumes = await ResumeDashboardItem.find(resumeQuery).lean();
    const savedJobUrlsLower = new Set<string>();
    for (const item of savedResumes) {
      const canonical = String(item.jobUrlLower || item.jobUrl || "").trim().toLowerCase();
      if (canonical) savedJobUrlsLower.add(canonical);
    }
    const savedInDriveCount = savedResumes.length;

    // 2. Fetch explicit ResumeFailure records
    const failureQuery: Record<string, unknown> = {};
    if (emailFilter) {
      failureQuery.email = { $regex: `^${emailFilter}$`, $options: "i" };
    }
    const explicitFailures = await ResumeFailure.find(failureQuery).sort({ failedAt: -1 }).lean();

    // 3. Fetch AutoApplyJob records (skipped/failed jobs without a generated resume)
    const trackerQuery: Record<string, unknown> = {
      $or: [
        { status: "skipped" },
        { lastError: { $regex: "page_not_found|dead_link|404|compile|drive", $options: "i" } },
      ],
    };
    if (emailFilter) {
      trackerQuery.appliedEmail = { $regex: `^${emailFilter}$`, $options: "i" };
    }
    const trackerFailures = await AutoApplyJob.find(trackerQuery).sort({ updatedAt: -1 }).lean();

    // Map all failed jobs (deduped by jobUrlLower)
    const failedJobsMap = new Map<string, ResumeAnalyticsFailedJob>();

    // Helper to format failure reason into readable label
    const formatReason = (raw: string): string => {
      const text = String(raw || "").trim();
      if (!text) return "Unknown Error";
      if (text.includes("workday_page_not_found")) return "Workday Page Not Found (404/Expired)";
      if (text.includes("greenhouse_page_not_found")) return "Greenhouse Page Not Found (404/Expired)";
      if (text.includes("dead_link")) return "Dead Link / Page 404";
      if (text.includes("latex_compile_failed") || text.includes("pdflatex")) return "LaTeX Compile Failed";
      if (text.includes("drive")) return "Google Drive Upload Failed";
      if (text.includes("timeout")) return "Timeout Exceeded";
      if (text.includes("503")) return "Service Unavailable (503)";
      if (text.length > 80) return text.slice(0, 77) + "...";
      return text;
    };

    // Process explicit ResumeFailure collection items
    for (const item of explicitFailures) {
      const canonical = String(item.jobUrlLower || item.jobUrl || "").trim().toLowerCase();
      if (!canonical || savedJobUrlsLower.has(canonical)) continue;

      failedJobsMap.set(canonical, {
        id: String(item._id),
        jobUrl: item.jobUrl,
        title: item.title || "Job Title Unavailable",
        company: item.company || "Company Unavailable",
        ats: item.ats || detectATS(item.jobUrl)?.id || "unknown",
        email: item.email || "",
        errorReason: formatReason(item.errorReason),
        errorDetails: item.errorDetails || item.errorReason,
        failedAt: (item.failedAt || new Date()).toISOString(),
        source: "resume_failure",
      });
    }

    // Process AutoApplyJob skipped/failed items that have no resume in Drive
    for (const item of trackerFailures) {
      const canonical = String(item.jobUrl || "").trim().toLowerCase();
      if (!canonical || savedJobUrlsLower.has(canonical) || failedJobsMap.has(canonical)) continue;

      failedJobsMap.set(canonical, {
        id: String(item._id),
        jobUrl: item.jobUrl,
        title: item.title || "Job Title Unavailable",
        company: item.company || "Company Unavailable",
        ats: item.atsId || detectATS(item.jobUrl)?.id || "unknown",
        email: item.appliedEmail || "",
        errorReason: formatReason(item.lastError),
        errorDetails: item.lastError || "Job posting inactive or dead link",
        failedAt: (item.lastTriedAt || item.updatedAt || item.createdAt || new Date()).toISOString(),
        source: item.status === "skipped" ? "auto_apply_skipped" : "auto_apply_failed",
      });
    }

    // Missing titles/companies enrichment from Job collection if available
    const missingDetailsUrls = Array.from(failedJobsMap.values())
      .filter((j) => !j.title || j.title === "Job Title Unavailable" || !j.company || j.company === "Company Unavailable")
      .map((j) => j.jobUrl);

    if (missingDetailsUrls.length > 0) {
      const jobsDb = await Job.find({ applyLink: { $in: missingDetailsUrls } }, { applyLink: 1, title: 1, company: 1 }).lean();
      const jobDbMap = new Map(jobsDb.map((j) => [String(j.applyLink || "").toLowerCase().trim(), j]));
      for (const [canonical, failedJob] of failedJobsMap.entries()) {
        if (jobDbMap.has(canonical)) {
          const dbJob = jobDbMap.get(canonical)!;
          if (dbJob.title) failedJob.title = dbJob.title;
          if (dbJob.company) failedJob.company = dbJob.company;
        }
      }
    }

    const allFailedJobsList = Array.from(failedJobsMap.values()).sort(
      (a, b) => new Date(b.failedAt).getTime() - new Date(a.failedAt).getTime()
    );

    const failedCount = allFailedJobsList.length;
    const totalProcessed = savedInDriveCount + failedCount;
    const successRate = totalProcessed > 0 ? Number(((savedInDriveCount / totalProcessed) * 100).toFixed(1)) : 0;

    // Reason & ATS breakdown metrics
    const reasonBreakdownMap: Record<string, number> = {};
    const atsBreakdownMap: Record<string, number> = {};

    for (const item of allFailedJobsList) {
      reasonBreakdownMap[item.errorReason] = (reasonBreakdownMap[item.errorReason] || 0) + 1;
      atsBreakdownMap[item.ats] = (atsBreakdownMap[item.ats] || 0) + 1;
    }

    // Filter failed jobs list based on client query params
    let filteredFailedJobs = allFailedJobsList;

    if (searchFilter) {
      filteredFailedJobs = filteredFailedJobs.filter(
        (j) =>
          j.title.toLowerCase().includes(searchFilter) ||
          j.company.toLowerCase().includes(searchFilter) ||
          j.jobUrl.toLowerCase().includes(searchFilter)
      );
    }

    if (atsFilter && atsFilter !== "all") {
      filteredFailedJobs = filteredFailedJobs.filter((j) => j.ats.toLowerCase() === atsFilter);
    }

    if (reasonFilter && reasonFilter !== "all") {
      filteredFailedJobs = filteredFailedJobs.filter(
        (j) => j.errorReason.toLowerCase().includes(reasonFilter) || j.errorDetails.toLowerCase().includes(reasonFilter)
      );
    }

    return NextResponse.json({
      success: true,
      stats: {
        totalProcessed,
        savedInDriveCount,
        failedCount,
        successRate,
        reasonBreakdown: reasonBreakdownMap,
        atsBreakdown: atsBreakdownMap,
      },
      failedJobs: filteredFailedJobs,
    });
  } catch (error) {
    console.error("GET /api/resume-analytics error:", error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
