/**
 * One-time script to restore original-cased URLs that were accidentally lowercased
 * by the `lowercaseAllJobUrls()` step.
 *
 * Strategy:
 *   1. AutoApplyJob.jobUrl still has the original casing → restore those into Job.
 *   2. For all remaining active jobs that came from Jobright (detailsFetchedAt set)
 *      but have NO AutoApplyJob record → force re-fetch by clearing the URL fields.
 *
 * Run: node scripts/restore-original-urls.mjs
 */

import { createRequire } from "module";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { applyUserMongoEnv, getMongoEnvHint } from "./lib/user-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const mongoose = require("mongoose");

// Load .env.local manually without dotenv
import { readFileSync } from "fs";
const envPath = resolve(__dirname, "../.env.local");
try {
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const idx = trimmed.indexOf("=");
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
    }
} catch { /* .env.local not found */ }

// ── Inline minimal schemas (avoid TS imports) ──────────────────────────────

const JobSchema = new mongoose.Schema({}, { strict: false, collection: "jobs" });
const AutoApplyJobSchema = new mongoose.Schema({}, { strict: false, collection: "autoapplyjobs" });

const Job = mongoose.models.Job || mongoose.model("Job", JobSchema);
const AutoApplyJob = mongoose.models.AutoApplyJob || mongoose.model("AutoApplyJob", AutoApplyJobSchema);

// ── Helpers ────────────────────────────────────────────────────────────────

function normKey(url) {
    return String(url || "").trim().toLowerCase();
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const mongoUri = applyUserMongoEnv(resolve(__dirname, ".."));
    if (!mongoUri) throw new Error(`${getMongoEnvHint(resolve(__dirname, ".."))} is not set`);
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    // ── Step 1: Build a map of lowercase-URL → original-URL from AutoApplyJob ──
    console.log("\n[step 1] Loading AutoApplyJob records...");
    const trackerDocs = await AutoApplyJob.find({}, { jobUrl: 1, _id: 0 }).lean();
    console.log(`  Found ${trackerDocs.length} AutoApplyJob records`);

    // lowercaseUrl → original url (first seen wins)
    const originalByCaseless = new Map();
    for (const doc of trackerDocs) {
        const original = String(doc.jobUrl || "").trim();
        if (!original) continue;
        const key = original.toLowerCase();
        if (!originalByCaseless.has(key)) {
            originalByCaseless.set(key, original);
        }
    }
    console.log(`  Unique URLs from tracker: ${originalByCaseless.size}`);

    // ── Step 2: Load all active jobs that have a URL set ──────────────────────
    console.log("\n[step 2] Loading active jobs with URLs...");
    const jobs = await Job.find(
        { inactive: { $ne: true }, $or: [{ applyLink: { $ne: "" } }, { originalUrl: { $ne: "" } }] },
        { jobId: 1, applyLink: 1, originalUrl: 1, detailsFetchedAt: 1, detailsFetchStatus: 1 }
    ).lean();
    console.log(`  Found ${jobs.length} active jobs with URLs`);

    const restoreOps = [];
    const refetchOps = [];

    for (const job of jobs) {
        const jobId = String(job.jobId || "");
        const applyLink = String(job.applyLink || "").trim();
        const originalUrl = String(job.originalUrl || "").trim();

        const applyKey = normKey(applyLink);
        const originalKey = normKey(originalUrl);

        // Look up original casing from tracker
        const restoredApply = originalByCaseless.get(applyKey) || null;
        const restoredOriginal = originalByCaseless.get(originalKey) || null;

        // If we found at least one original-cased URL from tracker — restore it
        if (restoredApply || restoredOriginal) {
            const nextApply = restoredApply ?? applyLink;
            const nextOriginal = restoredOriginal ?? originalUrl;

            if (nextApply !== applyLink || nextOriginal !== originalUrl) {
                restoreOps.push({
                    updateOne: {
                        filter: { jobId },
                        update: { $set: { applyLink: nextApply, originalUrl: nextOriginal } },
                    },
                });
            }
            continue;
        }

        // No tracker match → force re-fetch if it was previously fetched from Jobright
        if (job.detailsFetchedAt || job.detailsFetchStatus === "ok") {
            refetchOps.push({
                updateOne: {
                    filter: { jobId },
                    update: {
                        $unset: { applyLink: "", originalUrl: "", detailsFetchedAt: "", detailsFetchStatus: "" },
                    },
                },
            });
        }
    }

    // ── Step 3: Apply restore ops ─────────────────────────────────────────────
    console.log(`\n[step 3] Restoring ${restoreOps.length} jobs from tracker URLs...`);
    if (restoreOps.length > 0) {
        const result = await Job.bulkWrite(restoreOps, { ordered: false });
        console.log(`  Modified: ${result.modifiedCount}`);
    } else {
        console.log("  Nothing to restore from tracker.");
    }

    // ── Step 4: Apply re-fetch ops ────────────────────────────────────────────
    console.log(`\n[step 4] Queuing ${refetchOps.length} jobs for re-fetch (clearing URL fields)...`);
    if (refetchOps.length > 0) {
        const result = await Job.bulkWrite(refetchOps, { ordered: false });
        console.log(`  Modified: ${result.modifiedCount}`);
        console.log("  → Run fetch-details again to re-populate original URLs for these jobs.");
    } else {
        console.log("  Nothing queued for re-fetch.");
    }

    console.log("\nDone.");
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
