import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import AutoApplyJob from "@/models/AutoApplyJob";
import Job from "@/models/Job";
import { runAutoApplyJob } from "@/lib/runAutoApply";
import { saveAutoApplyTracking } from "@/lib/autoApplyTracking";
import { getJobrightApplyId } from "@/lib/jobrightApply";

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;

    const row = await AutoApplyJob.findById(id).lean();
    if (!row) {
      return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
    }

    const jobDoc = await Job.findOne(
      {
        applyLink: {
          $regex: `^${escapeRegex(String(row.jobUrl || "").trim())}$`,
          $options: "i",
        },
      },
      { jobId: 1, jobrightId: 1, jobrightAliases: 1 }
    ).lean();
    const defaultResume = String(row.resumePreviewLink || "").includes("folder=defaultResume");

    const run = await runAutoApplyJob({
      jobId: row.jobId || `retry-${Date.now()}`,
      jobrightJobId: jobDoc ? getJobrightApplyId(jobDoc) : "",
      url: row.jobUrl,
      defaultResume,
    });

    const reqUrl = new URL(request.url);
    const saved = run.trackingSaved
      ? null
      : await saveAutoApplyTracking({
          origin: reqUrl.origin,
          jobId: row.jobId,
          jobUrl: row.jobUrl,
          atsId: run.atsId || row.atsId,
          success: run.success,
          error: run.error,
          defaultResume,
        });

    return NextResponse.json({
      success: run.success,
      error: run.error || "",
      ats: run.atsId || row.atsId,
      row: saved,
      trackingSaved: run.trackingSaved,
    }, { status: run.success ? 200 : 500 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
