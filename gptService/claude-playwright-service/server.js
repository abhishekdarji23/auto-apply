/* eslint-disable @typescript-eslint/no-require-imports */
const express = require("express");
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL: NodeURL } = require("url");
const { loadUserEnv, getAppUser, getDataDirName, getDataPath } = require("../../scripts/lib/user-config.cjs");
// Reuse the existing scraper + ats-map from the GPT service
const { scrapeJobDetails } = require("../gpt-playwright-service/job-scraper");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
loadUserEnv(PROJECT_ROOT);

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.CLAUDE_PORT || process.env.PORT || 4001;
const APP_USER = getAppUser(PROJECT_ROOT);
const DATA_DIR_NAME = getDataDirName(PROJECT_ROOT);
const RESUME_PATH = getDataPath(PROJECT_ROOT, "resume.tex");
const PROMPT_TEMPLATE_PATH = getDataPath(PROJECT_ROOT, "prompt-template.txt");
const CLAUDE_ACCOUNTS_PATH = getDataPath(PROJECT_ROOT, "claude-accounts.json");
const USER_DATA_DIR_PREFIX = path.join(__dirname, "pw-user-data"); // pw-user-data-0, pw-user-data-1, …
const MAX_TABS_PER_ACCOUNT = 2; // user wants 2 chats in parallel
const RESUME_SAVE_ENDPOINT = process.env.RESUME_SAVE_ENDPOINT || "http://localhost:3000/api/resume";
const TRACKER_SAVE_ENDPOINT = process.env.TRACKER_SAVE_ENDPOINT || "http://localhost:3000/api/auto-apply-tracker/save";
const CLAUDE_SERVICE_LOG_MODE = (process.env.CLAUDE_SERVICE_LOG_MODE || "compact").toLowerCase();
const VERBOSE_LOGS = CLAUDE_SERVICE_LOG_MODE === "verbose";

if (!VERBOSE_LOGS && process.env.SCRAPER_VERBOSE_LOGS === undefined) {
    process.env.SCRAPER_VERBOSE_LOGS = "false";
}

// ─────────────────────────────────────────────
// Load Claude account URLs from data/claude-accounts.json
// Falls back to the env var CLAUDE_URL, then https://claude.ai/new
// ─────────────────────────────────────────────
function loadClaudeAccounts() {
    try {
        const raw = fs.readFileSync(CLAUDE_ACCOUNTS_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map(String);
        }
    } catch (_) { }
    const envUrl = process.env.CLAUDE_URL;
    return [envUrl || "https://claude.ai/new"];
}

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

/** @type {{ page: import('playwright').Page, id: number, claudeUrl: string, context: import('playwright').BrowserContext }[]} */
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
    if (/Could not find the Claude prompt input/i.test(message)) return "PROMPT_INPUT_NOT_FOUND";
    if (/Failed to reload page/i.test(message)) return "PAGE_RELOAD_FAILED";
    if (/page is closed/i.test(message)) return "WORKER_PAGE_CLOSED";
    if (/Unsupported ATS/i.test(message)) return "UNSUPPORTED_ATS";
    if (/rate limit/i.test(message)) return "RATE_LIMITED";

    return message.length > 140 ? `${message.slice(0, 137)}...` : message;
}

function shouldRetryJob(err) {
    const message = (err instanceof Error ? err.message : String(err || "")).trim();
    if (!message) return true;
    return true;
}

const CLAUDE_OUTPUT_INSTRUCTION = [
    "",
    "### OUTPUT FORMAT (MUST FOLLOW)",
    "- Return ONLY the complete LaTeX code for the resume.",
    "- Wrap it in a single markdown code block using triple backticks and the 'latex' language tag (```latex ... ```).",
    "- Do NOT use an artifact, side panel, file download, or any attachment — paste the full code inline in the chat so it can be copied directly.",
    "- Do NOT include any explanation, commentary, or text outside the code block.",
].join("\n");

function buildPrompt(template, resumeLatex, jobDescription) {
    return template
        .replace("{{RESUME_LATEX}}", resumeLatex)
        .replace("{{JOB_DESCRIPTION}}", jobDescription) +
        CLAUDE_OUTPUT_INSTRUCTION;
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

// ─────────────────────────────────────────────
// Browser pool — one persistent context per Claude account
// All workers share a single queue.
// ─────────────────────────────────────────────
async function initBrowserPool() {
    const accounts = loadClaudeAccounts();
    const headless = process.env.HEADLESS === "true";

    console.log(`Launching ${accounts.length} browser instance(s) in ${headless ? "headless" : "headed"} mode…`);

    for (let i = 0; i < accounts.length; i++) {
        const claudeUrl = accounts[i];
        const userDataDir = `${USER_DATA_DIR_PREFIX}-${i}`;

        if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
        }

        const ctx = await chromium.launchPersistentContext(userDataDir, {
            headless,
            viewport: { width: 1400, height: 900 },
            args: ["--disable-blink-features=AutomationControlled"],
        });
        browserContexts.push(ctx);

        const existingPages = ctx.pages();
        const firstPage = existingPages[0] || await ctx.newPage();
        await firstPage.goto(claudeUrl, { waitUntil: "domcontentloaded" }).catch(() => { });
        console.log(`[browser-${i}] ready — log in to Claude if prompted  (${claudeUrl})`);

        // Spawn MAX_TABS_PER_ACCOUNT workers for this context (2 parallel chats)
        for (let t = 0; t < MAX_TABS_PER_ACCOUNT; t++) {
            const workerId = i * MAX_TABS_PER_ACCOUNT + t;
            const pg = t === 0 ? firstPage : await ctx.newPage();
            if (t > 0) {
                await pg.goto(claudeUrl, { waitUntil: "domcontentloaded" }).catch(() => { });
            }
            workers.push({ page: pg, id: workerId, claudeUrl, context: ctx, busy: false, status: "idle", currentJob: null });
        }
    }

    initialized = true;

    for (let i = 0; i < workers.length; i++) {
        await sleep(i * 2000);
        workerLoop(workers[i]);
    }
    console.log(`${workers.length} worker(s) started (${loadClaudeAccounts().length} account(s) × ${MAX_TABS_PER_ACCOUNT} tab(s)) — sharing 1 queue.`);
}

async function workerLoop(worker) {
    const { page: pg, id, claudeUrl, context } = worker;
    verboseLog(`[worker-${id}] started  claudeUrl=${claudeUrl}`);
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
        worker.status = "working";
        worker.currentJob = { jobId: job.jobId, jobUrl: job.data.jobUrl, startedAt: Date.now() };

        console.log(`#${job.jobId} START [worker-${id}] | ${job.data.jobUrl}`);
        verboseLog(`[worker-${id}] #${job.jobId}  ${job.data.jobUrl.replace(/^https?:\/\//, "")}  (queue: ${queue.length})`);
        let result = null;
        let finalError = null;
        let resumeTitle = "";

        try {
            try {
                result = await processJob(pg, id, job.data, claudeUrl, context);
            } catch (err) {
                finalError = attachResumeTitle(err, "");
                resumeTitle = getErrorResumeTitle(finalError);
                verboseWarn(`[worker-${id}] #${job.jobId} FAIL (attempt 1): ${finalError.message}`);
                if (!shouldRetryJob(finalError)) {
                    verboseLog(`[worker-${id}] #${job.jobId} marked as non-retryable.`);
                } else {
                    verboseLog(`[worker-${id}] #${job.jobId} retrying...`);
                    try {
                        result = await processJob(pg, id, { ...job.data, newChat: true }, claudeUrl, context);
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

async function processJob(pg, workerId, data, claudeUrl, context) {
    const { jobId, jobUrl, jobrightJobId, outputName, newChat = true, timeoutMs = 180_000 } = data;
    const tag = `[worker-${workerId}] #${jobId}`;
    let resumeTitle = "";

    try {
        if (pg.isClosed()) throw new Error(`Worker ${workerId} page is closed.`);

        // ── Step 1: Scrape the job posting ──
        const scraped = await scrapeJobDetails(context, jobUrl, jobrightJobId);
        const { title, description: jd, atsId, atsName } = scraped;
        resumeTitle = title;

        // ── Step 2: Build the prompt ──
        const resumeLatex = fs.readFileSync(RESUME_PATH, "utf-8");
        const template = fs.readFileSync(PROMPT_TEMPLATE_PATH, "utf-8");
        const prompt = buildPrompt(template, resumeLatex, jd);

        const resolvedName = (outputName && outputName.trim())
            ? outputName.trim()
            : deriveFilenameFromUrl(jobUrl, title);

        verboseLog(`${tag}  scraped "${title}"  (${atsName}, ${jd.length} chars)  →  ${resolvedName}.tex`);

        // ── Step 3: Claude generation ──
        verboseLog(`${tag}  generating...`);
        await pg.bringToFront();

        if (newChat) {
            await pg.goto(claudeUrl, { waitUntil: "domcontentloaded" });
            await sleep(1500);
        }

        const composer = await getComposer(pg, workerId);
        await fillComposer(pg, composer, prompt);
        await sleep(2000); // user requested 2 sec wait before sending
        await clickSend(pg);

        const latex = await waitForAssistantResponse(pg, workerId, timeoutMs);
        return { latex, latexLength: latex.length, atsId, atsName, title, outputName: resolvedName };
    } catch (err) {
        throw attachResumeTitle(err, resumeTitle);
    }
}

// ─────────────────────────────────────────────
// Find the Claude composer (contenteditable [data-testid="chat-input"])
// ─────────────────────────────────────────────
async function getComposer(pg, workerId) {
    const selectors = [
        '[data-testid="chat-input"]',
        'div[contenteditable="true"][data-testid="chat-input"]',
        'div[contenteditable="true"]',
    ];

    async function tryFind() {
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
        `[worker-${workerId}] Could not find the Claude prompt input. Make sure you are logged in in window ${workerId}.`
    );
}

// ─────────────────────────────────────────────
// Fill the Claude composer (matches user's snippet:
//   editor.innerHTML = '<p>...</p>'
//   editor.dispatchEvent(new InputEvent('input', { bubbles: true }))
// )
// ─────────────────────────────────────────────
async function fillComposer(pg, composer, text) {
    await composer.click({ timeout: 5000 });

    // Convert text to <p>...</p> blocks per line, escaping HTML
    const escaped = text
        .split("\n")
        .map((line) => {
            const safe = line
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
            return `<p>${safe || "<br>"}</p>`;
        })
        .join("");

    const ok = await pg.evaluate(
        ({ html }) => {
            const editor = document.querySelector('[data-testid="chat-input"]')
                || document.querySelector('div[contenteditable="true"]');
            if (!editor) return false;
            editor.focus();
            editor.innerHTML = html;
            editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
            return true;
        },
        { html: escaped }
    );

    if (!ok) {
        // Fallback: clipboard paste
        await pg.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await pg.keyboard.press("Backspace");
        await sleep(100);
        const pasted = await pg.evaluate((t) => {
            const el = document.activeElement;
            if (!el) return false;
            try {
                const dt = new DataTransfer();
                dt.setData("text/plain", t);
                el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
                return true;
            } catch (_) { return false; }
        }, text);
        if (!pasted) {
            await pg.keyboard.type(text, { delay: 5 });
        }
    }
}

// ─────────────────────────────────────────────
// Click the Send button (matches user's snippet: button[aria-label="Send message"])
// ─────────────────────────────────────────────
async function clickSend(pg) {
    const selectors = [
        'button[aria-label="Send message"]',
        'button[aria-label*="Send"]',
        'button[aria-label*="send"]',
        'button[data-testid="send-button"]',
    ];

    for (const s of selectors) {
        const btn = pg.locator(s).first();
        if (await btn.count() > 0) {
            try {
                await btn.waitFor({ state: "visible", timeout: 2000 });
                await btn.click({ timeout: 3000 });
                return;
            } catch (_) { }
        }
    }

    await pg.keyboard.press("Enter");
}

// ─────────────────────────────────────────────
// Wait for Claude to finish generating
//
// Strategy (matches user's JS snippet):
//   Look for a div[data-test-render-count="1"] containing pre > code
//   whose innerText (trimmed) ends with \end{document}.
//
// Retry: poll every 1s for up to 5 min, reload, repeat (3 rounds = 15 min).
// ─────────────────────────────────────────────
async function waitForAssistantResponse(pg, tabId, _timeoutMs = 120_000) {
    const POLL_MS = 1000;
    const ROUND_MS = 5 * 60 * 1000;   // 5 min per round
    const MAX_ROUNDS = 3;             // 3 × 5 min = 15 min total
    const log = (msg) => verboseLog(`[tab-${tabId}] ${msg}`);
    const warn = (msg) => verboseWarn(`[tab-${tabId}] ${msg}`);

    async function extractFinishedLatex() {
        return pg.evaluate(() => {
            const containers = document.querySelectorAll('div[data-test-render-count="1"]');
            for (const container of containers) {
                const codeEl = container.querySelector("pre code");
                if (!codeEl) continue;
                const latex = (codeEl.innerText || "").trim();
                if (latex.endsWith("\\end{document}")) return latex;
            }
            return null;
        }).catch(() => null);
    }

    async function reloadUntilSuccess(maxRetries = 10) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await pg.reload({ waitUntil: "domcontentloaded" });
                return true;
            } catch (err) {
                warn(`Reload attempt ${attempt} failed (${err.message}) — retrying in 3 sec…`);
            }
            await sleep(3000);
        }
        throw new Error(`Failed to reload page after ${maxRetries} attempts.`);
    }

    for (let round = 1; round <= MAX_ROUNDS; round++) {
        const roundStart = Date.now();
        log(`Completion check round ${round}/${MAX_ROUNDS} — polling every 1 s for up to 5 min…`);

        while (Date.now() - roundStart < ROUND_MS) {
            const latex = await extractFinishedLatex();
            if (latex) {
                log(`✓ \\end{document} detected in round ${round} — LaTeX extracted.`);
                return latex;
            }
            await sleep(POLL_MS);
        }

        if (round < MAX_ROUNDS) {
            warn(`Round ${round} timed out after 5 min — reloading page and starting round ${round + 1}…`);
            await reloadUntilSuccess(10);
            await sleep(3000);
        }
    }

    throw new Error(
        "LaTeX not extracted after 15 min total (3 × 5 min rounds). " +
        "div[data-test-render-count=\"1\"] > pre code ending with \\end{document} was never found. Giving up."
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
    });
});

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
    const accounts = loadClaudeAccounts();
    console.log(`\n🚀  Claude Playwright Service  →  http://localhost:${PORT}`);
    console.log("──────────────────────────────────────────────");
    console.log(`  Workers (accounts): ${accounts.length}`);
    console.log(`  Tabs per account  : ${MAX_TABS_PER_ACCOUNT}`);
    console.log(`  User              : ${APP_USER || "(default)"}`);
    console.log(`  Config            : ${DATA_DIR_NAME}/claude-accounts.json`);
    console.log(`  GET  http://localhost:${PORT}/health`);
    console.log(`  POST http://localhost:${PORT}/generate-latex`);
    console.log("──────────────────────────────────────────────");
    for (let i = 0; i < accounts.length; i++) {
        console.log(`  [worker-${i}] ${accounts[i]}`);
    }
    console.log("──────────────────────────────────────────────\n");
    console.log("Opening browsers… Log in to Claude in each window if prompted.\n");
    await initBrowserPool();
});
