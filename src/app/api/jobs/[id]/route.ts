import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Job from "@/models/Job";
import { markJobrightApplied } from "@/lib/jobrightApply";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const job = await Job.findOne({ jobId: id }).lean();
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    return NextResponse.json({
      ...job,
      applied: Boolean(job.manualApplied),
      appliedAt: job.manualAppliedAt ?? null,
    });
  } catch (error) {
    console.error("Get job error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    const body = await request.json();

    const updateFields: Record<string, unknown> = {};

    if (body.applied !== undefined) {
      updateFields.manualApplied = body.applied;
      updateFields.manualAppliedAt = body.applied ? new Date() : null;
      updateFields.applied = body.applied;
      updateFields.appliedAt = body.applied ? new Date() : null;
      // Clear notInterested if marking as applied
      if (body.applied) updateFields.notInterested = false;
    }

    if (body.notInterested !== undefined) {
      updateFields.notInterested = body.notInterested;
      // Clear applied if marking as not interested
      if (body.notInterested) {
        updateFields.manualApplied = false;
        updateFields.manualAppliedAt = null;
        updateFields.applied = false;
        updateFields.appliedAt = null;
      }
    }

    const job = await Job.findOneAndUpdate(
      { jobId: id },
      { $set: updateFields },
      { new: true }
    );

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    let jobrightApply = null;
    if (body.applied === true) {
      try {
        jobrightApply = await markJobrightApplied(job);
        if (jobrightApply && "ok" in jobrightApply && jobrightApply.ok === false) {
          console.warn(`[jobs.patch] JobRight apply mark failed jobId=${id} status=${jobrightApply.status}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        jobrightApply = { skipped: false, ok: false, message };
        console.warn(`[jobs.patch] JobRight apply mark error jobId=${id}: ${message}`);
      }
    }

    return NextResponse.json({ success: true, job, jobrightApply });
  } catch (error) {
    console.error("Update job error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
