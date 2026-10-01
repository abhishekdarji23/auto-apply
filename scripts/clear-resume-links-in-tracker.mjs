#!/usr/bin/env node
/**
 * Clear all resumePreviewLink fields in the AutoApplyJob collection.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { applyUserMongoEnv, getMongoEnvHint } from "./lib/user-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
dotenv.config({ path: path.join(__dirname, "../.env.local") });

const MONGODB_URI = applyUserMongoEnv(path.resolve(__dirname, ".."));

if (!MONGODB_URI) {
    console.error(`${getMongoEnvHint(path.resolve(__dirname, ".."))} not found in .env.local`);
    process.exit(1);
}

const AutoApplyJobSchema = new mongoose.Schema({
    resumePreviewLink: String
}, { strict: false });

const AutoApplyJob = mongoose.models.AutoApplyJob || mongoose.model("AutoApplyJob", AutoApplyJobSchema, "autoapplyjobs");

async function main() {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB.");

    const result = await AutoApplyJob.updateMany(
        {},
        { $set: { resumePreviewLink: "" } }
    );

    console.log(`Updated ${result.modifiedCount} records. cleared all resumePreviewLinks.`);
    await mongoose.disconnect();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
