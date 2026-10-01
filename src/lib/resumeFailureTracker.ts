import dbConnect from "@/lib/mongodb";
import ResumeFailure from "@/models/ResumeFailure";
import Job from "@/models/Job";
import { detectATS } from "@/lib/ats-map";

export type ResumeFailureInput = {
  jobUrl: string;
  email?: string;
  errorReason: string;
  errorDetails?: string;
  title?: string;
  company?: string;
  ats?: string;
};

export async function recordResumeFailure(input: ResumeFailureInput) {
  try {
    const rawUrl = String(input.jobUrl || "").trim();
    if (!rawUrl) return;

    const jobUrlLower = rawUrl.toLowerCase();
    await dbConnect();

    // Look up title/company from Job collection if not provided
    let title = input.title || "";
    let company = input.company || "";
    let ats = input.ats || "";

    if (!title || !company || !ats) {
      const existingJob = await Job.findOne({ applyLink: rawUrl }).lean();
      if (existingJob) {
        if (!title) title = existingJob.title || "";
        if (!company) company = existingJob.company || "";
      }
      if (!ats) {
        ats = detectATS(rawUrl)?.id || "unknown";
      }
    }

    await ResumeFailure.findOneAndUpdate(
      { jobUrlLower, email: input.email || "" },
      {
        jobUrl: rawUrl,
        jobUrlLower,
        title,
        company,
        ats,
        email: input.email || "",
        errorReason: input.errorReason,
        errorDetails: input.errorDetails || "",
        failedAt: new Date(),
      },
      { upsert: true, returnDocument: "after" }
    );
  } catch (err) {
    console.error("[resumeFailureTracker] Failed to record resume failure:", err);
  }
}
