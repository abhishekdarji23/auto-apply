import { NextRequest, NextResponse } from "next/server";
import { runAutoApplyJob } from "@/lib/runAutoApply";
import { saveAutoApplyTracking } from "@/lib/autoApplyTracking";
import { isTruthy } from "@/lib/defaultResume";

function randomJobId(): string {
  return `manual-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      jobId?: string;
      jobrightJobId?: string;
      url?: string;
      defaultResume?: unknown;
    };

    const url = String(body.url || "").trim();
    if (!url) {
      return NextResponse.json({ success: false, error: "missing_url" }, { status: 400 });
    }

    const jobId = String(body.jobId || "").trim() || randomJobId();
    const jobrightJobId = String(body.jobrightJobId || "").trim();
    const defaultResume = isTruthy(body.defaultResume);
    const run = await runAutoApplyJob({ jobId, jobrightJobId, url, defaultResume });

    const saved = run.trackingSaved
      ? null
      : await saveAutoApplyTracking({
          origin: request.nextUrl.origin,
          jobId,
          jobUrl: url,
          atsId: run.atsId,
          success: run.success,
          error: run.error,
          defaultResume,
        });

    return NextResponse.json({
      success: run.success,
      error: run.error || "",
      ats: run.atsId,
      row: saved,
      trackingSaved: run.trackingSaved,
    }, { status: run.success ? 200 : 500 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
