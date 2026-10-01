#!/usr/bin/env node
/**
 * One-time backfill: Classify all existing jobs in MongoDB using Jev AI.
 *
 * Usage:
 *   node scripts/backfill-job-categories.mjs
 *   node scripts/backfill-job-categories.mjs --dry-run   # preview, no writes
 *   node scripts/backfill-job-categories.mjs --force     # re-classify all jobs
 *   node scripts/backfill-job-categories.mjs --concurrency=20
 *
 * Requires: TYPESAFE_API_KEY in environment.
 */

import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { applyUserMongoEnv, getMongoEnvHint } from "./lib/user-config.mjs";
import { classifyJobTitle, CATEGORIES, OTHERS_CATEGORY } from "./lib/job-classifier.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ─── Args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const CONCURRENCY = parseInt(
  args.find((a) => a.startsWith("--concurrency="))?.split("=")?.[1] || "10",
  10
);
const CHUNK_SIZE = 500;

// ─── Env check ───────────────────────────────────────────────────────────────
const MONGODB_URI = applyUserMongoEnv(ROOT);
if (!MONGODB_URI) {
  console.error(`ERROR: ${getMongoEnvHint(ROOT)} is not set`);
  process.exit(1);
}

if (!process.env.TYPESAFE_API_KEY) {
  console.error("ERROR: TYPESAFE_API_KEY is not set in your environment.");
  process.exit(1);
}

// ─── Mongoose Schema ─────────────────────────────────────────────────────────
const JobSchema = new mongoose.Schema(
  {
    jobId: String,
    title: String,
    roleType: String,
    jobFunction: String,
    category: String,
    categoryLabel: String,
    categoryConfidence: Number,
    categoryPriority: Number,
  },
  { collection: "jobs" }
);

const Job = mongoose.models.Job || mongoose.model("Job", JobSchema);

// ─── Concurrency pool ────────────────────────────────────────────────────────
async function runWithConcurrency(items, concurrency, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function run() {
  console.log(
    `[backfill-categories] 🚀 Starting Jev AI Classification${DRY_RUN ? " (DRY RUN)" : ""}${FORCE ? " (FORCE re-classify)" : ""} | concurrency=${CONCURRENCY}`
  );

  await mongoose.connect(MONGODB_URI);
  console.log("[backfill-categories] Connected to MongoDB");

  // Build query — skip already-properly-classified unless --force
  const query = FORCE
    ? {}
    : {
        $or: [
          { category: { $exists: false } },
          { category: null },
          { category: "" },
          { category: "others" },
        ],
      };

  const total = await Job.countDocuments(query);
  console.log(`[backfill-categories] Jobs to classify: ${total}`);

  if (total === 0) {
    console.log(
      "[backfill-categories] ✅ Nothing to do — all jobs already classified. Use --force to re-classify."
    );
    await mongoose.disconnect();
    return;
  }

  const stats = { processed: 0, updated: 0, skipped: 0, errors: 0 };
  const categoryCounts = {};
  [...CATEGORIES, OTHERS_CATEGORY].forEach((c) => (categoryCounts[c.id] = 0));

  let cursor = Job.find(query, {
    _id: 1,
    title: 1,
    roleType: 1,
    jobFunction: 1,
    category: 1,
  }).cursor({ batchSize: CHUNK_SIZE });

  let batch = [];

  const processBatch = async (jobs) => {
    // Classify all jobs in this batch concurrently (up to CONCURRENCY)
    const results = await runWithConcurrency(jobs, CONCURRENCY, async (job) => {
      try {
        const result = await classifyJobTitle(job.title, {
          roleType: job.roleType,
          jobFunction: job.jobFunction,
        });
        return { job, result, ok: true };
      } catch (err) {
        console.error(`[backfill-categories] Error classifying "${job.title}": ${err.message}`);
        return { job, result: null, ok: false };
      }
    });

    const bulkOps = [];
    for (const { job, result, ok } of results) {
      stats.processed++;
      if (!ok || !result) {
        stats.errors++;
        continue;
      }

      categoryCounts[result.category] = (categoryCounts[result.category] || 0) + 1;

      // Skip if unchanged (avoids unnecessary writes)
      if (!FORCE && job.category === result.category) {
        stats.skipped++;
        continue;
      }

      bulkOps.push({
        updateOne: {
          filter: { _id: job._id },
          update: {
            $set: {
              category: result.category,
              categoryLabel: result.categoryLabel,
              categoryConfidence: result.categoryConfidence,
              categoryPriority: result.categoryPriority,
            },
          },
        },
      });
    }

    if (bulkOps.length && !DRY_RUN) {
      await Job.bulkWrite(bulkOps, { ordered: false });
    }
    stats.updated += bulkOps.length;

    console.log(
      `[backfill-categories] ... ${stats.processed}/${total} processed | updated=${stats.updated} skipped=${stats.skipped} errors=${stats.errors}`
    );
  };

  for await (const job of cursor) {
    batch.push(job);
    if (batch.length >= CHUNK_SIZE) {
      await processBatch(batch);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await processBatch(batch);
  }

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log("\n[backfill-categories] ✅ Done!");
  console.log(`  Total processed : ${stats.processed}`);
  console.log(`  Updated         : ${stats.updated}${DRY_RUN ? " (dry-run, not written)" : ""}`);
  console.log(`  Skipped (same)  : ${stats.skipped}`);
  console.log(`  Errors          : ${stats.errors}`);
  console.log("\n[backfill-categories] Category Distribution (via Jev AI):");

  const sorted = Object.entries(categoryCounts).sort((a, b) => {
    const pa = CATEGORIES.find((c) => c.id === a[0])?.priority ?? 15;
    const pb = CATEGORIES.find((c) => c.id === b[0])?.priority ?? 15;
    return pa - pb;
  });

  for (const [id, count] of sorted) {
    const cat = CATEGORIES.find((c) => c.id === id) || OTHERS_CATEGORY;
    const pStr = String(cat.priority).padStart(2, "0");
    console.log(`  [P${pStr}] ${cat.label.padEnd(50)} : ${count} jobs`);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("[backfill-categories] FATAL:", err);
  process.exit(1);
});
