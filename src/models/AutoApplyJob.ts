import mongoose, { Document, Model, Schema } from "mongoose";

export const AUTO_APPLY_STATUSES = ["success", "failed", "running", "applied", "skipped"] as const;

export type AutoApplyStatus = (typeof AUTO_APPLY_STATUSES)[number];

export interface IAutoApplyJob extends Document {
  jobId: string;
  title: string;
  company: string;
  category?: string;
  categoryLabel?: string;
  jobUrl: string;
  atsId: string;
  appliedEmail: string;
  resumePreviewLink: string;
  status: AutoApplyStatus;
  lastError: string;
  attempts: number;
  lastTriedAt: Date | null;
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const AutoApplyJobSchema = new Schema<IAutoApplyJob>(
  {
    jobId: { type: String, default: "", index: true },
    title: { type: String, default: "" },
    company: { type: String, default: "" },
    category: { type: String, default: "others", index: true },
    categoryLabel: { type: String, default: "Others" },
    jobUrl: { type: String, required: true, index: true },
    atsId: { type: String, default: "" },
    appliedEmail: { type: String, default: "" },
    resumePreviewLink: { type: String, default: "" },
    status: { type: String, enum: AUTO_APPLY_STATUSES, default: "running", index: true },
    lastError: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    lastTriedAt: { type: Date, default: null },
    appliedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

AutoApplyJobSchema.index({ updatedAt: -1 });
AutoApplyJobSchema.index({ jobId: 1, updatedAt: -1 });
AutoApplyJobSchema.index({ jobUrl: 1, appliedEmail: 1 }, { unique: true, sparse: true });

if (mongoose.models.AutoApplyJob) {
  delete mongoose.models.AutoApplyJob;
}

const AutoApplyJob: Model<IAutoApplyJob> =
  mongoose.models.AutoApplyJob || mongoose.model<IAutoApplyJob>("AutoApplyJob", AutoApplyJobSchema);

export default AutoApplyJob;
