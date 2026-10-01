/* eslint-disable @typescript-eslint/no-require-imports */
const express = require("express");
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL: NodeURL } = require("url");
const { scrapeJobDetails } = require("./job-scraper");
const { readLatexResponseState } = require("./response-extractor");
const { loadUserEnv, getAppUser, getDataDirName, getDataPath } = require("../../scripts/lib/user-config.cjs");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
loadUserEnv(PROJECT_ROOT);

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.GPT_PORT || process.env.PORT || 4000;
const APP_USER = getAppUser(PROJECT_ROOT);
const DATA_DIR_NAME = getDataDirName(PROJECT_ROOT);
const RESUME_PATH = getDataPath(PROJECT_ROOT, "resume.tex");
const PROMPT_TEMPLATE_PATH = getDataPath(PROJECT_ROOT, "prompt-template.txt");
const CHATGPT_ACCOUNTS_PATH = getDataPath(PROJECT_ROOT, "chatgpt-accounts.json");
const USER_DATA_DIR_PREFIX = path.join(__dirname, "pw-user-data"); // pw-user-data-0, pw-user-data-1, …
const MAX_TABS_PER_ACCOUNT = 2; // tabs (workers) per browser context — increase for more parallelism
const RESUME_SAVE_ENDPOINT = process.env.RESUME_SAVE_ENDPOINT || "http://localhost:3000/api/resume";
const TRACKER_SAVE_ENDPOINT = process.env.TRACKER_SAVE_ENDPOINT || "http://localhost:3000/api/auto-apply-tracker/save";
const GPT_SERVICE_LOG_MODE = (process.env.GPT_SERVICE_LOG_MODE || "compact").toLowerCase();
const CHATGPT_MODE = normalizeChatGptMode(process.env.CHATGPT_MODE);
const CHATGPT_MODEL = String(process.env.CHATGPT_MODEL || "").trim();
const CHATGPT_THINKING = String(process.env.CHATGPT_THINKING || process.env.CHATGPT_REASONING_EFFORT || "").trim();
const VERBOSE_LOGS = GPT_SERVICE_LOG_MODE === "verbose";

if (!VERBOSE_LOGS && process.env.SCRAPER_VERBOSE_LOGS === undefined) {
    process.env.SCRAPER_VERBOSE_LOGS = "false";
}

// ─────────────────────────────────────────────
// Load ChatGPT account URLs from data/chatgpt-accounts.json
// Falls back to the env var CHATGPT_URL, then a bare chatgpt.com URL.
// ─────────────────────────────────────────────
function loadChatGptAccounts() {
    try {
        const raw = fs.readFileSync(CHATGPT_ACCOUNTS_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map((u) => normalizeChatGptAccountUrl(String(u))).filter(Boolean);
        }
    } catch (_) { }
    const envUrl = process.env.CHATGPT_URL;
    return [normalizeChatGptAccountUrl(envUrl || "https://chatgpt.com/")];
}

/**
 * Keep chats inside a ChatGPT Project.
 * Use the project HUB (`…/g/g-p-…/project`) — its composer creates a NEW
 * in-project /c/… chat on each send. Do NOT use sidebar "New chat" (href="/"),
 * which leaves the project for chatgpt.com home.
 */
function normalizeChatGptAccountUrl(rawUrl) {
    const trimmed = String(rawUrl || "").trim();
    if (!trimmed) return "https://chatgpt.com/";
    try {
        const u = new NodeURL(trimmed);
        const m = u.pathname.match(/(\/g\/g-p-[^/]+)/i);
        if (m) {
            u.pathname = `${m[1]}/project`;
        }
        u.search = "";
        u.hash = "";
        return u.toString();
    } catch {
        return trimmed;
    }
}

function isProjectChatUrl(rawUrl) {
    try {
        const { pathname } = new NodeURL(String(rawUrl || ""));
        return /\/g\/g-p-[^/]+/i.test(pathname);
    } catch {
        return false;
    }
}

function projectIdFromUrl(rawUrl) {
    try {
        const m = new NodeURL(String(rawUrl || "")).pathname.match(/\/g\/(g-p-[^/]+)/i);
        return m ? m[1] : "";
    } catch {
        return "";
    }
}

/** True when URL is an existing conversation under a project (/c/…). */
function isExistingProjectConversation(rawUrl) {
    try {
        const { pathname } = new NodeURL(String(rawUrl || ""));
        return /\/g\/g-p-[^/]+\/c\//i.test(pathname);
    } catch {
        return false;
    }
}

async function assertStillInProject(pg, chatGptUrl, workerId) {
    const target = normalizeChatGptAccountUrl(chatGptUrl);
    if (!isProjectChatUrl(target)) return;
    if (!isProjectChatUrl(pg.url())) {
        throw new Error(
            `CHATGPT_LEFT_PROJECT: expected to stay on ${target} but page is ${pg.url()}. ` +
            `Log into the account that owns this project, then restart gpt-service.`
        );
    }
    console.log(`[worker-${workerId}] On project URL: ${pg.url()}`);
}

async function ensureOnProjectUrl(pg, chatGptUrl, workerId) {
    const target = normalizeChatGptAccountUrl(chatGptUrl);
    if (!isProjectChatUrl(target)) {
        console.warn(`[worker-${workerId}] chatGptUrl is not a project link — chats may leave the project: ${target}`);
    }

    const current = pg.url();
    const alreadyInProject = isProjectChatUrl(current)
        && current.includes(new NodeURL(target).pathname.replace(/\/$/, ""));

    if (!alreadyInProject) {
        console.log(`[worker-${workerId}] Navigating to project chat URL: ${target}`);
        await pg.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await sleep(3000);
    }

    // If ChatGPT bounced us to plain home, force project URL once more.
    if (isProjectChatUrl(target) && !isProjectChatUrl(pg.url())) {
        console.warn(`[worker-${workerId}] Left project (now ${pg.url()}) — forcing back to ${target}`);
        await pg.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await sleep(3000);
    }

    await assertStillInProject(pg, chatGptUrl, workerId);
}

/**
 * Start a brand-new chat inside the project for every resume.
 *
 * Verified strategy (HI x4 test):
 *   - Re-open `…/g/g-p-…/project` hub every time
 *   - NEVER click sidebar New chat (href="/" leaves the project)
 *   - Clear composer; the next send creates a fresh /g/g-p-…/c/… thread
 */
async function startFreshProjectChat(pg, chatGptUrl, workerId) {
    const target = normalizeChatGptAccountUrl(chatGptUrl);
    const prevChatId = (pg.url().match(/\/c\/([a-f0-9-]+)/i) || [])[1] || "";

    console.log(`[worker-${workerId}] Starting NEW chat via project hub: ${target} (prev=${prevChatId || "none"})`);

    // Leave any current /c/… thread completely, then open the project hub.
    await pg.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => { });
    await sleep(200);
    await pg.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(2500);

    if (isProjectChatUrl(target) && !isProjectChatUrl(pg.url())) {
        console.warn(`[worker-${workerId}] Left project after goto (now ${pg.url()}) — retrying ${target}`);
        await pg.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await sleep(2500);
    }

    await assertStillInProject(pg, chatGptUrl, workerId);

    // If SPA bounced us into a previous /c/… under the project, force hub again.
    if (isExistingProjectConversation(pg.url())) {
        console.log(`[worker-${workerId}] Hub redirected to old chat ${pg.url()} — forcing ${target}`);
        await pg.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await sleep(2000);
        await assertStillInProject(pg, chatGptUrl, workerId);
    }

    // Clear composer so we don't append to leftover draft text.
    await assertNoRateLimit(pg, workerId);
    const composer = pg.locator('#prompt-textarea, div[contenteditable="true"]').first();
    await composer.waitFor({ state: "visible", timeout: 45_000 });
    await composer.click({ timeout: 5000 }).catch(() => { });
    await pg.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => { });
    await pg.keyboard.press("Backspace").catch(() => { });
    await sleep(300);

    console.log(`[worker-${workerId}] Fresh project hub ready: ${pg.url()}`);
}

// ─────────────────────────────────────────────
// Derive filename from job URL + title
// e.g. url="https://jobs.salesforce.com/job/123" title="Software Engineer"
//      → "salesforce_software_engineer"
// ─────────────────────────────────────────────
function deriveFilenameFromUrl(jobUrl, title) {
    let company = "company";
    try {
        const parsed = new NodeURL(jobUrl);
        const hostParts = parsed.hostname.replace(/^www\./, "").split(".");
        company = hostParts.length >= 2 ? hostParts[hostParts.length - 2] : hostParts[0];
    } catch (_) { }

    const safeTitle = (title || "resume")
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .trim()
        .replace(/\s+/g, "_")
        .slice(0, 40);

    return `${company}_${safeTitle}`;
}

/** @type {import('playwright').BrowserContext[]} */
const browserContexts = [];
let initialized = false;
const queue = [];
let jobCounter = 0;

function normalizeQueueUrl(rawUrl) {
    const value = String(rawUrl || "").trim();
    if (!value) return "";
    try {
        const u = new NodeURL(value);
        u.hash = "";
        return u.toString().toLowerCase();
    } catch {
        return value.toLowerCase();
    }
}

function parsePostedAtEpoch(val) {
    if (!val) return Date.now();
    const ms = new Date(val).getTime();
    return Number.isNaN(ms) ? Date.now() : ms;
}

function sortPriorityQueue() {
    queue.sort((a, b) => {
        const diff = (b.postedAtMs || 0) - (a.postedAtMs || 0);
        if (diff !== 0) return diff;
        return b.jobId - a.jobId;
    });
}

/** @type {{ page: import('playwright').Page, id: number, chatGptUrl: string, context: import('playwright').BrowserContext }[]} */
const workers = [];

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function verboseLog(...args) {
    if (VERBOSE_LOGS) console.log(...args);
}

function verboseWarn(...args) {
    if (VERBOSE_LOGS) console.warn(...args);
}

function attachResumeTitle(err, resumeTitle) {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    if (resumeTitle && typeof wrapped.resumeTitle !== "string") {
        wrapped.resumeTitle = resumeTitle;
    }
    return wrapped;
}

function getErrorResumeTitle(err) {
    if (!err || typeof err !== "object") return "";
    if (typeof err.resumeTitle !== "string") return "";
    return err.resumeTitle.trim();
}

function fallbackTitleFromJob(jobData) {
    const outputName = typeof jobData?.outputName === "string" ? jobData.outputName.trim() : "";
    return outputName || "Title unavailable";
}

function compactReason(err) {
    const message = (err instanceof Error ? err.message : String(err || "Unknown error"))
        .replace(/\s+/g, " ")
        .trim();

    if (!message) return "UNKNOWN_ERROR";
    if (/Could not extract job description/i.test(message)) return "JD_NOT_FOUND";
    if (/Could not extract job title/i.test(message)) return "JOB_TITLE_NOT_FOUND";
    if (/LaTeX not extracted/i.test(message)) return "LATEX_TIMEOUT";
    if (/Could not find the ChatGPT prompt input/i.test(message)) return "PROMPT_INPUT_NOT_FOUND";
    if (/Failed to reload page/i.test(message)) return "PAGE_RELOAD_FAILED";
    if (/page is closed/i.test(message)) return "WORKER_PAGE_CLOSED";
    if (/Unsupported ATS/i.test(message)) return "UNSUPPORTED_ATS";
    if (/CHATGPT_RATE_LIMITED|Too many requests/i.test(message)) return "RATE_LIMITED";
    if (/CHATGPT_SOMETHING_WENT_WRONG|Something went wrong/i.test(message)) return "CHATGPT_SOMETHING_WENT_WRONG";
    if (/CHATGPT_SEND_FAILED/i.test(message)) return "CHATGPT_SEND_FAILED";

    return message.length > 140 ? `${message.slice(0, 137)}...` : message;
}

function shouldRetryJob(err) {
    const message = (err instanceof Error ? err.message : String(err || "")).trim();
    if (!message) return true;
    return true;
}

function buildPrompt(template, resumeLatex, jobDescription) {
    return template
        .replace("{{RESUME_LATEX}}", resumeLatex)
        .replace("{{JOB_DESCRIPTION}}", jobDescription);
}

async function postJson(url, payload, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new NodeURL(url);
        } catch {
            reject(new Error(`Invalid callback URL: ${url}`));
            return;
        }

        const body = JSON.stringify(payload);
        const isHttps = parsed.protocol === "https:";
        const transport = isHttps ? https : http;
        const req = transport.request(
            {
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: `${parsed.pathname}${parsed.search}`,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                },
                timeout: timeoutMs,
            },
            (res) => {
                let raw = "";
                res.on("data", (chunk) => { raw += chunk; });
                res.on("end", () => {
                    const status = res.statusCode || 0;
                    if (status >= 200 && status < 300) {
                        resolve({ status, body: raw });
                        return;
                    }
                    reject(new Error(`Callback HTTP ${status}: ${raw.slice(0, 300)}`));
                });
            }
        );

        req.on("timeout", () => req.destroy(new Error("Callback request timed out")));
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

async function notifyResumeSaved({ jobId, jobUrl, latex, mode }) {
    const payload = { jobUrl, latex, mode: mode || "autoApply" };
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await postJson(RESUME_SAVE_ENDPOINT, payload);
            return true;
        } catch (err) {
            verboseWarn(`[callback] job ${jobId} failed attempt ${attempt}: ${err.message}`);
            if (attempt < maxAttempts) await sleep(5000);
        }
    }

    return false;
}

async function notifyJobSkipped({ jobId, jobUrl, error }) {
    const payload = {
        jobId: jobId || "",
        jobUrl,
        success: false,
        error: String(error || "dead_job_skipped"),
    };
    try {
        await postJson(TRACKER_SAVE_ENDPOINT, payload);
        verboseLog(`[tracker] marked dead job as skipped: ${jobUrl}`);
        return true;
    } catch (err) {
        verboseWarn(`[tracker] failed to mark skipped ${jobUrl}: ${err.message}`);
        return false;
    }
}

// Wait until all browsers have been initialised
async function waitForBrowser(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (!initialized) {
        if (Date.now() > deadline) throw new Error("Browser pool not ready — server is still starting up.");
        await sleep(300);
    }
}

// ─────────────────────────────────────────────
// Browser pool — one persistent context per ChatGPT account
// All workers share a single queue.
// ─────────────────────────────────────────────
async function initBrowserPool() {
    const accounts = loadChatGptAccounts();
    const headless = process.env.HEADLESS === "true";

    console.log(`Launching ${accounts.length} browser instance(s) in ${headless ? "headless" : "headed"} mode…`);

    for (let i = 0; i < accounts.length; i++) {
        const chatGptUrl = accounts[i];
        const userDataDir = `${USER_DATA_DIR_PREFIX}-${i}`;

        if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
        }

        console.log(`[browser-${i}] ChatGPT project URL: ${chatGptUrl}`);

        const ctx = await chromium.launchPersistentContext(userDataDir, {
            headless,
            viewport: { width: 1400, height: 900 },
            args: ["--disable-blink-features=AutomationControlled"],
        });
        browserContexts.push(ctx);

        // First tab: reuse existing page and navigate so user can log in if needed
        const existingPages = ctx.pages();
        const firstPage = existingPages[0] || await ctx.newPage();
        await firstPage.goto(chatGptUrl, { waitUntil: "domcontentloaded" }).catch(() => { });
        console.log(`[browser-${i}] ready — log in to ChatGPT if prompted  (${firstPage.url()})`);

        // Spawn MAX_TABS_PER_ACCOUNT workers for this context
        for (let t = 0; t < MAX_TABS_PER_ACCOUNT; t++) {
            const workerId = i * MAX_TABS_PER_ACCOUNT + t;
            const pg = t === 0 ? firstPage : await ctx.newPage();
            if (t > 0) {
                await pg.goto(chatGptUrl, { waitUntil: "domcontentloaded" }).catch(() => { });
            }
            await sleep(7000);
            try {
                await ensureOnProjectUrl(pg, chatGptUrl, workerId);
                await prepareChatGptControls(pg, workerId);
                if (isProjectChatUrl(chatGptUrl) && !isProjectChatUrl(pg.url())) {
                    await ensureOnProjectUrl(pg, chatGptUrl, workerId);
                }
                if (String(process.env.PREP_PASTE_HI || "").trim() === "1") {
                    const composer = await getComposer(pg, workerId);
                    await fillComposer(pg, composer, "HI");
                    console.log(`[worker-${workerId}] Prep done — ChatGPT controls ready, "HI" pasted (not submitted).`);
                }
            } catch (err) {
                console.warn(
                    `[worker-${workerId}] ChatGPT controls/prep failed (${err.message}). ` +
                    `Log in to ChatGPT if prompted — controls will be selected before each generation.`
                );
            }
            workers.push({ page: pg, id: workerId, chatGptUrl, context: ctx, busy: false, status: "idle", currentJob: null });
        }
    }

    initialized = true;

    // Start worker loops staggered 2s apart
    for (let i = 0; i < workers.length; i++) {
        await sleep(i * 2000);
        workerLoop(workers[i]);
    }
    console.log(`${workers.length} worker(s) started (${loadChatGptAccounts().length} account(s) × ${MAX_TABS_PER_ACCOUNT} tab(s)) — sharing 1 queue.`);
    setInterval(printLiveWorkerTable, 15000);
}

function setWorkerStatus(workerId, status, extra = {}) {
    const worker = workers.find((w) => w.id === workerId);
    if (!worker) return;
    worker.status = status;
    if (worker.currentJob) {
        Object.assign(worker.currentJob, extra);
    }
    const title = worker.currentJob?.title || "Job Application";
    const company = worker.currentJob?.company ? ` @ ${worker.currentJob.company}` : "";
    const elapsed = worker.currentJob?.startedAt ? ` (${Math.round((Date.now() - worker.currentJob.startedAt) / 1000)}s)` : "";
    console.log(`[worker-${workerId}] ⏳ ${status} | "${title}"${company}${elapsed}`);
}

function printLiveWorkerTable() {
    if (!workers || workers.length === 0) return;
    const busy = workers.filter((w) => w.busy);
    if (busy.length === 0) return;

    console.log(`\n─────────────── [Live Workers Status] ───────────────`);
    for (const w of workers) {
        if (!w.busy) {
            console.log(`  [worker-${w.id}] ⚪ IDLE`);
        } else {
            const title = w.currentJob?.title ? `"${w.currentJob.title}"` : "Job Application";
            const company = w.currentJob?.company ? ` @ ${w.currentJob.company}` : "";
            const elapsed = w.currentJob?.startedAt ? ` [${Math.round((Date.now() - w.currentJob.startedAt) / 1000)}s]` : "";
            console.log(`  [worker-${w.id}] 🟡 ${title}${company} | Status: ${w.status}${elapsed}`);
        }
    }
    console.log(`──────────────────────────────────────────────────────\n`);
}

// Each worker runs this loop independently, all draining from the same queue.
// queue.shift() is safe without a mutex — Node.js is single-threaded; shift is sync before any await.
async function workerLoop(worker) {
    const { page: pg, id, chatGptUrl, context } = worker;
    verboseLog(`[worker-${id}] started  chatGptUrl=${chatGptUrl}`);
    worker.busy = false;
    worker.status = "idle";
    worker.currentJob = null;

    while (true) {
        if (queue.length === 0) {
            worker.busy = false;
            worker.status = "idle";
            worker.currentJob = null;
            await sleep(300);
            continue;
        }

        const job = queue.shift();
        worker.busy = true;
        worker.status = "Claimed";
        worker.currentJob = {
            jobId: job.jobId,
            jobUrl: job.data.jobUrl,
            title: job.data.title || "Job Application",
            company: job.data.company || "",
            startedAt: Date.now()
        };

        const titleDisplay = job.data.title ? `"${job.data.title}"` : job.data.jobUrl;
        const compDisplay = job.data.company ? ` @ ${job.data.company}` : "";
        console.log(`\n▶️  [worker-${id}] CLAIMED #${job.jobId}: ${titleDisplay}${compDisplay}`);
        verboseLog(`[worker-${id}] #${job.jobId}  ${job.data.jobUrl.replace(/^https?:\/\//, "")}  (queue: ${queue.length})`);
        let result = null;
        let finalError = null;
        let resumeTitle = "";

        try {
            try {
                result = await processJob(pg, id, job.data, chatGptUrl, context);
            } catch (err) {
                finalError = attachResumeTitle(err, "");
                resumeTitle = getErrorResumeTitle(finalError);
                verboseWarn(`[worker-${id}] #${job.jobId} FAIL (attempt 1): ${finalError.message}`);
                if (!shouldRetryJob(finalError)) {
                    verboseLog(`[worker-${id}] #${job.jobId} marked as non-retryable.`);
                } else {
                    verboseLog(`[worker-${id}] #${job.jobId} retrying...`);
                    try {
                        result = await processJob(pg, id, { ...job.data, newChat: true }, chatGptUrl, context);
                    } catch (retryErr) {
                        finalError = attachResumeTitle(retryErr, resumeTitle);
                        resumeTitle = getErrorResumeTitle(finalError) || resumeTitle;
                        verboseWarn(`[worker-${id}] #${job.jobId} FAIL (gave up): ${finalError.message}`);
                    }
                }
            }

            if (result) {
                console.log(`#${job.jobId} SUCCESS | ${result.title}`);
                await notifyResumeSaved({
                    jobId: job.jobId,
                    jobUrl: job.data.jobUrl,
                    latex: result.latex,
                    mode: job.data.mode,
                });
                continue;
            }

            const title = resumeTitle || fallbackTitleFromJob(job.data);
            const reason = compactReason(finalError);
            console.log(`#${job.jobId} FAIL | ${title} | ${reason}`);

            const errStr = String(finalError?.message || "").toLowerCase();
            const isDeadJob =
                errStr.includes("workday_page_not_found") ||
                errStr.includes("greenhouse_page_not_found") ||
                errStr.includes("dead_link") ||
                errStr.includes("job_not_found") ||
                errStr.includes("404") ||
                errStr.includes("job is no longer available");

            if (isDeadJob) {
                console.log(`[worker-${id}] #${job.jobId} ⚠️ Marking dead job as SKIPPED & inactive in database (${reason})`);
                await notifyJobSkipped({
                    jobId: job.data.jobrightJobId || job.data.jobId,
                    jobUrl: job.data.jobUrl,
                    error: finalError?.message || reason,
                });
            }
        } finally {
            worker.busy = false;
            worker.status = "idle";
            worker.currentJob = null;
        }
    }
}

// Run one resume-generation job on a given page
async function processJob(pg, workerId, data, chatGptUrl, context) {
    const { jobId, jobUrl, jobrightJobId, outputName, newChat = true, timeoutMs = 180_000 } = data;
    const tag = `[worker-${workerId}] #${jobId}`;
    let resumeTitle = "";

    try {
        if (pg.isClosed()) throw new Error(`Worker ${workerId} page is closed.`);

        // ── Step 1: Scrape the job posting (open URL → 3s wait → extract, with 1 reload retry) ──
        setWorkerStatus(workerId, "Scraping Job Details", { title: data.title, company: data.company });
        const scraped = await scrapeJobDetails(context, jobUrl, jobrightJobId);
        const { title, description: jd, atsId, atsName } = scraped;
        resumeTitle = title;
        setWorkerStatus(workerId, "Job Scraped — Building prompt", { title: title || data.title, company: data.company });

        // ── Step 2: Build the prompt ──
        const resumeLatex = fs.readFileSync(RESUME_PATH, "utf-8");
        const template = fs.readFileSync(PROMPT_TEMPLATE_PATH, "utf-8");
        const prompt = buildPrompt(template, resumeLatex, jd);

        const resolvedName = (outputName && outputName.trim())
            ? outputName.trim()
            : deriveFilenameFromUrl(jobUrl, title);

        verboseLog(`${tag}  scraped "${title}"  (${atsName}, ${jd.length} chars)  →  ${resolvedName}.tex`);

        // ── Step 3: ChatGPT generation with reload-retry on "Something went wrong" or Rate Limits ──
        verboseLog(`${tag}  generating...`);
        const MAX_OPENAI_UI_RETRIES = 3;
        let rateLimitWaitCount = 0;
        const MAX_RATE_LIMIT_RETRIES = 12;
        let latex = null;

        for (let attempt = 1; attempt <= MAX_OPENAI_UI_RETRIES; attempt++) {
            try {
                await pg.bringToFront();

                if (attempt > 1) {
                    console.warn(`${tag} OpenAI UI retry ${attempt}/${MAX_OPENAI_UI_RETRIES} — reloading, wait 2s, then redo chat flow…`);
                    setWorkerStatus(workerId, `OpenAI UI retry ${attempt}/${MAX_OPENAI_UI_RETRIES}`);
                    await pg.reload({ waitUntil: "domcontentloaded" }).catch(() => { });
                    await sleep(2000);
                }

                await assertNoOpenAiSomethingWentWrong(pg, workerId);
                await assertNoRateLimit(pg, workerId);

                setWorkerStatus(workerId, "Opening fresh ChatGPT project chat");
                await startFreshProjectChat(pg, chatGptUrl, workerId);
                await sleep(800);
                await assertNoOpenAiSomethingWentWrong(pg, workerId);
                await assertNoRateLimit(pg, workerId);

                setWorkerStatus(workerId, "Selecting ChatGPT controls/model");
                await prepareChatGptControls(pg, workerId);

                // ChatGPT UI clicks can still navigate away — open another fresh project chat.
                if (isProjectChatUrl(chatGptUrl) && !isProjectChatUrl(pg.url())) {
                    console.warn(`${tag} Left project after ChatGPT control select — starting a fresh project chat.`);
                    await startFreshProjectChat(pg, chatGptUrl, workerId);
                }
                await assertNoOpenAiSomethingWentWrong(pg, workerId);
                await assertNoRateLimit(pg, workerId);

                setWorkerStatus(workerId, "Pasting prompt into composer");
                const composer = await getComposer(pg, workerId);
                await fillComposer(pg, composer, prompt);
                console.log(`${tag} Prompt pasted — checking rate limit…`);
                await assertNoRateLimit(pg, workerId);
                // Let ChatGPT finish hydrating the Lexical editor + enable Send.
                console.log(`${tag} Waiting 5s before send…`);
                await sleep(5000);
                await assertNoOpenAiSomethingWentWrong(pg, workerId);
                await assertNoRateLimit(pg, workerId);

                setWorkerStatus(workerId, "Submitting prompt to ChatGPT");
                await clickSend(pg, workerId);

                // Wait after submit, check for rate limit / response status
                console.log(`${tag} Prompt sent — waiting 3s to verify status…`);
                await sleep(3500);
                await assertNoOpenAiSomethingWentWrong(pg, workerId);
                await assertNoRateLimit(pg, workerId);

                if (isProjectChatUrl(chatGptUrl) && !isProjectChatUrl(pg.url())) {
                    throw new Error(
                        `CHATGPT_LEFT_PROJECT_ON_SUBMIT: submitted outside project (url=${pg.url()}).`
                    );
                }

                setWorkerStatus(workerId, "Waiting for ChatGPT to generate LaTeX");
                latex = await waitForAssistantResponse(pg, workerId, timeoutMs);
                setWorkerStatus(workerId, "LaTeX received — validating");
                break;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                const isSwW = /CHATGPT_SOMETHING_WENT_WRONG|Something went wrong/i.test(msg);
                const isRateLimit = /CHATGPT_RATE_LIMITED|Too many requests/i.test(msg);

                if (isRateLimit) {
                    rateLimitWaitCount++;
                    console.warn(`${tag} 🔄 Rate limit cleared (#${rateLimitWaitCount}) — retrying prompt submission…`);
                    attempt--; // Infinite retry loop: never gives up, keeps checking every 10 min
                    await sleep(2000);
                    continue;
                }

                if (!isSwW || attempt >= MAX_OPENAI_UI_RETRIES) throw err;
                console.warn(`${tag} ${msg} — will reload and retry (${attempt}/${MAX_OPENAI_UI_RETRIES})`);
            }
        }

        return { latex, latexLength: latex.length, atsId, atsName, title, outputName: resolvedName };
    } catch (err) {
        throw attachResumeTitle(err, resumeTitle);
    }
}

// ─────────────────────────────────────────────
// Check for "Too many requests" in DOM and wait 5 min if found.
// Keeps looping until the message is gone.
// Wait is isolated to this worker only — other workers are unaffected.
// ─────────────────────────────────────────────
async function pageHasOpenAiSomethingWentWrong(pg) {
    return pg.evaluate(() => {
        const text = String(document.body?.innerText || "").replace(/\s+/g, " ");
        return /Something went wrong/i.test(text)
            && /help\.openai\.com/i.test(text);
    }).catch(() => false);
}

async function assertNoOpenAiSomethingWentWrong(pg, workerId) {
    if (await pageHasOpenAiSomethingWentWrong(pg)) {
        throw new Error(
            `CHATGPT_SOMETHING_WENT_WRONG: OpenAI UI error on worker ${workerId} (${pg.url()})`
        );
    }
}

async function pageHasRateLimit(pg) {
    return pg.evaluate(() => {
        const text = String(document.body?.innerText || "");
        return text.includes("Too many requests") || /too many requests/i.test(text);
    }).catch(() => false);
}

async function waitOutRateLimit(pg, workerId) {
    const RATE_LIMIT_WAIT_MS = 10 * 60 * 1000; // 10 minutes
    const tag = `[worker-${workerId}]`;

    let rateLimited = false;
    let check = 0;
    while (true) {
        const hasRateLimit = await pageHasRateLimit(pg);
        if (!hasRateLimit) break;

        rateLimited = true;
        check++;
        console.warn(`${tag} ⚠️  "Too many requests" detected on page — waiting 10 min (check #${check}, this tab only, others keep running)…`);
        await sleep(RATE_LIMIT_WAIT_MS);
        console.log(`${tag} ⏱  Rate-limit 10 min wait done — reloading page to check if cleared…`);
        await pg.reload({ waitUntil: "domcontentloaded" }).catch(() => { });
        await sleep(3000);
    }
    if (rateLimited) {
        console.log(`${tag} ✅ "Too many requests" cleared.`);
    }
    return rateLimited;
}

async function assertNoRateLimit(pg, workerId) {
    if (!initialized) {
        if (await pageHasRateLimit(pg)) {
            console.warn(`[worker-${workerId}] ⚠️  "Too many requests" detected on startup — browser ready, will handle wait during job run.`);
            throw new Error(`CHATGPT_RATE_LIMITED_STARTUP: rate-limited on startup`);
        }
        return;
    }

    if (await pageHasRateLimit(pg)) {
        await waitOutRateLimit(pg, workerId);
        throw new Error(`CHATGPT_RATE_LIMITED: "Too many requests" on worker ${workerId}`);
    }
}

function normalizeModelLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeChatGptMode(value) {
    const mode = normalizeModelLabel(value || "work");
    if (["chat", "chatgpt", "normal"].includes(mode)) return "chatgpt";
    if (["work", "codex"].includes(mode)) return "work";
    return "work";
}

function chatGptModeLabel() {
    return CHATGPT_MODE === "chatgpt" ? "Chat" : "Work";
}

function getChatGptModelConfig() {
    const effortMatch = CHATGPT_MODEL.match(/\s+(extra high|high|medium|low)$/i);
    const baseModel = effortMatch
        ? CHATGPT_MODEL.slice(0, -effortMatch[0].length).trim()
        : CHATGPT_MODEL;
    const effortLabel = CHATGPT_THINKING || effortMatch?.[1] || "";

    return {
        baseModel,
        effortLabel,
        displayLabel: [baseModel, effortLabel].filter(Boolean).join(" "),
    };
}

function getModelChoiceLabels(baseModel) {
    const labels = [baseModel];
    const shortName = baseModel.match(/\b(Luna|Sol|Terra|Astra)\b/i)?.[1];
    if (shortName) labels.push(shortName);
    return [...new Set(labels.filter(Boolean))];
}

async function findModelSwitcher(pg) {
    const selectors = [
        '[data-testid="model-switcher-dropdown-button"]',
        'button[aria-label*="model selector" i]',
        'button[aria-label*="choose model" i]',
    ];

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
        for (const selector of selectors) {
            const candidate = pg.locator(selector).first();
            if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
                return candidate;
            }
        }

        const menuButtons = pg.locator('button[aria-haspopup="menu"]');
        const count = Math.min(await menuButtons.count(), 100);
        for (let i = 0; i < count; i++) {
            const candidate = menuButtons.nth(i);
            if (!(await candidate.isVisible().catch(() => false))) continue;
            const label = normalizeModelLabel(await candidate.innerText().catch(() => ""));
            if (/^gpt-\d/.test(label)) return candidate;
        }

        await sleep(300);
    }
    return null;
}

async function listVisibleChoices(pg) {
    const choices = pg.locator(
        '[role="menuitem"], [role="menuitemradio"], [role="option"], [data-radix-collection-item], [data-testid*="model"], button'
    );
    const count = Math.min(await choices.count(), 200);
    const visibleChoices = [];

    for (let i = 0; i < count; i++) {
        const choice = choices.nth(i);
        if (!(await choice.isVisible().catch(() => false))) continue;
        const text = String(await choice.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (!text) continue;
        visibleChoices.push({ choice, text, normalized: normalizeModelLabel(text) });
    }
    return visibleChoices;
}

async function clickVisibleModelChoice(pg, labels) {
    const normalizedLabels = labels.map(normalizeModelLabel).filter(Boolean);
    const visibleChoices = await listVisibleChoices(pg);

    for (const label of normalizedLabels) {
        const exact = visibleChoices.find(({ normalized }) => normalized === label);
        if (exact) {
            await exact.choice.evaluate((element) => element.click());
            return exact.text;
        }
    }
    for (const label of normalizedLabels) {
        const partial = visibleChoices.find(({ normalized }) => normalized.includes(label));
        if (partial) {
            await partial.choice.evaluate((element) => element.click());
            return partial.text;
        }
    }

    return "";
}

function effortLabelMatches(actualLabel, effortLabel) {
    const actual = normalizeModelLabel(actualLabel);
    const wanted = normalizeModelLabel(effortLabel);
    if (!actual || !wanted) return false;

    if (actual.includes("extra high") && wanted !== "extra high") return false;
    if (actual.includes("ultra") && wanted !== "ultra") return false;
    if (/\bmax\b/.test(actual) && wanted !== "max") return false;

    return actual === wanted
        || actual === `power ${wanted}`
        || actual === `thinking ${wanted}`
        || actual.includes(`power · ${wanted}`)
        || actual.includes(`thinking · ${wanted}`)
        || new RegExp(`\\b${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(actual);
}

async function clickVisibleEffortChoice(pg, effortLabel) {
    const visibleChoices = await listVisibleChoices(pg);
    const match = visibleChoices.find(({ normalized }) => effortLabelMatches(normalized, effortLabel));
    if (!match) return "";
    await match.choice.evaluate((element) => element.click());
    return match.text;
}

async function hoverVisibleModelChoice(pg, labels) {
    const normalizedLabels = labels.map(normalizeModelLabel).filter(Boolean);
    const visibleChoices = await listVisibleChoices(pg);

    for (const label of normalizedLabels) {
        const match = visibleChoices.find(({ normalized }) =>
            normalized === label || normalized.includes(label)
        );
        if (match) {
            await match.choice.hover({ timeout: 2000 }).catch(() => { });
            return match.text;
        }
    }
    return "";
}

function effortLevelIndex(effortLabel) {
    const label = normalizeModelLabel(effortLabel);
    if (label === "ultra") return 6;
    if (label === "max") return 5;
    if (label === "extra high") return 4;
    if (label === "high") return 3;
    if (label === "medium") return 2;
    return 1;
}

function sliderValueForLevel(min, max, level) {
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : lo + 5;
    return Math.min(hi, Math.max(lo, lo + (level - 1)));
}

function sliderStopCount(min, max) {
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : lo + 5;
    return Math.max(4, hi - lo + 1);
}

async function readEffortState(pg) {
    return pg.evaluate(() => {
        const visible = (el) => {
            const style = window.getComputedStyle(el);
            const box = el.getBoundingClientRect();
            return style.display !== "none"
                && style.visibility !== "hidden"
                && box.width > 0
                && box.height > 0;
        };

        const ranges = [...document.querySelectorAll('input[type="range"]')]
            .filter(visible)
            .map((el) => ({
                kind: "range",
                min: Number(el.min || 0),
                max: Number(el.max || 3),
                value: Number(el.value),
                label: String(el.getAttribute("aria-valuetext") || el.getAttribute("aria-label") || ""),
            }));

        const sliders = [...document.querySelectorAll('[role="slider"]')]
            .filter(visible)
            .map((el) => ({
                kind: "slider",
                min: Number(el.getAttribute("aria-valuemin") || 0),
                max: Number(el.getAttribute("aria-valuemax") || 3),
                value: Number(el.getAttribute("aria-valuenow") || 0),
                label: String(el.getAttribute("aria-valuetext") || el.getAttribute("aria-label") || ""),
            }));

        return [...ranges, ...sliders];
    }).catch(() => []);
}

function effortStateMatches(states, effortLabel) {
    const wanted = normalizeModelLabel(effortLabel);
    const level = effortLevelIndex(effortLabel);
    return states.some((state) => {
        const label = normalizeModelLabel(state.label);
        if (label.includes("extra high") && wanted !== "extra high") return false;
        if (label.includes("ultra") && wanted !== "ultra") return false;
        if (/\bmax\b/.test(label) && wanted !== "max") return false;
        if (effortLabelMatches(label, wanted)) return true;
        if (!Number.isFinite(state.min) || !Number.isFinite(state.value)) return false;
        return Number(state.value) === sliderValueForLevel(state.min, state.max, level);
    });
}

async function clickSliderBarAtLevel(pg, level) {
    const locators = [
        'input[type="range"]',
        '[role="slider"]',
        '[data-testid*="slider" i]',
        '[data-testid*="reasoning" i]',
        '[data-testid*="effort" i]',
        '[class*="slider" i]',
        '[aria-label*="reasoning" i]',
        '[aria-label*="effort" i]',
        '[aria-label*="thinking" i]',
    ];

    for (const selector of locators) {
        const matches = pg.locator(selector);
        const count = Math.min(await matches.count(), 12);
        for (let i = 0; i < count; i++) {
            const el = matches.nth(i);
            if (!(await el.isVisible().catch(() => false))) continue;
            const box = await el.boundingBox().catch(() => null);
            if (!box || box.width < 40) continue;
            const min = Number(await el.getAttribute("min") || await el.getAttribute("aria-valuemin") || 0);
            const max = Number(await el.getAttribute("max") || await el.getAttribute("aria-valuemax") || 5);
            const fraction = (level - 0.5) / sliderStopCount(min, max);
            const x = box.x + Math.min(box.width - 2, Math.max(2, box.width * fraction));
            const y = box.y + box.height / 2;
            await pg.mouse.click(x, y);
            return true;
        }
    }
    return false;
}

async function revealPowerSlider(pg) {
    const power = pg.getByRole("menuitem", { name: "Power", exact: true });
    if (await power.count()) {
        await power.first().hover({ timeout: 2000 }).catch(() => { });
        await sleep(300);
        if (await power.first().isVisible().catch(() => false)) {
            await power.first().click({ timeout: 2000 }).catch(() => { });
            await sleep(300);
        }
    }
}

async function setReasoningEffort(pg, effortLabel) {
    const level = effortLevelIndex(effortLabel);
    await revealPowerSlider(pg);

    const labeled = await clickVisibleEffortChoice(pg, effortLabel);
    if (labeled) {
        return `label:${labeled}`;
    }

    const exactLabel = pg.getByText(new RegExp(`^${effortLabel}$`, "i")).first();
    if (await exactLabel.isVisible({ timeout: 800 }).catch(() => false)) {
        await exactLabel.click();
        return `label:${effortLabel}`;
    }

    const ranges = pg.locator('input[type="range"]');
    const rangeCount = Math.min(await ranges.count(), 8);
    for (let i = 0; i < rangeCount; i++) {
        const el = ranges.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const min = Number(await el.getAttribute("min") || 0);
        const max = Number(await el.getAttribute("max") || 5);
        const value = sliderValueForLevel(min, max, level);
        await el.fill(String(value));
        return `range:${value}`;
    }

    const sliders = pg.locator('[role="slider"]');
    const sliderCount = Math.min(await sliders.count(), 8);
    for (let i = 0; i < sliderCount; i++) {
        const el = sliders.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        await el.click({ timeout: 2000 });
        await el.focus().catch(() => { });
        await pg.keyboard.press("Home");
        for (let step = 1; step < level; step++) {
            await pg.keyboard.press("ArrowRight");
            await sleep(80);
        }
        return `slider:${level}`;
    }

    if (await clickSliderBarAtLevel(pg, level)) {
        return `bar:${level}`;
    }

    return "";
}

async function ensureModelMenuOpen(pg, switcher) {
    const menuVisible = await pg.locator('[role="menu"], [role="listbox"]').first()
        .isVisible({ timeout: 300 }).catch(() => false);
    if (menuVisible) return;
    if (switcher) {
        await switcher.click({ timeout: 5000 });
        await sleep(400);
    }
}

async function closeModelMenu(pg) {
    // Click outside (composer / page) so ChatGPT fully closes the stuck dropdown.
    // Never click the top-left logo — that leaves the project for chatgpt.com/.
    await pg.keyboard.press("Escape").catch(() => { });
    await sleep(200);
    const composer = pg.locator('#prompt-textarea, div[contenteditable="true"]').first();
    if (await composer.isVisible({ timeout: 800 }).catch(() => false)) {
        await composer.click({ timeout: 2000 }).catch(() => { });
    } else {
        // Mid-page safe click (away from sidebar logo / nav).
        const viewport = pg.viewportSize() || { width: 1400, height: 900 };
        await pg.mouse.click(Math.floor(viewport.width * 0.55), Math.floor(viewport.height * 0.45)).catch(() => { });
    }
    await sleep(500);
    // If menu still open, Escape once more.
    const stillOpen = await pg.locator('[role="menu"], [role="listbox"]').first()
        .isVisible({ timeout: 300 }).catch(() => false);
    if (stillOpen) {
        await pg.keyboard.press("Escape").catch(() => { });
        await sleep(400);
    }
}

async function wakeChatGptUi(pg) {
    // Do NOT click the top-left corner — that hits the ChatGPT logo and navigates
    // to chatgpt.com/, leaving the project. Prefer Escape + composer focus only.
    await pg.keyboard.press("Escape").catch(() => { });
    await sleep(200);
    const composer = pg.locator('#prompt-textarea, div[contenteditable="true"]').first();
    if (await composer.isVisible({ timeout: 1500 }).catch(() => false)) {
        await composer.click({ timeout: 2000 }).catch(() => { });
        await sleep(250);
    }
}

async function selectChatGptMode(pg, workerId) {
    const toggleValue = CHATGPT_MODE === "chatgpt" ? "chatgpt" : "work";
    const modeLabel = chatGptModeLabel();
    await wakeChatGptUi(pg);

    const findToggle = async () => {
        // Current ChatGPT uses aria-pressed buttons inside the Composer mode group.
        const groupedButton = pg.getByRole("group", { name: "Composer mode" })
            .getByRole("button", { name: modeLabel, exact: true }).first();
        if (await groupedButton.isVisible({ timeout: 1000 }).catch(() => false)) return groupedButton;

        const selectors = [
            `button[data-tpp-toggle-value="${toggleValue}"]`,
            `[data-tpp-toggle-value="${toggleValue}"]`,
        ];

        for (const selector of selectors) {
            const candidate = pg.locator(selector).first();
            if (await candidate.isVisible({ timeout: 1000 }).catch(() => false)) return candidate;
        }

        const roleRadio = pg.getByRole("radio", { name: new RegExp(`^\\s*${modeLabel}\\s*$`, "i") }).first();
        if (await roleRadio.isVisible({ timeout: 1000 }).catch(() => false)) return roleRadio;

        const roleButton = pg.getByRole("button", { name: new RegExp(`^\\s*${modeLabel}\\s*$`, "i") }).first();
        if (await roleButton.isVisible({ timeout: 1000 }).catch(() => false)) return roleButton;

        return null;
    };

    const isSelected = async (toggle) => {
        const state = await toggle.getAttribute("data-state").catch(() => "");
        const checked = await toggle.getAttribute("aria-checked").catch(() => "");
        const pressed = await toggle.getAttribute("aria-pressed").catch(() => "");
        return state === "on" || checked === "true" || pressed === "true";
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
        const toggle = await findToggle();
        if (!toggle) {
            await assertNoRateLimit(pg, workerId);
            if (attempt < 3) {
                await sleep(700);
                continue;
            }
            await assertNoRateLimit(pg, workerId);
            throw new Error(`CHATGPT_MODE_TOGGLE_NOT_FOUND: ${modeLabel}`);
        }

        if (await isSelected(toggle)) {
            verboseLog(`[worker-${workerId}] ChatGPT mode already selected: ${modeLabel}`);
            await assertNoRateLimit(pg, workerId);
            return true;
        }
        if (await toggle.isDisabled().catch(() => false)) {
            throw new Error(`CHATGPT_MODE_UNAVAILABLE: ${modeLabel} is disabled on ${pg.url()}`);
        }

        await toggle.scrollIntoViewIfNeeded().catch(() => { });
        await toggle.click({ timeout: 3000 }).catch(async () => {
            await toggle.evaluate((element) => element.click());
        });
        await sleep(800);

        const selectedToggle = await findToggle();
        if (selectedToggle && await isSelected(selectedToggle)) {
            console.log(`[worker-${workerId}] ChatGPT mode clicked/selected: ${modeLabel}`);
            await assertNoRateLimit(pg, workerId);
            return true;
        }
    }

    throw new Error(`CHATGPT_MODE_SELECT_FAILED: ${modeLabel}`);
}

async function clickEffortChoice(pg, effortLabel) {
    const candidates = [
        effortLabel,
        `Power · ${effortLabel}`,
        `Power ${effortLabel}`,
        `Thinking · ${effortLabel}`,
    ];

    // Prefer exact visible text match first.
    for (const label of candidates) {
        const hit = pg.getByText(new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i")).first();
        if (await hit.isVisible({ timeout: 600 }).catch(() => false)) {
            await hit.click({ timeout: 2000 });
            await sleep(350);
            return label;
        }
    }

    const viaMenu = await clickVisibleEffortChoice(pg, effortLabel);
    if (viaMenu) {
        return viaMenu;
    }
    return "";
}

async function prepareChatGptControls(pg, workerId) {
    await selectChatGptMode(pg, workerId);
    await assertNoRateLimit(pg, workerId);
    if (CHATGPT_MODE !== "work") {
        verboseLog(`[worker-${workerId}] Chat mode selected — skipping Work model/thinking setup.`);
        return;
    }
    await selectChatGptModel(pg, workerId);
    await assertNoRateLimit(pg, workerId);
}

async function selectChatGptModel(pg, workerId) {
    if (!CHATGPT_MODEL) return;

    const { baseModel, effortLabel, displayLabel } = getChatGptModelConfig();

    await wakeChatGptUi(pg);

    let switcher = await findModelSwitcher(pg);
    if (!switcher) {
        throw new Error(`CHATGPT_MODEL_SELECTOR_NOT_FOUND: ${displayLabel || CHATGPT_MODEL}`);
    }

    const beforeLabel = normalizeModelLabel(
        String(await switcher.innerText().catch(() => "")).replace(/\s+/g, " ").trim()
    );
    const alreadyDone = beforeLabel.includes(normalizeModelLabel(baseModel))
        && (!effortLabel || beforeLabel.includes(normalizeModelLabel(effortLabel)))
        && !beforeLabel.includes("ultra");
    if (alreadyDone) {
        verboseLog(`[worker-${workerId}] ChatGPT model already selected: ${displayLabel}`);
        return;
    }

    const modelChoiceLabels = getModelChoiceLabels(baseModel);

    console.log(`[worker-${workerId}] Selecting ChatGPT model first: ${baseModel}`);

    // ── Step 1: open menu and select the configured model ──
    await switcher.click({ timeout: 5000 });
    await sleep(700);

    const selectedModel = await clickVisibleModelChoice(pg, modelChoiceLabels);
    if (!selectedModel) {
        await ensureModelMenuOpen(pg, switcher);
        await sleep(500);
        const retryModel = await clickVisibleModelChoice(pg, modelChoiceLabels);
        if (!retryModel) {
            await closeModelMenu(pg);
            throw new Error(`CHATGPT_MODEL_NOT_FOUND: ${baseModel}`);
        }
    }
    await sleep(600);

    // ── Step 2: close dropdown (click outside) — required or Extra High UI sticks ──
    await closeModelMenu(pg);
    await sleep(500);

    // ── Step 3: reopen and select the configured thinking level ──
    if (effortLabel) {
        console.log(`[worker-${workerId}] Selecting ChatGPT thinking level after model: ${effortLabel}`);
        switcher = await findModelSwitcher(pg);
        if (!switcher) {
            throw new Error(`CHATGPT_MODEL_SELECTOR_NOT_FOUND: ${displayLabel}`);
        }
        await switcher.click({ timeout: 5000 });
        await sleep(700);

        await hoverVisibleModelChoice(pg, modelChoiceLabels);
        await sleep(500);
        await revealPowerSlider(pg);
        await sleep(500);

        let selectedEffort = await clickEffortChoice(pg, effortLabel);
        if (!selectedEffort) {
            selectedEffort = await setReasoningEffort(pg, effortLabel);
        }
        await sleep(500);

        const effortConfirmed = Boolean(selectedEffort)
            || effortStateMatches(await readEffortState(pg), effortLabel);

        if (!effortConfirmed) {
            // Close + reopen once more, then retry Extra High.
            await closeModelMenu(pg);
            await sleep(500);
            switcher = await findModelSwitcher(pg);
            await switcher.click({ timeout: 5000 });
            await sleep(700);
            await hoverVisibleModelChoice(pg, modelChoiceLabels);
            await sleep(500);
            await revealPowerSlider(pg);
            await sleep(500);
            selectedEffort = await clickEffortChoice(pg, effortLabel);
            if (!selectedEffort) {
                selectedEffort = await setReasoningEffort(pg, effortLabel);
            }
            await sleep(400);
            if (!selectedEffort && !effortStateMatches(await readEffortState(pg), effortLabel)) {
                await closeModelMenu(pg);
                throw new Error(`CHATGPT_MODEL_EFFORT_NOT_FOUND: ${effortLabel}`);
            }
        }

        await closeModelMenu(pg);
        await sleep(400);
    }

    const finalSwitcher = await findModelSwitcher(pg);
    const finalLabelRaw = finalSwitcher
        ? String(await finalSwitcher.innerText().catch(() => "")).replace(/\s+/g, " ").trim()
        : "";
    const finalLabel = normalizeModelLabel(finalLabelRaw);
    const modelSelected = finalLabel.includes(normalizeModelLabel(baseModel)) || finalLabel.includes("sol");
    const pickedUltra = finalLabel.includes("ultra");
    const pickedExtraHigh = finalLabel.includes("extra high");
    const effortSelected = !effortLabel
        || (effortLabelMatches(finalLabel, effortLabel)
            && !(pickedExtraHigh && normalizeModelLabel(effortLabel) !== "extra high")
            && !pickedUltra);

    if (!modelSelected || !effortSelected || pickedUltra) {
        throw new Error(`CHATGPT_MODEL_VERIFICATION_FAILED: expected ${displayLabel} (saw "${finalLabelRaw || finalLabel}")`);
    }

    console.log(`[worker-${workerId}] ChatGPT model selected: ${displayLabel}`);
}

// ─────────────────────────────────────────────
// Find the prompt composer (tries many selector patterns)
// ─────────────────────────────────────────────
async function getComposer(pg, workerId) {
    const selectors = [
        '#prompt-textarea',
        'textarea[data-testid="prompt-textarea"]',
        'div[id="prompt-textarea"]',
        'div[contenteditable="true"][data-lexical-editor="true"]',
        'div[contenteditable="true"]',
        'textarea[placeholder*="Message"]',
        'textarea[placeholder*="message"]',
    ];

    async function tryFind() {
        await waitOutRateLimit(pg, workerId);
        for (const s of selectors) {
            try {
                const el = pg.locator(s).first();
                if (await el.count() > 0) {
                    await el.waitFor({ state: "visible", timeout: 3000 });
                    return el;
                }
            } catch (_) { }
        }
        return null;
    }

    const RETRIES = 3;
    const RETRY_WAIT_MS = 3000;

    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        const el = await tryFind();
        if (el) return el;

        if (attempt < RETRIES) {
            verboseWarn(`[worker-${workerId}] Input not found (attempt ${attempt}/${RETRIES}), reloading page in ${RETRY_WAIT_MS / 1000}s…`);
            await sleep(RETRY_WAIT_MS);
            await pg.reload({ waitUntil: "domcontentloaded" }).catch(() => { });
            await sleep(1500);
        }
    }

    throw new Error(
        `[worker-${workerId}] Could not find the ChatGPT prompt input. Make sure you are logged in in window ${workerId}.`
    );
}

// ─────────────────────────────────────────────
// Fill the composer (handles both textarea and contenteditable)
// ─────────────────────────────────────────────
async function fillComposer(pg, composer, text) {
    await composer.click({ timeout: 5000 });
    await sleep(200);

    // Determine tag type
    const tag = await composer.evaluate((el) => el.tagName.toLowerCase());

    if (tag === "textarea") {
        await composer.fill(text);
    } else {
        // contenteditable (Lexical editor used by ChatGPT)
        // Step 1: select all & delete existing text
        await pg.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await sleep(80);
        await pg.keyboard.press("Backspace");
        await sleep(150);

        // Step 2: inject text via ClipboardEvent (handles special chars & length)
        const pasted = await pg.evaluate((t) => {
            const el = document.activeElement;
            if (!el) return false;
            try {
                const dt = new DataTransfer();
                dt.setData("text/plain", t);
                el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
                return true;
            } catch (_) {
                return false;
            }
        }, text);

        // Step 3: fallback — write to clipboard then Cmd/Ctrl+V
        if (!pasted) {
            verboseLog("ClipboardEvent paste failed, trying writeText fallback…");
            await pg.evaluate(async (t) => {
                try {
                    await navigator.clipboard.writeText(t);
                    return true;
                } catch {
                    return false;
                }
            }, text);
            await pg.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
        }

        // Step 4: last resort — type character by character
        const current = (await composer.innerText().catch(() => "")).trim();
        if (!current && text.length < 500) {
            verboseLog("Paste failed, typing character by character…");
            await pg.keyboard.type(text, { delay: 8 });
        }
    }

    // Move caret to end — mid-prompt cursor makes Enter insert a newline instead of send.
    await composer.click({ timeout: 3000 }).catch(() => { });
    await pg.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End").catch(() => { });
    await pg.keyboard.press("End").catch(() => { });
    await sleep(200);
}

// ─────────────────────────────────────────────
// Click the Send button (falls back to Enter key)
// ─────────────────────────────────────────────
async function clickSend(pg, workerId = 0) {
    const selectors = [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send message" i]',
        'button[aria-label*="Send" i]',
        'button[aria-label*="send" i]',
    ];

    const composer = pg.locator('#prompt-textarea, div[contenteditable="true"], textarea[data-testid="prompt-textarea"]').first();

    // Ensure focus at end of prompt before send attempts.
    if (await composer.isVisible({ timeout: 2000 }).catch(() => false)) {
        await composer.click({ timeout: 3000 }).catch(() => { });
        await pg.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End").catch(() => { });
        await pg.keyboard.press("End").catch(() => { });
        await sleep(200);
    }

    async function tryClickSendButton() {
        for (const s of selectors) {
            const btn = pg.locator(s).first();
            if (!(await btn.count().catch(() => 0))) continue;
            try {
                await btn.waitFor({ state: "visible", timeout: 2500 });
                // Wait until ChatGPT enables the send button after paste.
                const deadline = Date.now() + 12_000;
                while (Date.now() < deadline) {
                    const enabled = await btn.isEnabled().catch(() => false);
                    const disabledAttr = await btn.getAttribute("disabled").catch(() => null);
                    const ariaDisabled = String(await btn.getAttribute("aria-disabled").catch(() => "") || "").toLowerCase();
                    if (enabled && disabledAttr === null && ariaDisabled !== "true") break;
                    await sleep(250);
                }
                await btn.click({ timeout: 5000, force: true });
                return true;
            } catch (_) { /* try next selector */ }
        }
        return false;
    }

    async function composerLooksEmpty() {
        const text = String(await composer.innerText().catch(() => "") || "").trim();
        // Ignore placeholder-ish short crumbs; real prompts are long.
        return text.length < 20;
    }

    async function generationStarted() {
        return pg.evaluate(() => {
            return Array.from(document.querySelectorAll("button")).some((b) => {
                const label = (b.getAttribute("aria-label") || "").toLowerCase();
                return label.includes("stop") || label.includes("stop streaming") || label.includes("stop generating");
            });
        }).catch(() => false);
    }

    for (let attempt = 1; attempt <= 4; attempt++) {
        verboseLog(`clickSend attempt ${attempt}/4`);
        await assertNoRateLimit(pg, workerId);
        const clicked = await tryClickSendButton();
        if (!clicked) {
            // Prefer Ctrl/Cmd+Enter over bare Enter (bare Enter can newline mid-prompt).
            await pg.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter").catch(() => { });
            await sleep(400);
            if (!(await generationStarted()) && !(await composerLooksEmpty())) {
                await pg.keyboard.press("Enter").catch(() => { });
            }
        }

        await sleep(1200);
        await assertNoRateLimit(pg, workerId);
        if (await generationStarted() || await composerLooksEmpty()) {
            return;
        }

        // Still stuck with prompt in the box — refocus end and retry.
        if (await composer.isVisible({ timeout: 1000 }).catch(() => false)) {
            await composer.click({ timeout: 2000 }).catch(() => { });
            await pg.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End").catch(() => { });
            await sleep(300);
        }
    }

    await assertNoRateLimit(pg, workerId);
    throw new Error("CHATGPT_SEND_FAILED: could not click Send / Enter after pasting prompt");
}

// ─────────────────────────────────────────────
// Wait for ChatGPT to finish generating
//
// Wait for generation to stop and a complete LaTeX document to be available,
// either in the old code block or the new Open document editor.
// ─────────────────────────────────────────────
async function waitForAssistantResponse(pg, tabId, timeoutMs = 120_000) {
    const start = Date.now();
    const APPEAR_POLL_MS = 1500;        // how often to check for stop button appearance
    const COMPLETION_POLL_MS = 10_000;  // check Stop and both response layouts every 10 s
    const ROUND_MS = 5 * 60 * 1000;    // 5 min per round
    const MAX_ROUNDS = 3;               // 3 rounds = 15 min total
    const log = (msg) => verboseLog(`[tab-${tabId}] ${msg}`);
    const warn = (msg) => verboseWarn(`[tab-${tabId}] ${msg}`);

    // ── Helper: reload page with retry until it loads successfully ──
    // Keeps retrying every 3 sec until page loads or content is not "failed to load"
    async function reloadUntilSuccess(maxRetries = 10) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await pg.reload({ waitUntil: "domcontentloaded" });
                const isFailed = await pg.evaluate(() => {
                    return document.body?.innerText?.includes("Content failed to load") ?? false;
                }).catch(() => false);
                if (!isFailed) {
                    log(`Reload successful on attempt ${attempt}`);
                    return true;
                }
                warn(`Attempt ${attempt}: "Content failed to load" detected — retrying in 3 sec…`);
            } catch (err) {
                warn(`Attempt ${attempt}: Reload failed (${err.message}) — retrying in 3 sec…`);
            }
            await sleep(3000);
        }
        throw new Error(`Failed to reload page after ${maxRetries} attempts.`);
    }

    // ── Step 1: Detect generation, or return if it finished before polling began ──
    let generationStarted = false;
    while (Date.now() - start < timeoutMs) {
        await assertNoOpenAiSomethingWentWrong(pg, tabId);
        await assertNoRateLimit(pg, tabId);
        const state = await readLatexResponseState(pg);
        if (state.latex) {
            log(`✓ Complete LaTeX found in ${state.source} before Stop appeared.`);
            return state.latex;
        }
        if (state.stopVisible) {
            generationStarted = true;
            log("Stop button appeared — generation is running.");
            break;
        }
        await sleep(APPEAR_POLL_MS);
    }
    if (!generationStarted) {
        await assertNoOpenAiSomethingWentWrong(pg, tabId);
        await assertNoRateLimit(pg, tabId);
        warn("Stop button never appeared — may have already finished or was missed; proceeding to completion check.");
    }

    // ── Step 2: Poll until Stop is gone and either response layout has complete LaTeX ──
    for (let round = 1; round <= MAX_ROUNDS; round++) {
        const roundStart = Date.now();
        log(`Completion check round ${round}/${MAX_ROUNDS} — polling every 10 s for up to 5 min…`);

        while (Date.now() - roundStart < ROUND_MS) {
            await assertNoOpenAiSomethingWentWrong(pg, tabId);
            await assertNoRateLimit(pg, tabId);
            const state = await readLatexResponseState(pg);
            if (state.latex) {
                log(`✓ Complete LaTeX extracted from ${state.source} in round ${round}.`);
                return state.latex;
            }
            await sleep(COMPLETION_POLL_MS);
        }

        if (round < MAX_ROUNDS) {
            warn(`Round ${round} timed out after 5 min — reloading page and starting round ${round + 1}…`);
            await reloadUntilSuccess(10);
            await sleep(3000);
        }
    }

    throw new Error(
        "LaTeX not extracted after 3 × 5 min completion rounds. " +
        "No complete LaTeX document was found after generation stopped in either response layout."
    );
}

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

app.get("/health", (_req, res) => {
    const busyWorkers = workers.filter((w) => w.busy).length;
    const idleWorkers = workers.filter((w) => !w.busy).length;
    res.json({
        ok: true,
        queueLength: queue.length,
        workerCount: workers.length,
        busyWorkers,
        idleWorkers,
        initialized,
        workers: workers.map((w) => ({
            id: w.id,
            busy: w.busy,
            status: w.status,
            title: w.currentJob?.title || "",
            company: w.currentJob?.company || "",
            jobUrl: w.currentJob?.jobUrl || "",
            elapsedSec: w.currentJob?.startedAt ? Math.round((Date.now() - w.currentJob.startedAt) / 1000) : 0,
        })),
    });
});

/**
 * POST /generate-latex
 * Body: { "jobUrl": "string" }
 * Optional: { "newChat": boolean, "timeoutMs": number, "outputName": string }
 *
 * The route just validates and queues. The worker handles:
 *   1. Scraping the job URL (open → 3s wait → extract; 1 reload retry)
 *   2. Building the prompt from data/resume.tex + data/prompt-template.txt
 *   3. Sending to ChatGPT and saving the result
 */

app.post("/generate-latex", async (req, res) => {
    const { jobUrl, jobrightJobId, postedAt, title, company, mode = "autoApply", newChat = true, timeoutMs = 180_000, outputName } = req.body;

    if (!jobUrl) {
        return res.status(400).json({ error: "Required: 'jobUrl'." });
    }

    if (!fs.existsSync(RESUME_PATH)) {
        return res.status(500).json({ error: `resume.tex not found at ${RESUME_PATH} — place it in ${DATA_DIR_NAME}/` });
    }
    if (!fs.existsSync(PROMPT_TEMPLATE_PATH)) {
        return res.status(500).json({ error: `prompt-template.txt not found at ${PROMPT_TEMPLATE_PATH} — place it in ${DATA_DIR_NAME}/` });
    }

    const normUrl = normalizeQueueUrl(jobUrl);
    const postedAtMs = parsePostedAtEpoch(postedAt);

    // Check if already in queue
    const existingIndex = queue.findIndex((item) => normalizeQueueUrl(item.data?.jobUrl) === normUrl);
    if (existingIndex !== -1) {
        if (postedAtMs > (queue[existingIndex].postedAtMs || 0)) {
            queue[existingIndex].postedAtMs = postedAtMs;
            sortPriorityQueue();
        }
        const pos = queue.findIndex((item) => item.jobId === queue[existingIndex].jobId) + 1;
        return res.status(202).json({
            ok: true,
            queued: true,
            alreadyQueued: true,
            jobId: queue[existingIndex].jobId,
            position: pos,
        });
    }

    const jobId = ++jobCounter;
    queue.push({
        jobId,
        postedAtMs,
        data: { jobId, jobUrl, jobrightJobId: jobrightJobId || null, postedAt, title, company, mode, outputName, newChat, timeoutMs },
    });
    sortPriorityQueue();

    const position = queue.findIndex((item) => item.jobId === jobId) + 1;
    res.status(202).json({ ok: true, queued: true, jobId, position });
});

// ─────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────
process.on("SIGINT", async () => {
    console.log("\nShutting down…");
    for (const ctx of browserContexts) {
        try { await ctx.close(); } catch (_) { }
    }
    process.exit(0);
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, async () => {
    const accounts = loadChatGptAccounts();
    console.log(`\n🚀  GPT Playwright Service  →  http://localhost:${PORT}`);
    console.log("──────────────────────────────────────────────");
    console.log(`  Workers (accounts): ${accounts.length}`);
    console.log(`  User              : ${APP_USER || "(default)"}`);
    console.log(`  Config            : ${DATA_DIR_NAME}/chatgpt-accounts.json`);
    console.log(`  ChatGPT mode      : ${chatGptModeLabel()}`);
    console.log(`  ChatGPT model     : ${CHATGPT_MODE === "work" ? (getChatGptModelConfig().baseModel || "(not set — using whatever ChatGPT last selected)") : "(ignored in Chat mode)"}`);
    console.log(`  ChatGPT thinking  : ${CHATGPT_MODE === "work" ? (getChatGptModelConfig().effortLabel || "(not set)") : "(ignored in Chat mode)"}`);
    console.log(`  GET  http://localhost:${PORT}/health`);
    console.log(`  POST http://localhost:${PORT}/generate-latex`);
    console.log("──────────────────────────────────────────────");
    for (let i = 0; i < accounts.length; i++) {
        console.log(`  [worker-${i}] ${accounts[i]}`);
    }
    console.log("──────────────────────────────────────────────\n");
    console.log("Opening browsers… Log in to ChatGPT in each window if prompted.\n");
    await initBrowserPool();
});
