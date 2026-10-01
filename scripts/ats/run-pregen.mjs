#!/usr/bin/env node

/**
 * Continuous Resume Generation Daemon (Latest-Job First).
 *
 * Supports two strategies:
 * 1. mode=tailor (default):
 *    Monitors gptService (port 4000) capacity and claims the latest pending job
 *    to generate a customized LaTeX resume via ChatGPT.
 *
 * 2. mode=select:
 *    Claims the latest pending job, evaluates N pre-crafted candidate resumes
 *    from data_<user>/resumes/ using Google Gemini LLM, compiles LaTeX, uploads
 *    to Google Drive, and indexes in MongoDB via POST /api/resume.
 *
 * Both modes run as a continuous daemon (while true), always picking the newest
 * job (postedAt: -1) as workers become available and instantly picking up newly
 * scraped jobs.
 *
 * Dead Job Handling:
 * Automatically detects Workday expired, Greenhouse 404, or dead links, and
 * marks them as SKIPPED and inactive in MongoDB so neither resume generation
 * nor auto-apply ever touches them again.
 *
 * Usage:
 *   npm run pregen -- <email> [mode=tailor|select] [ats=workday|greenhouse|all] [once=true] [limit=N]
 *   npm run pregen:select -- <email> [ats=workday|greenhouse|all] [once=true] [limit=N]
 *
 * Examples:
 *   npm run pregen -- niharpatel230304@gmail.com
 *   npm run pregen:select -- niharpatel230304@gmail.com
 *   npm run pregen:select -- niharpatel230304@gmail.com limit=10
 *   npm run pregen -- niharpatel230304@gmail.com once=true
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDataPath, getJobtrackOrigin, loadUserEnv } from "../lib/user-config.mjs";
import { chooseBestResume } from "../../gptService/resume-decide-service/resume-decide-llm-client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..");

// Ensure user environment files (.env.local, .env.<user>.local) are loaded
loadUserEnv(projectRoot);

const ORIGIN = getJobtrackOrigin();
const GENERATE_LATEX_ORIGIN = process.env.GENERATE_LATEX_ORIGIN || "http://localhost:4000";

// ── ATS URL matchers ──────────────────────────────────────────────────────────

const WORKDAY_SUFFIXES = [".myworkdayjobs.com", ".myworkdaysite.com"];
const GREENHOUSE_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io"]);

function isWorkdayUrl(rawUrl) {
    try {
        const { hostname } = new URL(String(rawUrl || ""));
        return WORKDAY_SUFFIXES.some((s) => hostname.toLowerCase().endsWith(s));
    } catch { return false; }
}

function isGreenhouseUrl(rawUrl) {
    try {
        const { hostname } = new URL(String(rawUrl || ""));
        return GREENHOUSE_HOSTS.has(hostname.toLowerCase());
    } catch { return false; }
}

function isAtsMatch(rawUrl, ats) {
    if (ats === "workday") return isWorkdayUrl(rawUrl);
    if (ats === "greenhouse") return isGreenhouseUrl(rawUrl);
    // "all" — match any supported ATS
    return isWorkdayUrl(rawUrl) || isGreenhouseUrl(rawUrl);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function parseBoolArg(args, key, defaultValue = false) {
    const raw = args.find((a) => new RegExp(`^${key}=`, "i").test(a));
    if (!raw) return defaultValue;
    return String(raw.split("=")[1] || "").trim().toLowerCase() === "true";
}

function normalizeUrl(job) {
    return String(job?.applyLink || "").trim();
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

function getJobrightJobId(...values) {
    const value = values.map((v) => String(v || "").trim()).find(Boolean) || "";
    return /^[a-f0-9]{24}$/i.test(value) ? value : null;
}

async function httpJson(url, init = undefined) {
    const res = await fetch(url, init);
    const text = await res.text().catch(() => "");
    let json = null;
    if (text) {
        try { json = JSON.parse(text); } catch { json = { raw: text }; }
    }
    return { res, json };
}

// ── API Helpers for Continuous Pull & Dead Job Pruning ────────────────────────

async function claimResumeJob({ email, ats, notEligible, excludeUrls, dateFilter }) {
    const { res, json } = await httpJson(`${ORIGIN}/api/resume-claims/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, ats, notEligible, excludeUrls, dateFilter, sinceDate: dateFilter }),
    });
    if (!res.ok) throw new Error(`resume_claim_failed:${res.status}:${json?.error || "unknown"}`);
    return json;
}

async function releaseResumeClaim(jobUrl) {
    try {
        await httpJson(`${ORIGIN}/api/resume-claims/claim`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ releaseUrl: jobUrl }),
        });
    } catch { /* ignore */ }
}

async function resetAllResumeClaims() {
    try {
        const { res, json } = await httpJson(`${ORIGIN}/api/resume-claims/claim`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ resetAll: true }),
        });
        if (res.ok && json?.success && json.resetCount > 0) {
            console.error(`[pregen] 🔄 Cleared ${json.resetCount} stale in-flight claim lease(s) from previous run.`);
        }
    } catch { /* ignore */ }
}

async function markJobSkipped({ jobId, jobUrl, error }) {
    try {
        await httpJson(`${ORIGIN}/api/auto-apply-tracker/save`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jobId: jobId || "",
                jobUrl,
                success: false,
                error: String(error || "dead_job_skipped"),
            }),
        });
    } catch (err) {
        console.error(`[pregen] failed to mark skipped ${jobUrl}: ${err.message}`);
    }
}

async function checkGptServiceHealth() {
    try {
        const { res, json } = await httpJson(`${GENERATE_LATEX_ORIGIN}/health`, {
            signal: AbortSignal.timeout(4000),
        });
        if (res.ok && json?.ok) {
            const workerCount = json.workerCount || 1;
            const busyWorkers = json.busyWorkers ?? 0;
            const idleWorkers = json.idleWorkers ?? Math.max(0, workerCount - busyWorkers);
            return {
                ok: true,
                queueLength: json.queueLength || 0,
                workerCount,
                busyWorkers,
                idleWorkers,
                workers: json.workers || [],
            };
        }
        return { ok: false };
    } catch {
        return { ok: false };
    }
}

async function enqueueToGptService(job) {
    const { res, json } = await httpJson(`${GENERATE_LATEX_ORIGIN}/generate-latex`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jobUrl: job.url,
            jobrightJobId: job.jobrightJobId,
            postedAt: job.postedAt,
            title: job.title,
            company: job.company,
        }),
        signal: AbortSignal.timeout(30_000),
    });
    return {
        ok: Boolean(res.ok),
        position: json?.position || 1,
        error: json?.error || json?.message || `HTTP ${res.status}`,
    };
}

async function saveResumeViaApi({ jobUrl, latex, mode = "autoApply" }) {
    let { res, json } = await httpJson(`${ORIGIN}/api/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobUrl, latex, mode }),
        signal: AbortSignal.timeout(90_000),
    });

    if ((!res.ok || json?.success === false) && (res.status === 502 || res.status === 503)) {
        await sleep(2000);
        const retry = await httpJson(`${ORIGIN}/api/resume`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobUrl, latex, mode }),
            signal: AbortSignal.timeout(90_000),
        });
        res = retry.res;
        json = retry.json;
    }

    if (res.ok && json?.success !== false) {
        return { ok: true, folderName: json?.folderName };
    }
    return { ok: false, error: json?.error || json?.details || `HTTP ${res.status}` };
}

// ── Candidate Resumes Discovery (mode=select) ─────────────────────────────────

export function loadCandidateResumes(root = projectRoot) {
    let baseDir = getDataPath(root, "resumes");
    if (!fs.existsSync(baseDir)) {
        const alt = getDataPath(root, "resume");
        if (fs.existsSync(alt) && fs.statSync(alt).isDirectory()) {
            baseDir = alt;
        }
    }

    if (!fs.existsSync(baseDir)) {
        return [];
    }

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const candidateFolders = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);

    candidateFolders.sort((a, b) => {
        const numA = parseInt(a.replace(/\D+/g, "") || "0", 10);
        const numB = parseInt(b.replace(/\D+/g, "") || "0", 10);
        if (numA && numB && numA !== numB) return numA - numB;
        return a.localeCompare(b);
    });

    const resumes = [];
    for (const folder of candidateFolders) {
        const folderPath = path.join(baseDir, folder);
        let texPath = path.join(folderPath, "resume.tex");
        if (!fs.existsSync(texPath)) {
            const files = fs.readdirSync(folderPath);
            const texFile = files.find((f) => f.endsWith(".tex"));
            if (texFile) texPath = path.join(folderPath, texFile);
        }

        let descPath = path.join(folderPath, "desc.txt");
        if (!fs.existsSync(descPath)) {
            const files = fs.readdirSync(folderPath);
            const descFile = files.find((f) => /^(desc|description)\.(txt|md)$/i.test(f));
            if (descFile) descPath = path.join(folderPath, descFile);
        }

        if (fs.existsSync(texPath)) {
            const descContent = fs.existsSync(descPath) ? fs.readFileSync(descPath, "utf8").trim() : "";
            resumes.push({
                id: folder,
                folderPath,
                texPath,
                descPath: fs.existsSync(descPath) ? descPath : null,
                desc: descContent,
            });
        }
    }

    return resumes;
}

// ── Job Description Resolver ──────────────────────────────────────────────────

async function resolveJobDescription(job, origin) {
    // 1. Try Jobright API endpoint via Jobtrack server if jobrightJobId is present
    if (job.jobrightJobId) {
        try {
            const { res, json } = await httpJson(`${origin}/api/job-description?jobId=${encodeURIComponent(job.jobrightJobId)}`);
            if (res.ok && json?.description) {
                return {
                    title: json.title || job.title,
                    description: json.description,
                    source: "jobright",
                };
            }
        } catch { /* fallback */ }
    }

    // 2. If Greenhouse job, scrape public career board page
    if (isGreenhouseUrl(job.url)) {
        try {
            const res = await fetch(job.url, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
                signal: AbortSignal.timeout(8_000),
            });

            if (res.status === 404 || res.status === 410) {
                throw new Error("greenhouse_page_not_found");
            }

            if (res.ok) {
                const html = await res.text();
                if (html.includes("Sorry, but we can't find that page.") || html.includes("404: Not Found")) {
                    throw new Error("greenhouse_page_not_found");
                }
                const bodyText = html
                    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
                    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
                    .replace(/<[^>]+>/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();
                if (bodyText.length > 100) {
                    return {
                        title: job.title,
                        description: bodyText.slice(0, 8000),
                        source: "greenhouse_web",
                    };
                }
            }
        } catch (err) {
            if (err.message === "greenhouse_page_not_found") throw err;
            /* fallback */
        }
    }

    // 3. Fallback: use structured qualifications and metadata from Mongo Job record
    const metaParts = [];
    if (job.title) metaParts.push(`Job Title: ${job.title}`);
    if (job.company) metaParts.push(`Company: ${job.company}`);
    if (job.qualifications) metaParts.push(`Qualifications:\n${job.qualifications}`);
    if (job.roleType) metaParts.push(`Role Type: ${job.roleType}`);
    if (job.jobFunction) metaParts.push(`Job Function: ${job.jobFunction}`);
    if (Array.isArray(job.industry) && job.industry.length > 0) metaParts.push(`Industry: ${job.industry.join(", ")}`);

    return {
        title: job.title,
        description: metaParts.join("\n\n"),
        source: "job_record",
    };
}

// ── Main Continuous Daemon Loop ───────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);

    const email = String(args.find((a) => isValidEmail(a)) || "").trim();
    if (!isValidEmail(email)) {
        console.error("Usage: npm run pregen -- <email> [mode=tailor|select] [ats=workday|greenhouse|all] [once=true] [limit=N]");
        console.error("Example (Tailored via ChatGPT): npm run pregen -- you@gmail.com ats=workday");
        console.error("Example (Selective via Gemini): npm run pregen:select -- you@gmail.com");
        process.exit(1);
    }

    const modeArg = args.find((a) => /^mode=/i.test(a));
    const modeRaw = modeArg ? String(modeArg).split("=")[1].trim().toLowerCase() : "tailor";
    const mode = ["select", "selective"].includes(modeRaw) ? "select" : "tailor";

    const atsArg = args.find((a) => /^ats=/i.test(a));
    const atsRaw = atsArg ? String(atsArg).split("=")[1].trim().toLowerCase() : "all";
    if (!["workday", "greenhouse", "all"].includes(atsRaw)) {
        console.error('Unknown ats value. Valid values: "workday", "greenhouse", "all"');
        process.exit(1);
    }
    const ats = atsRaw;
    const notEligible = parseBoolArg(args, "notEligible", true);
    const once = parseBoolArg(args, "once", false);

    const limitArg = args.find((a) => /^limit=\d+$/i.test(a));
    const latestArg = args.find((a) => /^latest(?:=\d+)?$/i.test(a));
    let maxJobs = null;
    if (limitArg) {
        maxJobs = parseInt(limitArg.split("=")[1], 10);
    } else if (latestArg && latestArg.includes("=")) {
        maxJobs = parseInt(latestArg.split("=")[1], 10);
    }

    const dateArg = args.find((a) => /^(?:since|after|retryAfter|minDate|dateFilter|sinceDate)=/i.test(a));
    const dateFilter = dateArg ? String(dateArg.split("=")[1] || "").trim() : "";

    console.error(`[pregen] 🚀 Resume Daemon | Mode: ${mode.toUpperCase()} | Email: ${email} | ATS: ${ats}${dateFilter ? ` | Date Filter: >= ${dateFilter}` : ""} | ${once ? "once" : maxJobs ? `limit=${maxJobs}` : "continuous"}`);

    // Always silently clear any stale in-flight claim leases on startup
    await resetAllResumeClaims();

    // If mode=select, discover candidate resumes first
    let candidateResumes = [];
    if (mode === "select") {
        candidateResumes = loadCandidateResumes(projectRoot);
        if (candidateResumes.length === 0) {
            const expectedPath = getDataPath(projectRoot, "resumes");
            console.error(`[pregen:select] ERROR: No candidate resumes found in ${expectedPath}`);
            console.error("Please create folders like:");
            console.error(`  ${expectedPath}/resume1/ (with resume.tex & desc.txt)`);
            console.error(`  ${expectedPath}/resume2/ (with resume.tex & desc.txt)`);
            process.exit(1);
        }
        console.error(`[pregen:select] Loaded ${candidateResumes.length} candidate resume(s): ${candidateResumes.map((r) => r.id).join(", ")}`);
    }

    const excludeUrls = new Set();
    let processedCount = 0;
    let consecutiveEmptyRuns = 0;
    let lastWorkerStatusLog = 0;

    while (true) {
        if (maxJobs && processedCount >= maxJobs) {
            console.error(`\n[pregen] Reached maximum limit of ${maxJobs} job(s). Done!`);
            break;
        }

        // If in mode === "tailor", monitor gptService capacity before claiming
        if (mode === "tailor") {
            const health = await checkGptServiceHealth();
            if (!health.ok) {
                console.error(`[pregen] ⏳ Waiting for gpt-service at ${GENERATE_LATEX_ORIGIN}...`);
                await sleep(5000);
                continue;
            }
            const idleWorkers = health.idleWorkers ?? Math.max(0, (health.workerCount || 1) - (health.busyWorkers || 0));
            // Strict Zero-Backlog: ONLY claim when a worker is genuinely idle and in-memory queue is empty!
            if (health.queueLength > 0 || idleWorkers <= 0) {
                const now = Date.now();
                if (now - lastWorkerStatusLog > 10000) {
                    lastWorkerStatusLog = now;
                    console.error(`\n[pregen] 📊 All workers busy (${health.workerCount} total, 0 idle):`);
                    if (health.workers && health.workers.length > 0) {
                        for (const w of health.workers) {
                            if (w.busy) {
                                const comp = w.company ? ` @ ${w.company}` : "";
                                const title = w.title ? `"${w.title}"` : "Job";
                                console.error(`  → [worker-${w.id}] ${title}${comp} | Status: ${w.status || "busy"} (${w.elapsedSec || 0}s)`);
                            } else {
                                console.error(`  → [worker-${w.id}] IDLE`);
                            }
                        }
                    }
                    console.error("");
                }
                await sleep(2000);
                continue;
            }
        }

        // Claim the latest job needing a resume
        let claimResult;
        try {
            claimResult = await claimResumeJob({
                email,
                ats,
                notEligible,
                excludeUrls: Array.from(excludeUrls),
                dateFilter,
            });
        } catch (claimErr) {
            console.error(`[pregen] Claim request error: ${claimErr.message}. Retrying in 5s...`);
            await sleep(5000);
            continue;
        }

        if (!claimResult?.claimed || !claimResult?.job) {
            consecutiveEmptyRuns++;
            if (once) {
                console.error(`[pregen] All currently available jobs have resumes. Done!`);
                break;
            }
            if (consecutiveEmptyRuns === 1 || consecutiveEmptyRuns % 4 === 0) {
                const withRes = claimResult?.stats?.alreadyHaveResume ?? 0;
                console.error(`[pregen] 💤 All current jobs have resumes (${withRes} indexed). Polling every 15s for newly scraped jobs...`);
            }
            await sleep(15000);
            continue;
        }

        consecutiveEmptyRuns = 0;
        const job = claimResult.job;
        const normUrl = normalizeComparableUrl(job.url);
        excludeUrls.add(normUrl);
        processedCount++;

        const postedStr = job.postedAt ? new Date(job.postedAt).toISOString().split("T")[0] : "recent";
        console.error(`\n[pregen] 🟢 #${processedCount} CLAIMED: ${job.company} — "${job.title}" (${job.atsId} | posted ${postedStr})`);

        if (mode === "select") {
            try {
                const t0 = Date.now();
                // Step 1: Resolve JD
                const { title, description } = await resolveJobDescription(job, ORIGIN);

                // Step 2: Choose best resume with Gemini LLM
                const decision = await chooseBestResume({
                    jobTitle: title || job.title,
                    company: job.company,
                    jobDescription: description,
                    candidateResumes,
                });
                const chosen = candidateResumes.find((r) => r.id === decision.chosenId) || candidateResumes[0];

                // Step 3: Save chosen resume
                let latexContent = fs.readFileSync(chosen.texPath, "utf8");
                if (email) {
                    const match = /\\href\{mailto:([^}]+)\}/i.exec(latexContent);
                    if (match && match[1]) {
                        latexContent = latexContent.split(match[1].trim()).join(email);
                    }
                }

                const saveRes = await saveResumeViaApi({ jobUrl: job.url, latex: latexContent, mode: "autoApply" });
                const dur = ((Date.now() - t0) / 1000).toFixed(1);
                if (saveRes.ok) {
                    console.error(`         → Selected: [${chosen.id}] (${decision.confidence || "high"}) | Saved in ${dur}s ✓`);
                } else {
                    console.error(`         ✗ Upload failed: ${saveRes.error}`);
                    await releaseResumeClaim(job.url);
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                const isDead =
                    errMsg.includes("greenhouse_page_not_found") ||
                    errMsg.includes("workday_page_not_found") ||
                    errMsg.includes("dead_link") ||
                    errMsg.includes("404");

                if (isDead) {
                    console.error(`         ⚠️ Dead job skipped (${errMsg}) — marked inactive in DB`);
                    await markJobSkipped({ jobId: job.jobId, jobUrl: job.url, error: errMsg });
                } else {
                    console.error(`         ✗ Error: ${errMsg}`);
                    await releaseResumeClaim(job.url);
                }
            }
            await sleep(500);
        } else {
            // mode === "tailor": Enqueue to gptService
            try {
                const enq = await enqueueToGptService({
                    url: job.url,
                    jobrightJobId: job.jobrightJobId,
                    postedAt: job.postedAt,
                    title: job.title,
                    company: job.company,
                });
                if (enq.ok) {
                    console.error(`         → Dispatched to ChatGPT Worker (queue: ${enq.position || 0})`);
                } else {
                    console.error(`         ✗ Dispatch failed: ${enq.error}`);
                    await releaseResumeClaim(job.url);
                }
            } catch (err) {
                console.error(`         ✗ Dispatch error: ${err instanceof Error ? err.message : String(err)}`);
                await releaseResumeClaim(job.url);
            }
            await sleep(1000);
        }
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch((err) => {
        console.error(`[pregen] Fatal: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    });
}
