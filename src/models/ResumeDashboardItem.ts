import mongoose, { Document, Model, Schema } from "mongoose";

export interface IResumeDashboardItem extends Document {
  mode: string;
  email: string;
  folder: string;
  jobUrl: string;
  jobUrlLower: string;
  ats: string;
  title: string;
  company: string;
  pdfFile: string;
  createdAt: Date;
  postedAt: string;
}

const ResumeDashboardItemSchema = new Schema<IResumeDashboardItem>({
  mode: { type: String, required: true },
  email: { type: String, required: true },
  folder: { type: String, required: true },
  jobUrl: { type: String, required: true },
  jobUrlLower: { type: String, required: true, index: true },
  ats: { type: String, default: "unknown" },
  title: { type: String, default: "" },
  company: { type: String, default: "" },
  pdfFile: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now, index: true },
  postedAt: { type: String, default: "" },
});

// Unique compound index — one record per mode + email + folder
ResumeDashboardItemSchema.index({ mode: 1, email: 1, folder: 1 }, { unique: true });
// Composite index for email + mode lookups
ResumeDashboardItemSchema.index({ email: 1, mode: 1 });

if (mongoose.models.ResumeDashboardItem) {
  delete mongoose.models.ResumeDashboardItem;
}

const ResumeDashboardItem: Model<IResumeDashboardItem> =
  mongoose.models.ResumeDashboardItem ||
  mongoose.model<IResumeDashboardItem>(
    "ResumeDashboardItem",
    ResumeDashboardItemSchema
  );

export default ResumeDashboardItem;
