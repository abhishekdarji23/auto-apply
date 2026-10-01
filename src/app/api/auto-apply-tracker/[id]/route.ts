import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import AutoApplyJob from "@/models/AutoApplyJob";
import Job from "@/models/Job";
import { AUTO_APPLY_STATUSES, type AutoApplyStatus } from "@/models/AutoApplyJob";
import { markJobrightApplied } from "@/lib/jobrightApply";

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const body = await request.json() as {
      status?: AutoApplyStatus;
      lastError?: string;
    };

    const nextStatus = String(body.status || "").trim() as AutoApplyStatus;
    if (!AUTO_APPLY_STATUSES.includes(nextStatus)) {
      return NextResponse.json({ success: false, error: "invalid_status" }, { status: 400 });
    }

    const update: {
      status: AutoApplyStatus;
      updatedAt: Date;
      appliedAt?: Date | null;
      lastError?: string;
    } = {
      status: nextStatus,
      updatedAt: new Date(),
    };

    if (nextStatus === "applied" || nextStatus === "success") {
      update.appliedAt = new Date();
    }

    if (Object.prototype.hasOwnProperty.call(body, "lastError")) {
      update.lastError = String(body.lastError || "");
    }

    const row = await AutoApplyJob.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true }
    ).lean();

    if (!row) {
      return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
    }

    let jobrightApply = null;
    if (nextStatus === "applied" || nextStatus === "success") {
      const jobUrl = String(row.jobUrl || "").trim();
      const job = jobUrl
        ? await Job.findOneAndUpdate(
            { applyLink: { $regex: `^${escapeRegex(jobUrl)}$`, $options: "i" } },
            { $set: { autoApplied: true, autoAppliedAt: update.appliedAt || new Date() } },
            { new: true }
          ).lean()
        : null;

      if (job) {
        try {
          jobrightApply = await markJobrightApplied(job);
          if (jobrightApply && "ok" in jobrightApply && jobrightApply.ok === false) {
            console.warn(`[auto-apply-tracker.patch] JobRight apply mark failed id=${id} status=${jobrightApply.status}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          jobrightApply = { skipped: false, ok: false, message };
          console.warn(`[auto-apply-tracker.patch] JobRight apply mark error id=${id}: ${message}`);
        }
      }
    }

    return NextResponse.json({ success: true, row, jobrightApply });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;

    const deleted = await AutoApplyJob.findByIdAndDelete(id).lean();
    if (!deleted) {
      return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
