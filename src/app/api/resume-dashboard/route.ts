import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import AutoApplyJob from "@/models/AutoApplyJob";
import ResumeDashboardItem from "@/models/ResumeDashboardItem";
import { deleteDriveJobFolder } from "@/lib/googleDriveResume";
import { deleteResumeDashboardItem } from "@/lib/resumeDashboardIndex";

export const runtime = "nodejs";

const MODES = ["autoApply", "manualApply"] as const;

function isSafeName(name: string): boolean {
  return !!name && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

export type ResumeEntry = {
  mode: string;
  email: string;
  folder: string;
  jobUrl: string;
  ats: string;
  title: string;
  company: string;
  pdfFile: string;
  createdAt: string;
  postedAt: string;
};

export async function GET() {
  try {
    await dbConnect();

    // ── Step 1: Load all indexed resume entries from Mongo ───────────────────
    const allItems = await ResumeDashboardItem.find(
      {},
      {
        mode: 1,
        email: 1,
        folder: 1,
        jobUrl: 1,
        jobUrlLower: 1,
        ats: 1,
        title: 1,
        company: 1,
        pdfFile: 1,
        createdAt: 1,
        postedAt: 1,
      }
    ).lean();

    if (allItems.length === 0) {
      return NextResponse.json({ success: true, resumes: [] });
    }

    // ── Step 2: Find applied entries (status success/applied) ────────────────
    // Include both original-case and lowercase URL variants to handle any
    // casing differences between what was stored in AutoApplyJob vs the index.
    const origUrls = allItems.map((i) => i.jobUrl);
    const lowerUrls = allItems.map((i) => i.jobUrlLower);
    const urlVariants = [...new Set([...origUrls, ...lowerUrls])];

    const appliedDocs = await AutoApplyJob.find(
      { jobUrl: { $in: urlVariants }, status: { $in: ["success", "applied"] } },
      { jobUrl: 1, appliedEmail: 1 }
    ).lean();

    const appliedSet = new Set<string>();
    for (const d of appliedDocs) {
      appliedSet.add(
        `${(d.jobUrl || "").toLowerCase()}|||${(d.appliedEmail || "").toLowerCase()}`
      );
    }

    // ── Step 3: Filter out applied ───────────────────────────────────────────
    const pending = allItems.filter(
      (item) =>
        !appliedSet.has(`${item.jobUrlLower}|||${item.email.toLowerCase()}`)
    );

    if (pending.length === 0) {
      return NextResponse.json({ success: true, resumes: [] });
    }

    // ── Step 4: Sort newest first and return ─────────────────────────────────
    pending.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });

    const results: ResumeEntry[] = pending.map((item) => ({
      mode: item.mode,
      email: item.email,
      folder: item.folder,
      jobUrl: item.jobUrl,
      ats: item.ats,
      title: item.title,
      company: item.company,
      pdfFile: item.pdfFile,
      createdAt:
        item.createdAt instanceof Date
          ? item.createdAt.toISOString()
          : String(item.createdAt || ""),
      postedAt: item.postedAt || "",
    }));

    return NextResponse.json({ success: true, resumes: results });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json()) as { email?: string; mode?: string; folder?: string };
    const { email = "", mode = "", folder = "" } = body;

    if (!isSafeName(email) || !isSafeName(folder) || !MODES.includes(mode as (typeof MODES)[number])) {
      return NextResponse.json({ success: false, error: "invalid_params" }, { status: 400 });
    }

    await Promise.all([
      deleteDriveJobFolder({ mode, email, folderName: folder }),
      deleteResumeDashboardItem({ mode, email, folder }),
    ]);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
