import { NextRequest, NextResponse } from "next/server";
import { saveAutoApplyTracking } from "@/lib/autoApplyTracking";
import { isTruthy } from "@/lib/defaultResume";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      jobId?: string;
      jobUrl?: string;
      atsId?: string;
      success?: boolean;
      error?: string;
      defaultResume?: unknown;
    };

    const jobUrl = String(body.jobUrl || "").trim();
    if (!jobUrl) {
      return NextResponse.json({ success: false, error: "missing_job_url" }, { status: 400 });
    }

    const row = await saveAutoApplyTracking({
      origin: request.nextUrl.origin,
      jobId: body.jobId,
      jobUrl,
      atsId: body.atsId,
      success: Boolean(body.success),
      error: body.error,
      defaultResume: isTruthy(body.defaultResume),
    });

    return NextResponse.json({ success: true, row });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
