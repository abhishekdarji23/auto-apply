import dbConnect from "@/lib/mongodb";
import AutoApplyJob from "@/models/AutoApplyJob";
import Job from "@/models/Job";
import ResumeDashboardItem from "@/models/ResumeDashboardItem";

// ── ATS detection ─────────────────────────────────────────────────────────────

const ATS_PATTERNS: Array<{ pattern: RegExp; atsId: string }> = [
  { pattern: /myworkdayjobs\.com/i, atsId: "workday" },
  { pattern: /myworkdaysite\.com/i, atsId: "workday" },
  { pattern: /boards\.greenhouse\.io/i, atsId: "greenhouse" },
  { pattern: /job-boards\.greenhouse\.io/i, atsId: "greenhouse" },
  { pattern: /lever\.co/i, atsId: "lever" },
  { pattern: /ashbyhq\.com/i, atsId: "ashby" },
  { pattern: /smartrecruiters\.com/i, atsId: "smartrecruiters" },
  { pattern: /icims\.com/i, atsId: "icims" },
  { pattern: /taleo\.net/i, atsId: "taleo" },
];

export function detectAts(jobUrl: string): string {
  try {
    const { hostname } = new URL(jobUrl);
    for (const { pattern, atsId } of ATS_PATTERNS) {
      if (pattern.test(hostname)) return atsId;
    }
  } catch {
    // ignore invalid URLs
  }
  return "unknown";
}

/**
 * Normalise an email address to the same form used for Drive folder names:
 * lowercase + replace any char outside [a-z0-9@._-] with underscore.
 * Mirrors `normalizeEmailFolderName` in googleDriveResume.ts.
 */
export function normalizeEmail(email: string): string {
  const value = String(email || "")
    .trim()
    .toLowerCase();
  if (!value) return "unknown-email";
  return value.replace(/[^a-z0-9@._-]/g, "_");
}

export function normalizeJobUrl(jobUrl: string): string {
  return jobUrl.trim().toLowerCase();
}

// ── Upsert ────────────────────────────────────────────────────────────────────

export interface UpsertResumeDashboardItemInput {
  mode: string;
  /** Raw email extracted from LaTeX — will be normalised before storing. */
  email: string;
  folder: string;
  jobUrl: string;
  pdfFile: string;
  /** ISO string produced when generating the resume. */
  createdAt: string;
  // Optional pre-enriched values — if absent, helper queries AutoApplyJob/Job
  title?: string;
  company?: string;
  postedAt?: string;
}

export async function upsertResumeDashboardItem(
  input: UpsertResumeDashboardItemInput
): Promise<void> {
  await dbConnect();

  const email = normalizeEmail(input.email);
  const jobUrlLower = normalizeJobUrl(input.jobUrl);
  const ats = detectAts(input.jobUrl);

  let title = input.title ?? "";
  let company = input.company ?? "";
  let postedAt = input.postedAt ?? "";

  // Enrich from DB if any field is missing
  if (!title || !company || !postedAt) {
    // Both original and lower-case variants to handle URL casing discrepancies
    const urlVariants = [...new Set([input.jobUrl, jobUrlLower])];

    if (!title || !company) {
      const trackerDoc = await AutoApplyJob.findOne(
        { jobUrl: { $in: urlVariants } },
        { title: 1, company: 1 }
      ).lean();
      if (trackerDoc) {
        if (!title) title = (trackerDoc.title as string) || "";
        if (!company) company = (trackerDoc.company as string) || "";
      }
    }

    if (!title || !company || !postedAt) {
      const jobDoc = await Job.findOne(
        { applyLink: { $in: urlVariants } },
        { title: 1, company: 1, postedAt: 1 }
      ).lean();
      if (jobDoc) {
        if (!title) title = (jobDoc.title as string) || "";
        if (!company) company = (jobDoc.company as string) || "";
        if (!postedAt && jobDoc.postedAt) {
          postedAt = new Date(jobDoc.postedAt as Date).toISOString();
        }
      }
    }
  }

  await ResumeDashboardItem.findOneAndUpdate(
    { mode: input.mode, email, folder: input.folder },
    {
      $set: {
        mode: input.mode,
        email,
        folder: input.folder,
        jobUrl: input.jobUrl,
        jobUrlLower,
        ats,
        title,
        company,
        pdfFile: input.pdfFile,
        createdAt: input.createdAt ? new Date(input.createdAt) : new Date(),
        postedAt,
      },
    },
    { upsert: true }
  );
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteResumeDashboardItem(params: {
  mode: string;
  email: string;
  folder: string;
}): Promise<void> {
  await dbConnect();
  await ResumeDashboardItem.deleteOne({
    mode: params.mode,
    email: normalizeEmail(params.email),
    folder: params.folder,
  });
}
