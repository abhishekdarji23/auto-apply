import dbConnect from "@/lib/mongodb";
import AutoApplyJob from "@/models/AutoApplyJob";
import Job from "@/models/Job";
import ResumeDashboardItem from "@/models/ResumeDashboardItem";
import { uploadResumeToDrive } from "@/lib/googleDriveResume";
import { resolveModeAndCurrentEmail } from "@/lib/resumeReadResolver";
import { normalizeEmail } from "@/lib/resumeDashboardIndex";
import { markJobrightApplied } from "@/lib/jobrightApply";
import { DEFAULT_RESUME_FOLDER_NAME } from "@/lib/defaultResume";

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pickResumePreview(profile: Record<string, unknown>): string {
  return (
    safeString(profile.resume_preview) ||
    safeString(profile.resume) ||
    safeString(profile.resume_download)
  );
}

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

function buildResumeDashboardPreviewUrl(origin: string, email: string, folder: string): string {
  const p = new URLSearchParams({ email, mode: "autoApply", folder });
  return `${origin}/api/resume-dashboard/file?${p.toString()}`;
}

async function findResumePreviewFromDashboard(params: {
  origin: string;
  jobUrl: string;
  appliedEmail: string;
}): Promise<string> {
  const { origin, jobUrl, appliedEmail } = params;
  if (!appliedEmail) return "";

  const normalizedEmail = normalizeEmail(appliedEmail);
  const jobUrlLower = String(jobUrl || "").trim().toLowerCase();

  // Fast exact path first.
  const exact = await ResumeDashboardItem.findOne(
    {
      mode: "autoApply",
      email: normalizedEmail,
      jobUrlLower,
    },
    { folder: 1, email: 1 }
  )
    .sort({ createdAt: -1 })
    .lean();

  if (exact?.folder && exact?.email) {
    return buildResumeDashboardPreviewUrl(origin, String(exact.email), String(exact.folder));
  }

  // Fallback for URL variants (query order/case/utm differences).
  const targetCanonical = normalizeComparableUrl(jobUrl);
  if (!targetCanonical) return "";

  const candidates = await ResumeDashboardItem.find(
    {
      mode: "autoApply",
      email: normalizedEmail,
    },
    { folder: 1, email: 1, jobUrl: 1, createdAt: 1 }
  )
    .sort({ createdAt: -1 })
    .lean();

  for (const item of candidates) {
    const canonical = normalizeComparableUrl(String(item.jobUrl || ""));
    if (canonical !== targetCanonical) continue;
    if (!item.folder || !item.email) continue;
    return buildResumeDashboardPreviewUrl(origin, String(item.email), String(item.folder));
  }

  return "";
}

export async function fetchCandidateProfileByJobUrl({
  origin,
  jobUrl,
}: {
  origin: string;
  jobUrl: string;
}): Promise<Record<string, unknown> | null> {
  try {
    const encoded = encodeURIComponent(jobUrl);
    const res = await fetch(`${origin}/candidate/me/${encoded}`, {
      method: "GET",
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function saveAutoApplyTracking(params: {
  origin: string;
  jobId?: string;
  jobUrl: string;
  atsId?: string;
  success: boolean;
  error?: string;
  defaultResume?: boolean;
}) {
  await dbConnect();

  const {
    origin,
    jobId,
    jobUrl,
    atsId,
    success,
    error,
    defaultResume = false,
  } = params;

  // Resolve title/company from Job DB by matching job URL (case-insensitive).
  const jobUrlLower = jobUrl.toLowerCase();
  const urlFilter = {
    applyLink: { $regex: `^${jobUrlLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
  };
  const jobDocByUrl = await Job.findOne(
    urlFilter,
    {
      title: 1,
      company: 1,
      category: 1,
      categoryLabel: 1,
      jobId: 1,
      jobrightId: 1,
      jobrightAliases: 1,
      sourceKind: 1,
      sourceTags: 1,
      tabCategory: 1,
    }
  ).lean();

  const resolvedTitle = safeString(jobDocByUrl?.title);
  const resolvedCompany = safeString(jobDocByUrl?.company);
  const resolvedCategory = safeString(jobDocByUrl?.category) || "others";
  const resolvedCategoryLabel = safeString(jobDocByUrl?.categoryLabel) || "Others";
  const resolvedJobId = jobDocByUrl?.jobId ? safeString(jobDocByUrl.jobId) : (jobId || "");

  const profile = await fetchCandidateProfileByJobUrl({ origin, jobUrl });
  const profileEmail = profile ? safeString(profile.email) : "";
  const sourceResumeUrl = profile ? pickResumePreview(profile) : "";

  // Verify the profile email matches the expected current email from config
  const { currentEmail: expectedEmail } = await resolveModeAndCurrentEmail(jobUrl).catch(() => ({ mode: "manualApply" as const, currentEmail: "" }));
  let appliedEmail = profileEmail;
  if (expectedEmail && profileEmail && profileEmail !== expectedEmail) {
    console.warn(`[tracking] Profile email "${profileEmail}" does not match expected "${expectedEmail}" for ${jobUrl} — using config email`);
    appliedEmail = expectedEmail;
  } else if (!profileEmail && expectedEmail) {
    appliedEmail = expectedEmail;
  }

  const existing = await AutoApplyJob.findOne({ jobUrl, appliedEmail }).lean();

  const dashboardFallbackPreview = await findResumePreviewFromDashboard({
    origin,
    jobUrl,
    appliedEmail,
  });
  const defaultResumePreview = defaultResume && appliedEmail
    ? buildResumeDashboardPreviewUrl(origin, appliedEmail, DEFAULT_RESUME_FOLDER_NAME)
    : "";

  let driveUpload: Awaited<ReturnType<typeof uploadResumeToDrive>> = {
    ok: false,
    webViewLink: "",
    webContentLink: "",
    fileId: "",
  };

  const canUploadResume = Boolean(sourceResumeUrl && appliedEmail && !defaultResume);
  if (canUploadResume) {
    driveUpload = await uploadResumeToDrive({
      email: appliedEmail,
      jobUrl,
      resumeUrl: sourceResumeUrl,
    });
  }

  const resumePreviewLink = driveUpload.ok
    ? (driveUpload.webViewLink || driveUpload.webContentLink || defaultResumePreview || sourceResumeUrl || dashboardFallbackPreview || safeString(existing?.resumePreviewLink))
    : (defaultResumePreview || sourceResumeUrl || dashboardFallbackPreview || safeString(existing?.resumePreviewLink));

  const now = new Date();
  const rawErr = safeString(error).toLowerCase();
  const isDeadJob =
    rawErr.includes("page_not_found") ||
    rawErr.includes("job_not_found") ||
    rawErr.includes("job_not_available") ||
    rawErr.includes("no longer available") ||
    rawErr.includes("can't find that page") ||
    rawErr.includes("dead_link") ||
    rawErr.includes("err_name_not_resolved") ||
    rawErr.includes("err_connection_refused") ||
    rawErr.includes("net::err_") ||
    rawErr.includes("404");

  const status = success ? "success" : isDeadJob ? "skipped" : "failed";
  const driveErrorMessage = canUploadResume && !driveUpload.ok
    ? `drive_upload_failed:${safeString(driveUpload.error)}`
    : "";
  const combinedError = [safeString(error), driveErrorMessage].filter(Boolean).join(" | ");

  const attempts = (existing?.attempts || 0) + 1;

  const saved = await AutoApplyJob.findOneAndUpdate(
    { jobUrl, appliedEmail },
    {
      $set: {
        jobId: resolvedJobId || existing?.jobId || "",
        title: resolvedTitle || existing?.title || "",
        company: resolvedCompany || existing?.company || "",
        category: resolvedCategory || existing?.category || "others",
        categoryLabel: resolvedCategoryLabel || existing?.categoryLabel || "Others",
        jobUrl,
        atsId: atsId || existing?.atsId || "",
        appliedEmail,
        resumePreviewLink,
        status,
        lastError: combinedError,
        attempts,
        lastTriedAt: now,
        appliedAt: success ? now : existing?.appliedAt || null,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  if (status === "skipped" && isDeadJob) {
    await Job.updateMany(
      urlFilter,
      {
        $set: {
          inactive: true,
          notEligible: true,
          notEligibleReason: safeString(error) || "dead_job_skipped",
        },
      }
    );
  }

  if (success) {
    await Job.updateMany(
      urlFilter,
      {
        $set: {
          autoApplied: true,
          autoAppliedAt: now,
        },
      }
    );

    if (jobDocByUrl) {
      try {
        const jobrightApply = await markJobrightApplied(jobDocByUrl);
        if (jobrightApply && "ok" in jobrightApply && jobrightApply.ok === false) {
          console.warn(`[tracking] JobRight apply mark failed jobUrl=${jobUrl} status=${jobrightApply.status}`);
        }
      } catch (markError) {
        const message = markError instanceof Error ? markError.message : String(markError);
        console.warn(`[tracking] JobRight apply mark error jobUrl=${jobUrl}: ${message}`);
      }
    }
  }

  return saved;
}
