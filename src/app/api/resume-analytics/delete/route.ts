import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import ResumeFailure from "@/models/ResumeFailure";
import AutoApplyJob from "@/models/AutoApplyJob";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { id?: string; jobUrl?: string };
    const { id, jobUrl } = body;

    if (!id && !jobUrl) {
      return NextResponse.json({ success: false, error: "id or jobUrl required" }, { status: 400 });
    }

    await dbConnect();

    let deletedFailureCount = 0;
    if (id) {
      const res = await ResumeFailure.deleteOne({ _id: id });
      deletedFailureCount += res.deletedCount || 0;
    }
    if (jobUrl) {
      const canonical = jobUrl.trim().toLowerCase();
      const res1 = await ResumeFailure.deleteMany({ jobUrlLower: canonical });
      deletedFailureCount += res1.deletedCount || 0;

      // Update AutoApplyJob status if present
      await AutoApplyJob.updateMany({ jobUrl }, { $set: { status: "skipped", lastError: "dismissed_by_user" } });
    }

    return NextResponse.json({ success: true, deletedCount: deletedFailureCount });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
