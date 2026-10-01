import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import ResumeFailure from "@/models/ResumeFailure";
import AutoApplyJob from "@/models/AutoApplyJob";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { jobUrl?: string; id?: string };
    const jobUrl = body.jobUrl ? body.jobUrl.trim() : "";

    if (!jobUrl && !body.id) {
      return NextResponse.json({ success: false, error: "jobUrl or id required" }, { status: 400 });
    }

    await dbConnect();

    // Release any claims or tracker locks so pregen daemon can claim it again
    if (jobUrl) {
      const canonical = jobUrl.toLowerCase();
      await ResumeFailure.deleteMany({ jobUrlLower: canonical });
      await AutoApplyJob.deleteMany({ jobUrl });
    } else if (body.id) {
      const failItem = await ResumeFailure.findByIdAndDelete(body.id);
      if (failItem?.jobUrl) {
        await AutoApplyJob.deleteMany({ jobUrl: failItem.jobUrl });
      }
    }

    return NextResponse.json({ success: true, message: "Job reset for resume generation retry" });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
