import mongoose, { Schema, Document, Model } from "mongoose";

export interface IAtsAutomation extends Document {
  atsId: string;       // "workday" | "greenhouse" | etc.
  atsName: string;     // display name
  enabled: boolean;    // toggle — when true, override profile/resume for all URLs of this ATS
  email: string;       // email to use in profile.json for this ATS
  latex: string;       // base resume LaTeX for this ATS
  folderName: string;  // Drive job folder key used for ATS-specific resume selection
  updatedAt: Date;
}

const AtsAutomationSchema = new Schema<IAtsAutomation>(
  {
    atsId:      { type: String, required: true, unique: true, index: true },
    atsName:    { type: String, required: true },
    enabled:    { type: Boolean, default: false },
    email:      { type: String, default: "" },
    latex:      { type: String, default: "" },
    folderName: { type: String, default: "" },
  },
  { timestamps: { createdAt: false, updatedAt: "updatedAt" } }
);

const AtsAutomation: Model<IAtsAutomation> =
  mongoose.models.AtsAutomation ||
  mongoose.model<IAtsAutomation>("AtsAutomation", AtsAutomationSchema);

export default AtsAutomation;
