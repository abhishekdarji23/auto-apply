#!/usr/bin/env node
/**
 * Normalizes ResumeDashboardItem records that have a Greenhouse jobUrl in a
 * non-canonical format (e.g. direct URL, with utm_source, with gh_jid param).
 *
 * Converts all Greenhouse variants to:
 *   https://boards.greenhouse.io/embed/job_app?token=<id>
 *
 * Usage:
 *   node scripts/fix-greenhouse-resume-urls.mjs
 *   node scripts/fix-greenhouse-resume-urls.mjs --dry-run
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
    console.error(`[fix-gh-resume-urls] ERROR: ${getMongoEnvHint(path.resolve(__dirname, ".."))} not set in .env.local or shell env`);
    process.exit(1);
}

// ── URL helpers ───────────────────────────────────────────────────────────────

function extractGreenhouseToken(url) {
    try {
        const u = new URL(url);
        // embed URL: boards.greenhouse.io/embed/job_app?token=<id>
        const tokenParam = u.searchParams.get("token");
        if (tokenParam && /^\d+$/.test(tokenParam)) return tokenParam;
        // direct URL: boards.greenhouse.io/<slug>/jobs/<id>
        const directMatch = u.pathname.match(/\/jobs\/(\d+)/);
        if (directMatch) return directMatch[1];
        // gh_jid param on any host
        const ghJid = u.searchParams.get("gh_jid");
        if (ghJid && /^\d+$/.test(ghJid)) return ghJid;
    } catch {
        // fall through
    }
    return null;
}

function isGreenhouseUrl(url) {
    try {
        const u = new URL(url);
        return (
            u.hostname.includes("greenhouse.io") ||
            u.searchParams.has("gh_jid") ||
            u.searchParams.has("token") && u.hostname.includes("greenhouse")
        );
    } catch {
        return false;
    }
}

function toEmbedUrl(token) {
    return `https://boards.greenhouse.io/embed/job_app?token=${token}`;
}

function normalizeGreenhouseUrl(raw) {
    const url = String(raw || "").trim();
    if (!url) return null;
    if (!isGreenhouseUrl(url)) return null;

    // Strip utm_source=jobright if present
    let cleaned = url;
    try {
        const u = new URL(url);
        if (u.searchParams.get("utm_source") === "jobright") {
            u.searchParams.delete("utm_source");
            cleaned = u.toString();
        }
    } catch {
        // keep original
    }

    const token = extractGreenhouseToken(cleaned);
    if (!token) return null;
    return toEmbedUrl(token);
}

// ── Connect ───────────────────────────────────────────────────────────────────
await mongoose.connect(MONGODB_URI);
console.log("[fix-gh-resume-urls] Connected to MongoDB");

const ResumeDashboardItem = mongoose.model(
    "ResumeDashboardItem",
    new mongoose.Schema({}, { strict: false, collection: "resumedashboarditems" })
);

// ── Find greenhouse records ───────────────────────────────────────────────────
const GREENHOUSE_REGEX = /greenhouse\.io|gh_jid=/i;
const candidates = await ResumeDashboardItem.find(
    { jobUrl: { $regex: GREENHOUSE_REGEX } },
    { _id: 1, jobUrl: 1, jobUrlLower: 1 }
).lean();

console.log(`[fix-gh-resume-urls] Found ${candidates.length} greenhouse ResumeDashboardItem record(s)`);

if (candidates.length === 0) {
    console.log("[fix-gh-resume-urls] Nothing to do.");
    await mongoose.disconnect();
    process.exit(0);
}

// ── Build bulk updates ────────────────────────────────────────────────────────
let toUpdate = 0;
let alreadyCanonical = 0;
let noToken = 0;
const bulkOps = [];

for (const doc of candidates) {
    const raw = String(doc.jobUrl || "").trim();
    const canonical = normalizeGreenhouseUrl(raw);

    if (!canonical) {
        noToken++;
        console.warn(`[fix-gh-resume-urls] Cannot extract token from: ${raw}`);
        continue;
    }

    if (raw === canonical) {
        alreadyCanonical++;
        continue;
    }

    toUpdate++;
    console.log(`[fix-gh-resume-urls]  ${raw}`);
    console.log(`[fix-gh-resume-urls]  → ${canonical}`);

    if (!DRY_RUN) {
        bulkOps.push({
            updateOne: {
                filter: { _id: doc._id },
                update: { $set: { jobUrl: canonical, jobUrlLower: canonical.toLowerCase() } },
            },
        });
    }
}

console.log(`\n[fix-gh-resume-urls] Summary:`);
console.log(`  already canonical : ${alreadyCanonical}`);
console.log(`  to update         : ${toUpdate}`);
console.log(`  no token (skip)   : ${noToken}`);

if (DRY_RUN) {
    console.log("\n[fix-gh-resume-urls] DRY RUN — no changes made. Remove --dry-run to apply.");
} else if (bulkOps.length > 0) {
    const result = await ResumeDashboardItem.bulkWrite(bulkOps, { ordered: false });
    console.log(`\n[fix-gh-resume-urls] Updated ${result.modifiedCount} record(s).`);
} else {
    console.log("\n[fix-gh-resume-urls] Nothing to update.");
}

await mongoose.disconnect();
