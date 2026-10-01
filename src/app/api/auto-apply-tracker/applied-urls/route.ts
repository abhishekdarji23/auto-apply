import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import AutoApplyJob from "@/models/AutoApplyJob";

export const runtime = "nodejs";

/**
 * GET /api/auto-apply-tracker/applied-urls?email=foo@bar.com
 *
 * Returns the set of lowercase job URLs where the given email has already
 * successfully applied (status "success" or "applied"). Used by the pregen
 * script to skip jobs that have already been applied so there is no point
 * in regenerating a resume for them.
 *
 * Response: { jobUrlLowers: string[] }
 */
export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get("email") || "";
  if (!email) {
    return NextResponse.json({ error: "email query param required" }, { status: 400 });
  }

  await dbConnect();

  const docs = await AutoApplyJob.find(
    {
      appliedEmail: { $regex: `^${email.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
      status: { $in: ["success", "applied"] },
    },
    { jobUrl: 1 }
  ).lean();

  const jobUrlLowers = docs
    .map((d) => String(d.jobUrl || "").trim().toLowerCase())
    .filter(Boolean);

  return NextResponse.json({ jobUrlLowers });
}
