import mongoose, { Document, Model, Schema } from "mongoose";

export interface IResumeFailure extends Document {
  jobUrl: string;
  jobUrlLower: string;
  title: string;
  company: string;
  ats: string;
  email: string;
  errorReason: string;
  errorDetails: string;
  failedAt: Date;
}

const ResumeFailureSchema = new Schema<IResumeFailure>(
  {
    jobUrl: { type: String, required: true },
    jobUrlLower: { type: String, required: true, index: true },
    title: { type: String, default: "" },
    company: { type: String, default: "" },
    ats: { type: String, default: "unknown" },
    email: { type: String, default: "" },
    errorReason: { type: String, required: true },
    errorDetails: { type: String, default: "" },
    failedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

ResumeFailureSchema.index({ jobUrlLower: 1, email: 1 }, { unique: true });

if (mongoose.models.ResumeFailure) {
  delete mongoose.models.ResumeFailure;
}

const ResumeFailure: Model<IResumeFailure> =
  mongoose.models.ResumeFailure ||
  mongoose.model<IResumeFailure>("ResumeFailure", ResumeFailureSchema);

export default ResumeFailure;
