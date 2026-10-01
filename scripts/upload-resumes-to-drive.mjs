#!/usr/bin/env node
/**
 * Bulk upload all locally-generated resumes to Google Drive.
 *
 * Mirrors the local structure:
 *   generated-resumes/{mode}/{email}/{folderName}/*
 * -> Drive:
 *   {GOOGLE_DRIVE_ROOT_FOLDER_ID}/{mode}/{email}/{folderName}/*
 *
 * Usage:
 *   node scripts/upload-resumes-to-drive.mjs
 *   node scripts/upload-resumes-to-drive.mjs --dry-run
 *
 * Optional env:
 *   GOOGLE_DRIVE_ROOT_FOLDER_ID=...
 *   GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE=gen-lang-client.json
 *   GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON='{"client_email":"...","private_key":"..."}'
 *   GOOGLE_DRIVE_UPLOAD_CONCURRENCY=6
 *   GOOGLE_DRIVE_MAKE_PUBLIC=true
 *
 * Behavior:
 *   - Skips files that already exist in the target Drive folder by exact file name
 *   - Does not try to upload skipped files again
 *   - Prints global progress: total, done, remaining
 */

import { readdir, readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

// ── Config ────────────────────────────────────────────────────────────────────

async function loadEnv() {
    const envPath = path.resolve(__dirname, "../.env.local");
    try {
        const raw = await readFile(envPath, "utf8");
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;

            const [key, ...rest] = trimmed.split("=");
            const value = rest.join("=").replace(/^["']|["']$/g, "");

            if (key && !process.env[key]) process.env[key] = value;
        }
    } catch {
        // .env.local not found. Rely on shell env.
    }
}

await loadEnv();

const GENERATED_RESUMES_ROOT = path.resolve(__dirname, "../generated-resumes");
const DRY_RUN = process.argv.includes("--dry-run");
const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || "";
const SERVICE_ACCOUNT_FILE =
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE || "gen-lang-client.json";
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || "";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

const UPLOAD_CONCURRENCY = Math.max(
    1,
    Number.parseInt(process.env.GOOGLE_DRIVE_UPLOAD_CONCURRENCY || "50", 50) || 50
);

const MAKE_PUBLIC = /^(1|true|yes)$/i.test(
    String(process.env.GOOGLE_DRIVE_MAKE_PUBLIC || "")
);

if (!ROOT_FOLDER_ID) {
    console.error("[upload] ERROR: GOOGLE_DRIVE_ROOT_FOLDER_ID not set");
    process.exit(1);
}

// ── Load googleapis ───────────────────────────────────────────────────────────

const { google } = _require("googleapis");

// ── Service account ───────────────────────────────────────────────────────────

async function loadCredentials() {
    if (SERVICE_ACCOUNT_JSON) {
        try {
            const parsed = JSON.parse(SERVICE_ACCOUNT_JSON);
            if (parsed.client_email && parsed.private_key) return parsed;
        } catch {
            // Fall through to file-based credentials.
        }
    }

    const resolved = path.isAbsolute(SERVICE_ACCOUNT_FILE)
        ? SERVICE_ACCOUNT_FILE
        : path.resolve(process.cwd(), SERVICE_ACCOUNT_FILE);

    const raw = await readFile(resolved, "utf8");
    return JSON.parse(raw);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeDriveQueryValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function normalizeEmailFolder(email) {
    return (
        String(email || "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9@._-]/g, "_") || "unknown-email"
    );
}

function mimeFor(fileName) {
    if (fileName.endsWith(".pdf")) return "application/pdf";
    if (fileName.endsWith(".json")) return "application/json";
    if (fileName.endsWith(".txt")) return "text/plain";
    if (fileName.endsWith(".md")) return "text/markdown";
    return "application/octet-stream";
}

function isRetryableError(err) {
    const status = err?.code || err?.response?.status;
    return status === 403 || status === 429 || status >= 500;
}

async function withBackoff(fn, retries = 5) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!isRetryableError(err) || attempt >= retries) throw err;

            const delay = Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 500), 32000);
            await sleep(delay);
        }
    }
}

async function runWithConcurrency(items, limit, worker) {
    let index = 0;

    async function runner() {
        while (true) {
            const current = index++;
            if (current >= items.length) return;
            await worker(items[current], current);
        }
    }

    const workers = Array.from(
        { length: Math.min(limit, items.length) },
        () => runner()
    );

    await Promise.all(workers);
}

function createProgressTracker(totalLocalFiles) {
    return {
        totalLocalFiles,
        doneLocalFiles: 0,
        uploadedFiles: 0,
        skippedFiles: 0,
        failedFiles: 0,
    };
}

function printProgress(progress, prefix = "[progress]") {
    const remaining = Math.max(0, progress.totalLocalFiles - progress.doneLocalFiles);
    console.error(
        `${prefix} total=${progress.totalLocalFiles} done=${progress.doneLocalFiles} remaining=${remaining} uploaded=${progress.uploadedFiles} skipped=${progress.skippedFiles} failed=${progress.failedFiles}`
    );
}

// ── Drive helpers ─────────────────────────────────────────────────────────────

const folderCache = new Map(); // "parentId|name" -> folderId
const publicFolderCache = new Set(); // folderId

async function ensureFolder(drive, name, parentId) {
    const cacheKey = `${parentId}|${name}`;
    if (folderCache.has(cacheKey)) return folderCache.get(cacheKey);

    const escapedName = escapeDriveQueryValue(name);
    const q =
        `mimeType = 'application/vnd.google-apps.folder' ` +
        `and trashed = false ` +
        `and name = '${escapedName}' ` +
        `and '${parentId}' in parents`;

    const found = await withBackoff(() =>
        drive.files.list({
            q,
            fields: "files(id)",
            pageSize: 1,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        })
    );

    let id = found.data.files?.[0]?.id;

    if (!id) {
        const created = await withBackoff(() =>
            drive.files.create({
                requestBody: {
                    name,
                    mimeType: "application/vnd.google-apps.folder",
                    parents: [parentId],
                },
                fields: "id",
                supportsAllDrives: true,
            })
        );
        id = created.data.id;
    }

    if (!id) {
        throw new Error(`Failed to ensure folder "${name}" under parent "${parentId}"`);
    }

    folderCache.set(cacheKey, id);
    return id;
}

async function ensureFolderPublicReadable(drive, folderId) {
    if (!MAKE_PUBLIC) return;
    if (publicFolderCache.has(folderId)) return;

    const permissions = await withBackoff(() =>
        drive.permissions.list({
            fileId: folderId,
            fields: "permissions(id,type,role)",
            supportsAllDrives: true,
        })
    );

    const alreadyPublic = (permissions.data.permissions || []).some(
        (p) => p.type === "anyone" && p.role === "reader"
    );

    if (!alreadyPublic) {
        await withBackoff(() =>
            drive.permissions.create({
                fileId: folderId,
                requestBody: { type: "anyone", role: "reader" },
                supportsAllDrives: true,
            })
        );
    }

    publicFolderCache.add(folderId);
}

async function listFilesByName(drive, folderId) {
    const filesByName = new Map();
    let pageToken = undefined;

    do {
        const res = await withBackoff(() =>
            drive.files.list({
                q: `trashed = false and '${folderId}' in parents`,
                fields: "nextPageToken, files(id, name)",
                pageSize: 1000,
                pageToken,
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
            })
        );

        for (const file of res.data.files || []) {
            if (file.name && file.id) filesByName.set(file.name, file.id);
        }

        pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);

    return filesByName;
}

async function createFile(drive, folderId, fileName, filePath) {
    const media = {
        mimeType: mimeFor(fileName),
        body: fs.createReadStream(filePath),
    };

    const created = await withBackoff(() =>
        drive.files.create({
            requestBody: {
                name: fileName,
                parents: [folderId],
            },
            media,
            fields: "id",
            supportsAllDrives: true,
        })
    );

    return created.data.id || null;
}

// ── Local scan ────────────────────────────────────────────────────────────────

async function scanLocalFolders() {
    const jobs = [];
    let totalLocalFiles = 0;
    let totalLocalFolders = 0;

    let modeEntries;
    try {
        modeEntries = await readdir(GENERATED_RESUMES_ROOT, { withFileTypes: true });
    } catch {
        console.error(`[upload] ERROR: ${GENERATED_RESUMES_ROOT} does not exist`);
        process.exit(1);
    }

    for (const modeEntry of modeEntries) {
        if (!modeEntry.isDirectory()) continue;
        const mode = modeEntry.name;
        const modeDir = path.join(GENERATED_RESUMES_ROOT, mode);

        const emailEntries = await readdir(modeDir, { withFileTypes: true }).catch(() => []);
        for (const emailEntry of emailEntries) {
            if (!emailEntry.isDirectory()) continue;
            const email = emailEntry.name;
            const emailDir = path.join(modeDir, email);

            const folderEntries = await readdir(emailDir, { withFileTypes: true }).catch(() => []);
            for (const folderEntry of folderEntries) {
                if (!folderEntry.isDirectory()) continue;
                const folderName = folderEntry.name;
                const folderPath = path.join(emailDir, folderName);

                const fileEntries = await readdir(folderPath, { withFileTypes: true }).catch(() => []);
                const fileNames = fileEntries
                    .filter((entry) => entry.isFile())
                    .map((entry) => entry.name);

                jobs.push({
                    mode,
                    email,
                    normalizedEmail: normalizeEmailFolder(email),
                    folderName,
                    folderPath,
                    fileNames,
                });

                totalLocalFiles += fileNames.length;
                totalLocalFolders += 1;
            }
        }
    }

    return { jobs, totalLocalFiles, totalLocalFolders };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.error(`[upload] Root folder  : ${ROOT_FOLDER_ID}`);
    console.error(`[upload] Local root   : ${GENERATED_RESUMES_ROOT}`);
    console.error(`[upload] Concurrency  : ${UPLOAD_CONCURRENCY}`);
    console.error(`[upload] Make public  : ${MAKE_PUBLIC ? "yes" : "no"}`);

    if (DRY_RUN) {
        console.error("[upload] *** DRY RUN. No files will be uploaded. ***");
    }

    const { jobs, totalLocalFiles, totalLocalFolders } = await scanLocalFolders();
    const progress = createProgressTracker(totalLocalFiles);

    console.error(`[upload] Folders found: ${totalLocalFolders}`);
    console.error(`[upload] Files found  : ${totalLocalFiles}`);
    printProgress(progress);

    const creds = await loadCredentials();

    let drive = null;
    if (!DRY_RUN) {
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: creds.client_email,
                private_key: creds.private_key,
            },
            scopes: [DRIVE_SCOPE],
        });

        drive = google.drive({ version: "v3", auth });
    }

    let processedFolders = 0;
    let folderErrors = 0;

    for (const job of jobs) {
        processedFolders += 1;

        const { mode, email, normalizedEmail, folderName, folderPath, fileNames } = job;

        console.error(
            `\n[upload] Folder ${processedFolders}/${totalLocalFolders}: ${mode}/${email}/${folderName} (${fileNames.length} local files)`
        );

        if (fileNames.length === 0) {
            console.error("  → no local files");
            continue;
        }

        if (DRY_RUN) {
            for (const fileName of fileNames) {
                progress.doneLocalFiles += 1;
                console.error(`  [dry] ${fileName}`);
                printProgress(progress, "  [dry-progress]");
            }
            continue;
        }

        try {
            const modeFolderId = await ensureFolder(drive, mode, ROOT_FOLDER_ID);
            const emailFolderId = await ensureFolder(drive, normalizedEmail, modeFolderId);
            const jobFolderId = await ensureFolder(drive, folderName, emailFolderId);

            await ensureFolderPublicReadable(drive, jobFolderId);

            const existingFiles = await listFilesByName(drive, jobFolderId);

            const toUpload = [];
            let folderSkipped = 0;
            let folderUploaded = 0;
            let folderFailed = 0;

            for (const fileName of fileNames) {
                if (existingFiles.has(fileName)) {
                    progress.doneLocalFiles += 1;
                    progress.skippedFiles += 1;
                    folderSkipped += 1;
                    console.error(`  ⏭ skip already uploaded: ${fileName}`);
                    printProgress(progress, "  [progress]");
                } else {
                    toUpload.push(fileName);
                }
            }

            if (toUpload.length === 0) {
                console.error(`  → all files already uploaded, skipped=${folderSkipped}`);
                continue;
            }

            console.error(
                `  → need upload=${toUpload.length}, skipped already uploaded=${folderSkipped}`
            );

            await runWithConcurrency(toUpload, UPLOAD_CONCURRENCY, async (fileName) => {
                const filePath = path.join(folderPath, fileName);

                try {
                    const uploadedId = await createFile(drive, jobFolderId, fileName, filePath);
                    if (uploadedId) existingFiles.set(fileName, uploadedId);

                    progress.doneLocalFiles += 1;
                    progress.uploadedFiles += 1;
                    folderUploaded += 1;

                    console.error(`  ✅ uploaded: ${fileName}`);
                    printProgress(progress, "  [progress]");
                } catch (err) {
                    progress.doneLocalFiles += 1;
                    progress.failedFiles += 1;
                    folderFailed += 1;

                    console.error(
                        `  ❌ failed: ${fileName}: ${err instanceof Error ? err.message : String(err)}`
                    );
                    printProgress(progress, "  [progress]");
                }
            });

            console.error(
                `  → folder summary: uploaded=${folderUploaded} skipped=${folderSkipped} failed=${folderFailed}`
            );
        } catch (err) {
            folderErrors += 1;

            console.error(
                `  ❌ Folder error: ${err instanceof Error ? err.message : String(err)}`
            );

            // Count all files in this folder as done+failed only if we never got to process them.
            // We only do that for files that are not already counted.
            const remainingInThisFolder = Math.max(0, fileNames.length - (
                progress.doneLocalFiles > 0 ? 0 : 0
            ));

            // Safer approach. Count only the files in this folder that are still not accounted for.
            // We infer by comparing previous totals for this folder execution.
            // Since this catch is at folder level, and some files may have already been skipped before failure,
            // we do not try to guess partial uploads here.
            // We just continue, leaving already-counted files untouched.

            // No-op on counters here on purpose.
        }
    }

    console.error("\n[upload] ===== Final summary =====");
    console.error(`[upload] Total local files : ${progress.totalLocalFiles}`);
    console.error(`[upload] Done              : ${progress.doneLocalFiles}`);
    console.error(
        `[upload] Remaining         : ${Math.max(0, progress.totalLocalFiles - progress.doneLocalFiles)}`
    );
    console.error(`[upload] Uploaded          : ${progress.uploadedFiles}`);
    console.error(`[upload] Skipped existing  : ${progress.skippedFiles}`);
    console.error(`[upload] Failed            : ${progress.failedFiles}`);
    console.error(`[upload] Folder errors     : ${folderErrors}`);
}

main().catch((err) => {
    console.error(`[upload] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});