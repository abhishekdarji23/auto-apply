#!/usr/bin/env node

/**
 * Simple multi-laptop bulk apply worker.
 *
 * Flow per loop:
 * 1) ask server for exactly one available eligible job for this email
 * 2) run /api/auto-apply for that job
 * 3) repeat
 *
 * If no job is available, worker waits and retries, then exits after idle timeout.
 */

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { getDataDirName, getDataPath, getJobtrackOrigin } from "../lib/user-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
let ORIGIN = getJobtrackOrigin();
const IDLE_SLEEP_MS = Number(process.env.APPLY_CLAIM_IDLE_SLEEP_MS || 20 * 1000);
const EMPTY_EXIT_MS = process.env.APPLY_CLAIM_EMPTY_EXIT_MS ? Number(process.env.APPLY_CLAIM_EMPTY_EXIT_MS) : Infinity;
const DEFAULT_RESUME_TEX_PATH = getDataPath(PROJECT_ROOT, "resume.tex");
const DEFAULT_RESUME_JOB_URL = "https://auto-apply.local/default-resume";
let defaultResumeLatex = "";
let defaultResumeSave = null;

const ATS_TIMEOUT_MS = {
    workday: 13 * 60 * 1000,
    greenhouse: null,
};
const SUPPORTED_APPLY_ATS = new Set(Object.keys(ATS_TIMEOUT_MS));

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function formatMs(ms) {
    const min = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpJson(url, init = undefined) {
    const res = await fetch(url, init);
    const text = await res.text().catch(() => "");

    let json = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = { raw: text };
        }
    }

    return { res, json };
}

function parseBoolArg(args, key, defaultValue = false) {
    const raw = args.find((a) => new RegExp(`^${key}=`, "i").test(a));
    if (!raw) return defaultValue;
    const value = String(raw.split("=")[1] || "").trim().toLowerCase();
    return value === "true" || value === "yes" || value === "1";
}

function parseStringArg(args, key, defaultValue = "") {
    const raw = args.find((a) => new RegExp(`^${key}=`, "i").test(a));
    return raw ? String(raw.split("=")[1] || "").trim() : defaultValue;
}

function parseAtsArg(args) {
    const ats = parseStringArg(args, "ats", "all").toLowerCase();
    if (["all", "workday", "greenhouse"].includes(ats)) return ats;
    return null;
}

function normalizeComparableUrl(rawUrl) {
    const value = String(rawUrl || "").trim();
    if (!value) return "";

    try {
        const url = new URL(value);
        url.hash = "";

        const keepEntries = [];
        for (const [key, val] of url.searchParams.entries()) {
            if (key.toLowerCase().startsWith("utm_")) continue;
            keepEntries.push([key.toLowerCase(), val.toLowerCase()]);
        }

        keepEntries.sort((a, b) => {
            if (a[0] === b[0]) return a[1].localeCompare(b[1]);
            return a[0].localeCompare(b[0]);
        });

        url.search = "";
        for (const [key, val] of keepEntries) {
            url.searchParams.append(key, val);
        }

        return url.toString().toLowerCase();
    } catch {
        return value.toLowerCase();
    }
}

async function claimOne({ email, ats, retry, retryAfter, notEligible, excludeUrls, defaultResume }) {
    const { res, json } = await httpJson(`${ORIGIN}/api/apply-claims/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, ats, retry, retryAfter, notEligible, excludeUrls, defaultResume }),
    });

    if (!res.ok || !json?.success) {
        throw new Error(`claim_failed:${res.status}:${json?.error || "unknown"}`);
    }

    return json;
}

async function readDefaultResumeLatex() {
    if (defaultResumeLatex) return defaultResumeLatex;
    defaultResumeLatex = await readFile(DEFAULT_RESUME_TEX_PATH, "utf8");
    if (!defaultResumeLatex.trim()) {
        throw new Error(`${getDataDirName(PROJECT_ROOT)}/resume.tex is empty`);
    }
    return defaultResumeLatex;
}

async function defaultResumeAlreadyOnDrive() {
    const res = await fetch(`${ORIGIN}/api/resume/file?folder=defaultResume&download=1`, {
        method: "GET",
        signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    return Boolean(res?.ok);
}

async function ensureDefaultResumeSaved({ refresh = false } = {}) {
    if (defaultResumeSave && !refresh) return defaultResumeSave;

    if (!refresh && await defaultResumeAlreadyOnDrive()) {
        defaultResumeSave = { success: true, folderName: "defaultResume", reused: true };
        return defaultResumeSave;
    }

    const latex = await readDefaultResumeLatex();
    const { res, json } = await httpJson(`${ORIGIN}/api/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jobUrl: DEFAULT_RESUME_JOB_URL,
            latex,
            mode: "autoApply",
            defaultResume: true,
        }),
        signal: AbortSignal.timeout(180_000),
    });

    if (!res.ok || !json?.success) {
        const message = [json?.error, json?.details || json?.message]
            .filter(Boolean)
            .join(": ") || `HTTP ${res.status}`;
        throw new Error(`default_resume_save_failed:${message}`);
    }

    defaultResumeSave = json;
    return defaultResumeSave;
}

async function runAutoApplyOne(job, { defaultResume }) {
    if (!SUPPORTED_APPLY_ATS.has(String(job.atsId || ""))) {
        return {
            ok: false,
            status: 422,
            error: "unsupported_ats",
            ats: String(job.atsId || ""),
        };
    }

    const timeoutMs = ATS_TIMEOUT_MS[job.atsId] ?? null;
    try {
        const init = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobId: job.jobId, jobrightJobId: job.jobrightJobId, url: job.url, defaultResume }),
        };
        if (timeoutMs) init.signal = AbortSignal.timeout(timeoutMs);

        const { res, json } = await httpJson(`${ORIGIN}/api/auto-apply`, init);
        return {
            ok: Boolean(res.ok && json?.success),
            status: res.status,
            error: String(json?.error || ""),
            ats: String(json?.ats || job.atsId || ""),
        };
    } catch (error) {
        return {
            ok: false,
            status: 0,
            error: error instanceof Error ? error.message : String(error),
            ats: String(job.atsId || ""),
        };
    }
}

async function runWorker({ email, ats, retry, retryAfter, notEligible, defaultResume, refreshDefaultResume }) {
    console.error(`[ats-bulk-simple] Origin : ${ORIGIN}`);
    console.error(`[ats-bulk-simple] Email  : ${email}`);
    console.error(`[ats-bulk-simple] ATS    : ${ats}`);
    console.error(`[ats-bulk-simple] Retry  : ${retry}`);
    if (retryAfter) {
        console.error(`[ats-bulk-simple] Retry after : ${retryAfter}`);
    }
    console.error(`[ats-bulk-simple] Default resume : ${defaultResume ? `yes (${getDataDirName(PROJECT_ROOT)}/resume.tex)` : "no"}`);
    console.error(`[ats-bulk-simple] Include not eligible : ${notEligible === false}`);

    if (defaultResume) {
        console.error(`[ats-bulk-simple] defaultResume=yes — checking shared Drive resume...`);
        const saved = await ensureDefaultResumeSaved({ refresh: refreshDefaultResume });
        console.error(`[ats-bulk-simple] default resume ${saved.reused ? "reused" : "ready"}: ${saved.folderName || "defaultResume"}`);
    }

    let totalSuccess = 0;
    let totalFail = 0;
    let totalClaimed = 0;
    let idleSince = 0;
    const attemptedUrls = new Set();
    const startedAt = Date.now();

    while (true) {
        let claim;
        try {
            claim = await claimOne({
                email,
                ats,
                retry,
                retryAfter,
                notEligible,
                defaultResume,
                excludeUrls: [...attemptedUrls],
            });
        } catch (err) {
            console.error(`[ats-bulk-simple] claim error: ${err instanceof Error ? err.message : String(err)}`);
            await sleep(IDLE_SLEEP_MS);
            continue;
        }

        if (!claim.claimed || !claim.job) {
            if (!idleSince) idleSince = Date.now();
            const idleMs = Date.now() - idleSince;
            const stats = claim.stats || {};

            console.error(
                `[ats-bulk-simple] no job now | available=${Number(stats.availableJobs || 0)} candidates=${Number(stats.totalCandidates || 0)} noResume=${Number(stats.skippedByResume || 0)} trackerBlocked=${Number(stats.skippedByTracker || 0)}${stats.skippedByRetryDate ? ` retryDateBlocked=${stats.skippedByRetryDate}` : ""} triedThisRun=${Number(stats.attemptedThisRun || 0)} skipNotEligible=${stats.skipNotEligible !== false} idle=${formatMs(idleMs)}`
            );

            if (Number.isFinite(EMPTY_EXIT_MS) && idleMs >= EMPTY_EXIT_MS) {
                console.error(`[ats-bulk-simple] idle timeout reached (${formatMs(idleMs)}). exiting.`);
                break;
            }

            await sleep(IDLE_SLEEP_MS);
            continue;
        }

        idleSince = 0;
        totalClaimed += 1;

        const job = claim.job;
        const stats = claim.stats || {};
        console.error(
            `[ats-bulk-simple] pool now | picking 1 of ${Number(stats.availableJobs || 1)} available | candidates=${Number(stats.totalCandidates || 0)} noResume=${Number(stats.skippedByResume || 0)} trackerBlocked=${Number(stats.skippedByTracker || 0)}${stats.skippedByRetryDate ? ` retryDateBlocked=${stats.skippedByRetryDate}` : ""} triedThisRun=${Number(stats.attemptedThisRun || 0)}`
        );
        const jobCanonical = normalizeComparableUrl(job.url);
        if (jobCanonical) attemptedUrls.add(jobCanonical);
        const label = `${job.title || "(no title)"} @ ${job.company || "(no company)"}`;
        console.error(`\n[ats-bulk-simple] job #${totalClaimed} ats=${job.atsId}`);
        console.error(`[ats-bulk-simple] ${label}`);
        console.error(`[ats-bulk-simple] ${job.url}`);

        const started = Date.now();
        const result = await runAutoApplyOne(job, { defaultResume });
        const elapsed = formatMs(Date.now() - started);

        if (result.ok) {
            totalSuccess += 1;
            console.error(`[ats-bulk-simple] PASS ats=${result.ats || job.atsId} time=${elapsed}`);
        } else {
            totalFail += 1;
            console.error(`[ats-bulk-simple] FAIL status=${result.status} error=${result.error || "unknown"} time=${elapsed}`);
        }

        await sleep(800);
    }

    const totalMs = Date.now() - startedAt;
    console.error("\n[ats-bulk-simple] ─────────────────────────────");
    console.error(`[ats-bulk-simple] Done in ${formatMs(totalMs)}`);
    console.error(`[ats-bulk-simple] Claimed : ${totalClaimed}`);
    console.error(`[ats-bulk-simple] Success : ${totalSuccess}`);
    console.error(`[ats-bulk-simple] Failed  : ${totalFail}`);
}

async function main() {
    const args = process.argv.slice(2);

    const email = String(args.find((a) => isValidEmail(a)) || "").trim();
    if (!isValidEmail(email)) {
        console.error("Usage: npm run ats-bulk -- <email> [ats=workday|greenhouse|all] [retry=true|false] [retryAfter=YYYY-MM-DD] [notEligible=false] [defaultResume=yes]");
        process.exit(1);
    }

    const ats = parseAtsArg(args);
    if (!ats) {
        console.error('Unknown ats value. Valid values: "workday", "greenhouse", "all"');
        process.exit(1);
    }

    const retryAfter = parseStringArg(args, "retryAfter", parseStringArg(args, "retrySince", ""));
    const retry = parseBoolArg(args, "retry", Boolean(retryAfter));
    const notEligible = parseBoolArg(args, "notEligible", true);
    const defaultResume = parseBoolArg(args, "defaultResume", false);
    const refreshDefaultResume = parseBoolArg(args, "refreshDefaultResume", false);

    ORIGIN = getJobtrackOrigin(args);
    process.env.JOBTRACK_API_ORIGIN = ORIGIN;

    await runWorker({ email, ats, retry, retryAfter, notEligible, defaultResume, refreshDefaultResume });
}

main().catch((error) => {
    console.error(`[ats-bulk-simple] Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
