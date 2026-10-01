#!/usr/bin/env node
/**
 * Backfill the ResumeDashboardItem Mongo index from existing Google Drive folders.
 *
 * Walk Drive: {GOOGLE_DRIVE_ROOT_FOLDER_ID}/{mode}/{email}/{jobFolder}
 * For each job folder:
 *   - Read meta.json to get jobUrl + createdAt (falls back to job-url.txt)
 *   - Look up title / company / postedAt from AutoApplyJob and Job collections
 *   - Upsert a ResumeDashboardItem document
 *
 * Usage:
 *   node scripts/backfill-resume-dashboard-index.mjs
 *   node scripts/backfill-resume-dashboard-index.mjs --dry-run
 *
 * Optional env:
 *   BACKFILL_CONCURRENCY=10  (default: 10 parallel folder operations)
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { applyUserMongoEnv, getMongoEnvHint } from "./lib/user-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const mongoose = _require("mongoose");
const { google } = _require("googleapis");

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
        // no .env.local present — rely on shell env
    }
}

await loadEnv();

// ── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || "";
const FALLBACK_ROOT_FOLDER_IDS = (process.env.GOOGLE_DRIVE_FALLBACK_ROOT_FOLDER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const ROOT_FOLDER_IDS = Array.from(new Set([ROOT_FOLDER_ID, ...FALLBACK_ROOT_FOLDER_IDS].filter(Boolean)));
const SERVICE_ACCOUNT_FILE =
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE || "gen-lang-client.json";
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || "";
const MONGODB_URI = applyUserMongoEnv(path.resolve(__dirname, ".."));
const MODES = ["autoApply", "manualApply"];
const CONCURRENCY = Math.max(
    1,
    Number.parseInt(process.env.BACKFILL_CONCURRENCY || "10", 10) || 10
);

if (ROOT_FOLDER_IDS.length === 0) {
    console.error("[backfill] ERROR: GOOGLE_DRIVE_ROOT_FOLDER_ID not set");
    process.exit(1);
}
if (!MONGODB_URI) {
    console.error(`[backfill] ERROR: ${getMongoEnvHint(path.resolve(__dirname, ".."))} not set`);
    process.exit(1);
}

// ── ATS detection (mirrors detectAts in resumeDashboardIndex.ts) ──────────────

const ATS_PATTERNS = [
    { pattern: /myworkdayjobs\.com/i, atsId: "workday" },
    { pattern: /myworkdaysite\.com/i, atsId: "workday" },
    { pattern: /boards\.greenhouse\.io/i, atsId: "greenhouse" },
    { pattern: /job-boards\.greenhouse\.io/i, atsId: "greenhouse" },
    { pattern: /lever\.co/i, atsId: "lever" },
    { pattern: /ashbyhq\.com/i, atsId: "ashby" },
    { pattern: /smartrecruiters\.com/i, atsId: "smartrecruiters" },
    { pattern: /icims\.com/i, atsId: "icims" },
    { pattern: /taleo\.net/i, atsId: "taleo" },
];

function detectAts(jobUrl) {
    try {
        const { hostname } = new URL(jobUrl);
        for (const { pattern, atsId } of ATS_PATTERNS) {
            if (pattern.test(hostname)) return atsId;
        }
    } catch { }
    return "unknown";
}

// ── Drive helpers ─────────────────────────────────────────────────────────────

async function loadCredentials() {
    if (SERVICE_ACCOUNT_JSON) {
        try {
            const parsed = JSON.parse(SERVICE_ACCOUNT_JSON);
            if (parsed.client_email && parsed.private_key) return parsed;
        } catch { }
    }
    const resolved = path.isAbsolute(SERVICE_ACCOUNT_FILE)
        ? SERVICE_ACCOUNT_FILE
        : path.resolve(process.cwd(), SERVICE_ACCOUNT_FILE);
    const raw = await readFile(resolved, "utf8");
    return JSON.parse(raw);
}

function escapeDriveQueryValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(err) {
    const s = err?.code || err?.response?.status;
    return s === 403 || s === 429 || (typeof s === "number" && s >= 500);
}

async function withBackoff(fn, retries = 5) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!isRetryable(err) || attempt >= retries) throw err;
            const delay = Math.min(
                1000 * 2 ** attempt + Math.floor(Math.random() * 500),
                32000
            );
            await sleep(delay);
        }
    }
}

async function listChildFolders(drive, parentId) {
    const escaped = escapeDriveQueryValue(parentId);
    const q =
        `mimeType = 'application/vnd.google-apps.folder' ` +
        `and trashed = false ` +
        `and '${escaped}' in parents`;
    const items = [];
    let pageToken = undefined;
    do {
        const res = await withBackoff(() =>
            drive.files.list({
                q,
                fields: "nextPageToken, files(id, name)",
                pageSize: 1000,
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
                ...(pageToken ? { pageToken } : {}),
            })
        );
        for (const f of res.data.files || []) {
            items.push({ id: f.id, name: f.name });
        }
        pageToken = res.data.nextPageToken;
    } while (pageToken);
    return items;
}

async function listFiles(drive, folderId) {
    const escaped = escapeDriveQueryValue(folderId);
    const q = `trashed = false and '${escaped}' in parents`;
    const files = [];
    let pageToken = undefined;
    do {
        const res = await withBackoff(() =>
            drive.files.list({
                q,
                fields: "nextPageToken, files(id, name, mimeType)",
                pageSize: 1000,
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
                ...(pageToken ? { pageToken } : {}),
            })
        );
        for (const f of res.data.files || []) {
            files.push({ id: f.id, name: f.name, mimeType: f.mimeType });
        }
        pageToken = res.data.nextPageToken;
    } while (pageToken);
    return files;
}

async function downloadFileContent(drive, fileId) {
    const res = await withBackoff(() =>
        drive.files.get(
            { fileId, alt: "media", supportsAllDrives: true },
            { responseType: "arraybuffer" }
        )
    );
    return Buffer.from(res.data);
}

// ── Concurrency limiter ───────────────────────────────────────────────────────

async function runWithConcurrency(items, limit, worker) {
    let idx = 0;
    async function runner() {
        while (true) {
            const i = idx++;
            if (i >= items.length) return;
            await worker(items[i], i);
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, () => runner())
    );
}

// ── Mongo models (loose schemas — script doesn't need strict typing) ──────────

const ResumeDashboardItemSchema = new mongoose.Schema(
    {
        mode: String,
        email: String,
        folder: String,
        jobUrl: String,
        jobUrlLower: { type: String, index: true },
        ats: String,
        title: { type: String, default: "" },
        company: { type: String, default: "" },
        pdfFile: { type: String, default: "" },
        createdAt: { type: Date, index: true },
        postedAt: { type: String, default: "" },
    },
    { collection: "resumedashboarditems" }
);
ResumeDashboardItemSchema.index({ mode: 1, email: 1, folder: 1 }, { unique: true });
ResumeDashboardItemSchema.index({ email: 1, mode: 1 });

const AutoApplyJobSchema = new mongoose.Schema({}, { strict: false, collection: "autoapplyjobs" });
const JobSchema = new mongoose.Schema({}, { strict: false, collection: "jobs" });

const ResumeDashboardItem =
    mongoose.models.ResumeDashboardItem ||
    mongoose.model("ResumeDashboardItem", ResumeDashboardItemSchema);
const AutoApplyJob =
    mongoose.models.AutoApplyJob ||
    mongoose.model("AutoApplyJob", AutoApplyJobSchema);
const Job =
    mongoose.models.Job ||
    mongoose.model("Job", JobSchema);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`[backfill] Starting${DRY_RUN ? " (DRY RUN — no writes)" : ""}`);
    console.log(`[backfill] Concurrency: ${CONCURRENCY}`);

    // Connect to MongoDB
    await mongoose.connect(MONGODB_URI);
    console.log("[backfill] Connected to MongoDB");

    // Build Drive client (read-only scope)
    const creds = await loadCredentials();
    const auth = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const drive = google.drive({ version: "v3", auth });
    console.log("[backfill] Drive client ready");

    // ── Walk Drive tree ───────────────────────────────────────────────────────
    const jobFolderTasks = [];

    for (const rootFolderId of ROOT_FOLDER_IDS) {
        for (const mode of MODES) {
            const rootChildren = await listChildFolders(drive, rootFolderId);
            const modeEntry = rootChildren.find((f) => f.name === mode);
            if (!modeEntry) {
                console.log(`[backfill] Mode folder '${mode}' not found under Drive root ${rootFolderId} — skipping`);
                continue;
            }

            const emailFolders = await listChildFolders(drive, modeEntry.id);
            console.log(
                `[backfill] root=${rootFolderId} '${mode}': found ${emailFolders.length} email folder(s)`
            );

            for (const emailEntry of emailFolders) {
                const jobFolders = await listChildFolders(drive, emailEntry.id);
                for (const jf of jobFolders) {
                    jobFolderTasks.push({
                        mode,
                        email: emailEntry.name, // already normalized as stored in Drive
                        folderId: jf.id,
                        folderName: jf.name,
                    });
                }
            }
        }
    }

    console.log(`[backfill] Total job folders to process: ${jobFolderTasks.length}`);
    if (jobFolderTasks.length === 0) {
        console.log("[backfill] Nothing to backfill.");
        await mongoose.disconnect();
        return;
    }

    const stats = { scanned: 0, inserted: 0, updated: 0, skipped: 0, failed: 0 };

    await runWithConcurrency(
        jobFolderTasks,
        CONCURRENCY,
        async ({ mode, email, folderId, folderName }) => {
            stats.scanned++;
            try {
                const files = await listFiles(drive, folderId);
                const metaFile = files.find((f) => f.name === "meta.json");
                const pdfFileEntry = files.find(
                    (f) => f.mimeType === "application/pdf" || f.name.endsWith(".pdf")
                );
                const pdfFileName = pdfFileEntry?.name || "";

                // ── Resolve jobUrl + createdAt ────────────────────────────────
                let jobUrl = "";
                let createdAt = null;

                if (metaFile) {
                    try {
                        const buf = await downloadFileContent(drive, metaFile.id);
                        const meta = JSON.parse(buf.toString("utf8"));
                        jobUrl = meta.jobUrl || "";
                        createdAt = meta.createdAt ? new Date(meta.createdAt) : null;
                    } catch { /* fall through to job-url.txt */ }
                }

                if (!jobUrl) {
                    const jobUrlFile = files.find((f) => f.name === "job-url.txt");
                    if (jobUrlFile) {
                        try {
                            const buf = await downloadFileContent(drive, jobUrlFile.id);
                            jobUrl = buf.toString("utf8").trim();
                        } catch { /* skip */ }
                    }
                }

                if (!jobUrl) {
                    stats.skipped++;
                    return;
                }

                const jobUrlLower = jobUrl.toLowerCase();
                const ats = detectAts(jobUrl);
                const urlVariants = [...new Set([jobUrl, jobUrlLower])];

                // ── Enrich title / company / postedAt from Mongo ──────────────
                let title = "";
                let company = "";
                let postedAt = "";

                const trackerDoc = await AutoApplyJob.findOne(
                    { jobUrl: { $in: urlVariants } },
                    { title: 1, company: 1 }
                ).lean();
                if (trackerDoc) {
                    title = trackerDoc.title || "";
                    company = trackerDoc.company || "";
                }

                if (!title || !company || !postedAt) {
                    const jobDoc = await Job.findOne(
                        { applyLink: { $in: urlVariants } },
                        { title: 1, company: 1, postedAt: 1 }
                    ).lean();
                    if (jobDoc) {
                        if (!title) title = jobDoc.title || "";
                        if (!company) company = jobDoc.company || "";
                        if (!postedAt && jobDoc.postedAt) {
                            postedAt = new Date(jobDoc.postedAt).toISOString();
                        }
                    }
                }

                const doc = {
                    mode,
                    email,
                    folder: folderName,
                    jobUrl,
                    jobUrlLower,
                    ats,
                    title,
                    company,
                    pdfFile: pdfFileName,
                    createdAt: createdAt || new Date(),
                    postedAt,
                };

                if (DRY_RUN) {
                    console.log(
                        `[dry-run] Would upsert: ${mode}/${email}/${folderName} | ${jobUrl}`
                    );
                    stats.inserted++;
                    return;
                }

                // findOneAndUpdate returns the OLD doc (new: false) — null means insert
                const existing = await ResumeDashboardItem.findOneAndUpdate(
                    { mode, email, folder: folderName },
                    { $set: doc },
                    { upsert: true, returnDocument: "before" }
                ).lean();

                if (existing) {
                    stats.updated++;
                } else {
                    stats.inserted++;
                }
            } catch (err) {
                stats.failed++;
                console.error(
                    `[backfill] FAILED: ${mode}/${email}/${folderName}: ${err?.message || err}`
                );
            }

            if (stats.scanned % 50 === 0 || stats.scanned === jobFolderTasks.length) {
                const total = jobFolderTasks.length;
                console.log(
                    `[backfill] scanned=${stats.scanned}/${total} inserted=${stats.inserted} updated=${stats.updated} skipped=${stats.skipped} failed=${stats.failed}`
                );
            }
        }
    );

    console.log(
        `[backfill] Done!  scanned=${stats.scanned}  inserted=${stats.inserted}  updated=${stats.updated}  skipped=${stats.skipped}  failed=${stats.failed}`
    );
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error("[backfill] Fatal:", err);
    process.exit(1);
});
