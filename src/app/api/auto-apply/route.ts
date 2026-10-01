/**
 * POST /api/auto-apply
 *
 * Body: { jobId: string, url: string, jobrightJobId?: string }
 *
 * 1. Detects the ATS from the URL (using src/lib/ats-map.ts — bundled at build time)
 * 2. Spawns scripts/ats/run-ats.mjs as a child Node process, passing job data via
 *    stdin JSON.  The child process handles Playwright outside the Next.js bundle.
 *
 * Returns:
 *   200  { success: true,  ats: string }
 *   400  { success: false, error: "missing_fields" }
 *   422  { success: false, error: "unsupported_ats", url, detected: null }
 *   500  { success: false, error: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { runAutoApplyJob } from "@/lib/runAutoApply";
import { saveAutoApplyTracking } from "@/lib/autoApplyTracking";
import { isTruthy } from "@/lib/defaultResume";

export async function POST(req: NextRequest) {
  let body: { jobId?: string; url?: string; jobrightJobId?: string; defaultResume?: unknown };
  try {
    body = await req.json() as { jobId?: string; url?: string; jobrightJobId?: string; defaultResume?: unknown };
  } catch {
    return NextResponse.json({ success: false, error: "invalid_json" }, { status: 400 });
  }

  const { jobId, url, jobrightJobId } = body;
  const defaultResume = isTruthy(body.defaultResume);
  if (!jobId || !url) {
    return NextResponse.json({ success: false, error: "missing_fields" }, { status: 400 });
  }

  const result = await runAutoApplyJob({ jobId, url, jobrightJobId, defaultResume });

  if (!result.trackingSaved) {
    await saveAutoApplyTracking({
      origin: req.nextUrl.origin,
      jobId,
      jobUrl: url,
      atsId: result.atsId,
      success: result.success,
      error: result.error,
      defaultResume,
    });
  }

  if (!result.success) {
    const status = result.error === "unsupported_ats" ? 422 : 500;
    return NextResponse.json({ success: false, error: result.error || "ats_script_failed", ats: result.atsId || null }, { status });
  }

  return NextResponse.json({ success: true, ats: result.atsId });
}
