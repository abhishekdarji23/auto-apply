#!/usr/bin/env node
/**
 * Delete all Greenhouse jobs from the Job collection so you can
 * re-fetch and verify title-filter + batch changes are working.
 *
 * Usage:
 *   node scripts/delete-greenhouse-jobs.mjs
 *   node scripts/delete-greenhouse-jobs.mjs --dry-run
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { applyUserMongoEnv, getMongoEnvHint } from "./lib/user-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const mongoose = _require("mongoose");

// ── Load .env.local ───────────────────────────────────────────────────────────
async function loadEnv() {
    const envPath = path.resolve(__dirname, "../.env.local");
    try {
        const raw = await readFile(envPath, "utf8");
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
            if (key && !process.env[key]) process.env[key] = value;
        }
    } catch {
        // no .env.local — rely on shell env
    }
}

await loadEnv();

const DRY_RUN = process.argv.includes("--dry-run");
const MONGODB_URI = applyUserMongoEnv(path.resolve(__dirname, ".."));

if (!MONGODB_URI) {
    console.error(`[delete-greenhouse] ERROR: ${getMongoEnvHint(path.resolve(__dirname, ".."))} not set in .env.local or shell env`);
    process.exit(1);
}

// ── Connect ───────────────────────────────────────────────────────────────────
await mongoose.connect(MONGODB_URI);

const Job = mongoose.model(
    "Job",
    new mongoose.Schema({}, { strict: false, collection: "jobs" })
);

// ── Count matching docs ───────────────────────────────────────────────────────
const filter = { jobId: /^greenhouse:/ };
const count = await Job.countDocuments(filter);

if (count === 0) {
    console.log("[delete-greenhouse] ✅ No Greenhouse jobs found — nothing to delete.");
    await mongoose.disconnect();
    process.exit(0);
}

console.log(`[delete-greenhouse] Found ${count} Greenhouse job(s) to delete.`);

if (DRY_RUN) {
    console.log("[delete-greenhouse] DRY RUN — no changes made. Remove --dry-run to delete.");
    await mongoose.disconnect();
    process.exit(0);
}

// ── Delete ────────────────────────────────────────────────────────────────────
const result = await Job.deleteMany(filter);
console.log(`[delete-greenhouse] ✅ Deleted ${result.deletedCount} Greenhouse job(s).`);

await mongoose.disconnect();
