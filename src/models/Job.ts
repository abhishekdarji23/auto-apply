import mongoose, { Schema, Document, Model } from "mongoose";

export interface IJob extends Document {
  jobId: string;
  title: string;
  company: string;
  location: string;
  salary: string;
  workModel: string;
  industry: string[];
  companySize: string;
  qualifications: string;
  expLevel: string;
  jobFunction: string;
  h1bSponsored: string;
  isNewGrad: boolean;
  roleType: string;
  hireTime: string;
  graduateTime: string;
  tabCategory: string[];
  postedAt: Date;
  fetchedAt: Date;
  applied: boolean;
  appliedAt: Date | null;
  autoApplied: boolean;
  autoAppliedAt: Date | null;
  manualApplied: boolean;
  manualAppliedAt: Date | null;
  notInterested: boolean;
  top500: boolean;
  companyRank: number;
  matchScore: number | null;
  jobrightId: string;
  jobrightAliases: string[];
  sourceTags: string[];
  sourceDetails: {
    key: string;
    kind: string;
    label: string;
    repo: string;
    url: string;
    jobrightId: string;
  }[];
  sourceKind: string;
  sourceRepo: string;
  sourceLabel: string;
  isH1bSponsor: boolean | null;
  isCitizenOnly: boolean | null;
  minSalary: number | null;
  maxSalary: number | null;
  notEligible: boolean;
  notEligibleReason: string;
  eligibilityStatus: string;
  applyLink: string;
  recruiterName: string;
  recruiterProfileUrl: string;
  detailsFetchedAt: Date | null;
  detailsFetchStatus: string;
  inactive: boolean;
  isExtraApiJob: boolean;
  category: string;
  categoryLabel: string;
  categoryConfidence: number;
  categoryPriority: number;
}

const JobSchema = new Schema<IJob>(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    title: { type: String, default: "" },
    company: { type: String, default: "" },
    location: { type: String, default: "" },
    salary: { type: String, default: "" },
    workModel: { type: String, default: "" },
    industry: { type: [String], default: [] },
    companySize: { type: String, default: "" },
    qualifications: { type: String, default: "" },
    expLevel: { type: String, default: "" },
    jobFunction: { type: String, default: "" },
    h1bSponsored: { type: String, default: "" },
    isNewGrad: { type: Boolean, default: false },
    roleType: { type: String, default: "" },
    hireTime: { type: String, default: "" },
    graduateTime: { type: String, default: "" },
    tabCategory: { type: [String], default: [] },
    postedAt: { type: Date, default: Date.now },
    fetchedAt: { type: Date, default: Date.now },
    applied: { type: Boolean, default: false },
    appliedAt: { type: Date, default: null },
    autoApplied: { type: Boolean, default: false, index: true },
    autoAppliedAt: { type: Date, default: null },
    manualApplied: { type: Boolean, default: false, index: true },
    manualAppliedAt: { type: Date, default: null },
    notInterested: { type: Boolean, default: false },
    top500: { type: Boolean, default: false },
    companyRank: { type: Number, default: 999999 },
    matchScore: { type: Number, default: null, index: true },
    jobrightId: { type: String, default: "", index: true },
    jobrightAliases: { type: [String], default: [], index: true },
    sourceTags: { type: [String], default: [], index: true },
    sourceDetails: {
      type: [
        {
          key: { type: String, default: "" },
          kind: { type: String, default: "" },
          label: { type: String, default: "" },
          repo: { type: String, default: "" },
          url: { type: String, default: "" },
          jobrightId: { type: String, default: "" },
        },
      ],
      default: [],
    },
    sourceKind: { type: String, default: "", index: true },
    sourceRepo: { type: String, default: "", index: true },
    sourceLabel: { type: String, default: "" },
    isH1bSponsor: { type: Boolean, default: null, index: true },
    isCitizenOnly: { type: Boolean, default: null, index: true },
    minSalary: { type: Number, default: null, index: true },
    maxSalary: { type: Number, default: null },
    notEligible: { type: Boolean, default: false, index: true },
    notEligibleReason: { type: String, default: "" },
    eligibilityStatus: { type: String, default: "eligible", index: true },
    applyLink: { type: String, default: "" },
    recruiterName: { type: String, default: "" },
    recruiterProfileUrl: { type: String, default: "" },
    detailsFetchedAt: { type: Date, default: null, index: true },
    detailsFetchStatus: { type: String, default: "pending" },
    inactive: { type: Boolean, default: false, index: true },
    isExtraApiJob: { type: Boolean, default: false, index: true },
    category: { type: String, default: "others", index: true },
    categoryLabel: { type: String, default: "Others" },
    categoryConfidence: { type: Number, default: 0.50, index: true },
    categoryPriority: { type: Number, default: 15, index: true },
  },
  { timestamps: true }
);

// Query-path indexes for /api/jobs filters + postedAt sorting.
JobSchema.index({ postedAt: -1 });
JobSchema.index({ categoryPriority: 1, postedAt: -1 });
JobSchema.index({ inactive: 1, categoryPriority: 1, postedAt: -1 });
JobSchema.index({ inactive: 1, postedAt: -1 });
JobSchema.index({ applied: 1, postedAt: -1 });
JobSchema.index({ autoApplied: 1, postedAt: -1 });
JobSchema.index({ manualApplied: 1, postedAt: -1 });
JobSchema.index({ notInterested: 1, postedAt: -1 });
JobSchema.index({ applied: 1, notInterested: 1, postedAt: -1 });
JobSchema.index({ manualApplied: 1, notInterested: 1, postedAt: -1 });
JobSchema.index({ autoApplied: 1, notInterested: 1, postedAt: -1 });
JobSchema.index({ inactive: 1, applied: 1, notInterested: 1 });
JobSchema.index({ inactive: 1, autoApplied: 1, notInterested: 1 });
JobSchema.index({ notEligible: 1, postedAt: -1 });
JobSchema.index({ detailsFetchStatus: 1, detailsFetchedAt: 1, postedAt: -1 });
JobSchema.index({ isExtraApiJob: 1, postedAt: -1 });

// Delete cached model to pick up schema changes in dev
if (mongoose.models.Job) {
  delete mongoose.models.Job;
}

const Job: Model<IJob> = mongoose.model<IJob>("Job", JobSchema);

export default Job;
