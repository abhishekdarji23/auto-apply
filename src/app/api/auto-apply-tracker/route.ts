import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import AutoApplyJob from "@/models/AutoApplyJob";
import Job from "@/models/Job";
import ResumeDashboardItem from "@/models/ResumeDashboardItem";
import { AUTO_APPLY_STATUSES, type AutoApplyStatus } from "@/models/AutoApplyJob";

type ResumeDashboardLeanItem = {
  email?: string;
  folder?: string;
  jobUrl?: string;
  jobUrlLower?: string;
};

function normalizeEmail(raw: string): string {
  return String(raw || "").trim().toLowerCase();
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

export async function GET() {
  try {
    await dbConnect();
    const rows = await AutoApplyJob.find({}).sort({ updatedAt: -1 }).lean();

    // Enrich with postedAt from Job collection (case-insensitive URL match)
    const jobUrls = [...new Set(rows.map((r) => String(r.jobUrl || "").trim()).filter(Boolean))];

    const postedAtMap = new Map<string, string>();

    if (jobUrls.length > 0) {
      // 1. Exact match first (fast path)
      const exactDocs = await Job.find(
        { applyLink: { $in: jobUrls } },
        { applyLink: 1, postedAt: 1 }
      ).lean();
      for (const doc of exactDocs) {
        const pa = doc.postedAt ? new Date(doc.postedAt).toISOString() : "";
        if (!pa) continue;
        const key = String(doc.applyLink || "").trim().toLowerCase();
        if (key && !postedAtMap.has(key)) postedAtMap.set(key, pa);
      }

      // 2. Case-insensitive fallback for any still missing
      const stillMissing = jobUrls.filter((u) => !postedAtMap.has(u.toLowerCase()));
      if (stillMissing.length > 0) {
        const ciDocs = await Job.find(
          {
            applyLink: { $in: stillMissing.map((u) => new RegExp(`^${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")) },
          },
          { applyLink: 1, postedAt: 1 }
        ).lean();
        for (const doc of ciDocs) {
          const pa = doc.postedAt ? new Date(doc.postedAt).toISOString() : "";
          if (!pa) continue;
          const key = String(doc.applyLink || "").trim().toLowerCase();
          if (key && !postedAtMap.has(key)) postedAtMap.set(key, pa);
        }
      }
    }

    const origin = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const missingPreviewRows = rows.filter((r) => !String(r.resumePreviewLink || "").trim());

    if (missingPreviewRows.length > 0) {
      const emails = [...new Set(missingPreviewRows
        .map((r) => normalizeEmail(String(r.appliedEmail || "")))
        .filter(Boolean))];

      if (emails.length > 0) {
        const dashboardItems = await ResumeDashboardItem.find(
          {
            mode: "autoApply",
            email: { $in: emails },
          },
          { email: 1, folder: 1, jobUrl: 1, jobUrlLower: 1, createdAt: 1 }
        )
          .sort({ createdAt: -1 })
          .lean();

        const byEmail = new Map<string, Array<ResumeDashboardLeanItem>>();
        for (const item of dashboardItems as Array<ResumeDashboardLeanItem>) {
          const key = normalizeEmail(String(item.email || ""));
          if (!key) continue;
          const bucket = byEmail.get(key) || [];
          bucket.push(item);
          byEmail.set(key, bucket);
        }

        const updates: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];
        for (const row of missingPreviewRows) {
          const email = normalizeEmail(String(row.appliedEmail || ""));
          if (!email) continue;

          const candidates = byEmail.get(email) || [];
          if (candidates.length === 0) continue;

          const rowJobUrl = String(row.jobUrl || "").trim();
          const rowJobLower = rowJobUrl.toLowerCase();
          const rowCanonical = normalizeComparableUrl(rowJobUrl);

          let match = candidates.find((item) => String(item.jobUrlLower || "") === rowJobLower);
          if (!match && rowCanonical) {
            match = candidates.find((item) => normalizeComparableUrl(String(item.jobUrl || "")) === rowCanonical);
          }
          if (!match) continue;

          const folder = String(match.folder || "").trim();
          const matchEmail = normalizeEmail(String(match.email || email));
          if (!folder || !matchEmail) continue;

          const preview = buildResumeDashboardPreviewUrl(origin, matchEmail, folder);
          row.resumePreviewLink = preview;

          updates.push({
            updateOne: {
              filter: {
                _id: row._id,
                $or: [
                  { resumePreviewLink: { $exists: false } },
                  { resumePreviewLink: null },
                  { resumePreviewLink: "" },
                ],
              },
              update: { $set: { resumePreviewLink: preview } },
            },
          });
        }

        if (updates.length > 0) {
          await AutoApplyJob.bulkWrite(updates, { ordered: false });
        }
      }
    }

    const enriched = rows.map((r) => ({
      ...r,
      postedAt: postedAtMap.get(String(r.jobUrl || "").trim().toLowerCase()) ?? null,
    }));

    // Calculate Resume Ready stats for failed, skipped, and pending jobs
    const totalPreGeneratedResumes = await ResumeDashboardItem.countDocuments({ mode: "autoApply" });

    let resumeReadyFailed = 0;
    let resumeReadySkipped = 0;
    let resumeReadyRunning = 0;
    let resumeReadySuccess = 0;

    for (const r of enriched) {
      const hasResume = Boolean(String(r.resumePreviewLink || "").trim());
      if (hasResume) {
        if (r.status === "failed") resumeReadyFailed++;
        else if (r.status === "skipped") resumeReadySkipped++;
        else if (r.status === "running") resumeReadyRunning++;
        else if (r.status === "success" || r.status === "applied") resumeReadySuccess++;
      }
    }

    const resumeStats = {
      totalPreGenerated: totalPreGeneratedResumes,
      resumeReadyFailed,
      resumeReadySkipped,
      resumeReadyRunning,
      resumeReadySuccess,
      pendingWithResume: resumeReadyFailed + resumeReadySkipped,
    };

    return NextResponse.json({ success: true, rows: enriched, resumeStats });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await dbConnect();
    const body = await request.json() as {
      jobUrl?: string;
      title?: string;
      company?: string;
      appliedEmail?: string;
      resumePreviewLink?: string;
      status?: AutoApplyStatus;
      lastError?: string;
    };

    const jobUrl = String(body.jobUrl || "").trim();
    if (!jobUrl) {
      return NextResponse.json({ success: false, error: "missing_job_url" }, { status: 400 });
    }

    const nextStatus = String(body.status || "running").trim() as AutoApplyStatus;
    if (!AUTO_APPLY_STATUSES.includes(nextStatus)) {
      return NextResponse.json({ success: false, error: "invalid_status" }, { status: 400 });
    }

    const now = new Date();

    // Admin-only update: patches ALL records for this jobUrl (email-agnostic)
    const result = await AutoApplyJob.updateMany(
      { jobUrl },
      {
        $set: {
          ...(body.title ? { title: body.title } : {}),
          ...(body.company ? { company: body.company } : {}),
          ...(body.resumePreviewLink ? { resumePreviewLink: body.resumePreviewLink } : {}),
          status: nextStatus,
          lastError: body.lastError || "",
          lastTriedAt: now,
          ...(nextStatus === "success" || nextStatus === "applied" ? { appliedAt: now } : {}),
        },
      }
    );

    return NextResponse.json({ success: true, updated: result.modifiedCount });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await dbConnect();
    const body = await request.json() as { ids?: string[] };
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length === 0) {
      return NextResponse.json({ success: false, error: "no ids provided" }, { status: 400 });
    }
    const result = await AutoApplyJob.deleteMany({ _id: { $in: ids } });
    return NextResponse.json({ success: true, deleted: result.deletedCount });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
