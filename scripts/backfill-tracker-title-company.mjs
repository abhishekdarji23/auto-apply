/**
 * Backfill title + company for AutoApplyJob records where they are blank.
 * Matches by jobUrl (case-insensitive) against Job.applyLink.
 *
 * Run: node scripts/backfill-tracker-title-company.mjs
 */

import { createRequire } from "module";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { applyUserMongoEnv, getMongoEnvHint } from "./lib/user-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const mongoose = require("mongoose");

// Load .env.local without dotenv
try {
    const envContent = readFileSync(resolve(__dirname, "../.env.local"), "utf-8");
    for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = trimmed.indexOf("=");
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
    }
} catch { /* no .env.local */ }

const JobSchema = new mongoose.Schema({}, { strict: false, collection: "jobs" });
const AutoApplyJobSchema = new mongoose.Schema({}, { strict: false, collection: "autoapplyjobs" });
const Job = mongoose.models.Job || mongoose.model("Job", JobSchema);
const AutoApplyJob = mongoose.models.AutoApplyJob || mongoose.model("AutoApplyJob", AutoApplyJobSchema);

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
    const mongoUri = applyUserMongoEnv(resolve(__dirname, ".."));
    if (!mongoUri) throw new Error(`${getMongoEnvHint(resolve(__dirname, ".."))} is not set`);
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    // Get all tracker records missing title OR company
    const blank = await AutoApplyJob.find(
        { $or: [{ title: { $in: [null, ""] } }, { company: { $in: [null, ""] } }] },
        { _id: 1, jobUrl: 1, title: 1, company: 1 }
    ).lean();

    console.log(`Found ${blank.length} tracker records with blank title/company`);
    if (blank.length === 0) { await mongoose.disconnect(); return; }

    // Load all Job docs with URL and title/company
    const jobDocs = await Job.find(
        { applyLink: { $ne: "" } },
        { applyLink: 1, title: 1, company: 1 }
    ).lean();

    // Build lowercase map: url_lower → { title, company }
    const jobMap = new Map();
    for (const doc of jobDocs) {
        const key = String(doc.applyLink || "").trim().toLowerCase();
        if (key && !jobMap.has(key)) {
            jobMap.set(key, { title: String(doc.title || ""), company: String(doc.company || "") });
        }
    }

    const bulkOps = [];
    let matched = 0;
    let skipped = 0;

    for (const row of blank) {
        const key = String(row.jobUrl || "").trim().toLowerCase();
        const found = jobMap.get(key);
        if (!found || (!found.title && !found.company)) { skipped++; continue; }

        const $set = {};
        if (!row.title && found.title) $set.title = found.title;
        if (!row.company && found.company) $set.company = found.company;

        if (Object.keys($set).length === 0) { skipped++; continue; }

        matched++;
        bulkOps.push({ updateOne: { filter: { _id: row._id }, update: { $set } } });
    }

    console.log(`Matched: ${matched} | No match: ${skipped}`);

    if (bulkOps.length > 0) {
        const result = await AutoApplyJob.bulkWrite(bulkOps, { ordered: false });
        console.log(`Updated: ${result.modifiedCount}`);
    } else {
        console.log("Nothing to update.");
    }

    await mongoose.disconnect();
    console.log("Done.");
}

main().catch((err) => { console.error(err); process.exit(1); });
