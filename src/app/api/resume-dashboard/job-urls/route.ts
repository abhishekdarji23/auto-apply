import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import ResumeDashboardItem from "@/models/ResumeDashboardItem";
import { normalizeEmail } from "@/lib/resumeDashboardIndex";

export const runtime = "nodejs";

/**
 * GET /api/resume-dashboard/job-urls?email=foo@bar.com
 *
 * Returns the set of lowercase job URLs that already have a generated resume
 * indexed in the dashboard for the given email. Used by pregen and bulk-apply
 * scripts to skip jobs that already have a resume, without scanning local disk.
 *
 * Response: { jobUrlLowers: string[] }
 */
export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get("email") || "";
  if (!email) {
    return NextResponse.json({ error: "email query param required" }, { status: 400 });
  }

  await dbConnect();

  const docs = await ResumeDashboardItem.find(
    { email: normalizeEmail(email) },
    { jobUrlLower: 1 }
  ).lean();

  const jobUrlLowers = docs.map((d) => d.jobUrlLower as string).filter(Boolean);
  return NextResponse.json({ jobUrlLowers });
}
