/**
 * run-ats.mjs
 *
 * Entry point spawned by the Next.js API route /api/auto-apply.
 * Reads a JSON job payload from stdin, resolves the correct ATS script,
 * connects to the browser, and runs the automation.
 *
 * Input (stdin JSON):
 *   { atsId: string, jobId: string, jobrightJobId?: string, url: string }
 *
 * Output (stdout JSON, single line):
 *   { success: true }
 *   { success: false, error: string }
 */

import { chromium } from "playwright";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import net from "net";
import { lookup as dnsLookup } from "dns/promises";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Read stdin asynchronously ─────────────────────────────────────────────────
const inputRaw = await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
});
let input;
try {
    input = JSON.parse(inputRaw);
} catch {
    process.stdout.write(JSON.stringify({ success: false, error: "invalid_stdin_json" }));
    process.exit(1);
}

const { atsId, jobId, jobrightJobId, url, defaultResume } = input ?? {};
if (!atsId || !url) {
    process.stdout.write(JSON.stringify({ success: false, error: "missing_atsId_or_url" }));
    process.exit(1);
}

const ACTIVE_APPLY_ATS = new Set(["workday", "greenhouse"]);
if (!ACTIVE_APPLY_ATS.has(String(atsId))) {
    process.stdout.write(JSON.stringify({ success: false, atsId, error: "unsupported_ats" }) + "\n");
    process.exit(1);
}

// ── Load ATS script ───────────────────────────────────────────────────────────
const atsScriptPathLegacy = path.join(__dirname, "ats_scripts", `${atsId}.mjs`);
const atsScriptPathFolder = path.join(__dirname, "ats_scripts", atsId, "index.mjs");
const atsScriptPath = fs.existsSync(atsScriptPathFolder)
    ? atsScriptPathFolder
    : atsScriptPathLegacy;
let applyFn;
try {
    const mod = await import(pathToFileURL(atsScriptPath).href);
    applyFn = mod.default;
} catch (err) {
    process.stdout.write(JSON.stringify({ success: false, error: `no_script_for_ats:${atsId} — ${err?.message}` }));
    process.exit(1);
}

if (typeof applyFn !== "function") {
    process.stdout.write(JSON.stringify({ success: false, error: `ats_script_no_default_export:${atsId}` }));
    process.exit(1);
}

// ── Connect (or launch) browser ───────────────────────────────────────────────
const CDP_URL = process.env.BRAVE_CDP_URL || "http://127.0.0.1:9222";

async function normalizeCdpUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const host = parsed.hostname || "";

        // Chrome may reject non-localhost Host headers for /json/version.
        // In containers, converting host.docker.internal (or any hostname)
        // to its numeric IP avoids that rejection and yields a valid ws URL.
        if (host && !net.isIP(host) && host.toLowerCase() !== "localhost") {
            const resolved = await dnsLookup(host);
            if (resolved?.address && net.isIP(resolved.address)) {
                parsed.hostname = resolved.address;
                return parsed.toString();
            }
        }

        return rawUrl;
    } catch {
        return rawUrl;
    }
}

const CDP_URL_NORMALIZED = await normalizeCdpUrl(CDP_URL);
if (CDP_URL_NORMALIZED !== CDP_URL) {
    console.error(`[run-ats] CDP URL normalized: ${CDP_URL} -> ${CDP_URL_NORMALIZED}`);
}

function parseCdpEndpoint(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname || "127.0.0.1";
        const protocol = parsed.protocol || "http:";
        const defaultPort = protocol === "https:" ? 443 : 80;
        const port = Number(parsed.port || defaultPort);
        return { host, port };
    } catch {
        return { host: "127.0.0.1", port: 9222 };
    }
}

async function isCdpPortOpen() {
    const { host, port } = parseCdpEndpoint(CDP_URL_NORMALIZED);
    return new Promise((resolve) => {
        const sock = net.createConnection({ host, port });
        sock.once("connect", () => { sock.destroy(); resolve(true); });
        sock.once("error", () => resolve(false));
        sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
    });
}

async function connectOverCdpWithRetry(cdpUrl) {
    const attemptTimeouts = [30000, 45000, 60000];
    const attemptErrors = [];

    for (let i = 0; i < attemptTimeouts.length; i += 1) {
        const timeout = attemptTimeouts[i];
        try {
            console.error(`[run-ats] CDP connect attempt ${i + 1}/${attemptTimeouts.length} timeout=${timeout}ms url=${cdpUrl}`);
            const browser = await chromium.connectOverCDP(cdpUrl, { timeout });
            const ctx = browser.contexts()[0];
            if (!ctx) {
                throw new Error("connected_but_no_context");
            }
            return browser;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            attemptErrors.push(`attempt${i + 1}: ${message}`);
            console.error(`[run-ats] CDP connect attempt ${i + 1} failed: ${message}`);
            if (i < attemptTimeouts.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
            }
        }
    }

    throw new Error(`cdp_connect_failed_after_retries: ${attemptErrors.join(" | ")}`);
}

const cdpOpen = await isCdpPortOpen();

let browser = null;
let result = { success: false, error: "not_run" };
try {
    if (!cdpOpen) {
        // Do NOT launch a fresh empty Chromium — that has no cookies/logins/profile.
        throw new Error(
            `brave_cdp_not_running: nothing listening on ${CDP_URL}. ` +
            `Run "npm run brave" first (opens Brave profile "rishwa" with debugging + Simplify). ` +
            `Then retry ats-bulk. GPT service Chrome is separate.`
        );
    }

    // ── CDP path ─────────────────────────────────────────────────────────────
    // Open job tabs with context.newPage() (reliable on Windows). Avoid extra
    // CDP sessions + process.exit races that trigger UV_HANDLE_CLOSING aborts.

    browser = await connectOverCdpWithRetry(CDP_URL_NORMALIZED);
    const defaultCtx = browser.contexts()[0];
    if (!defaultCtx) throw new Error("No browser context found — open at least one tab in Brave first.");

    const page = await defaultCtx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => { });
    await page.bringToFront().catch(() => { });
    await page.waitForLoadState("domcontentloaded").catch(() => { });
    console.error(`[run-ats] Opened tab (focused): ${page.url()}`);

    await page.evaluate((jobUrl) => {
        try { sessionStorage.setItem("jobtrack-tab-url", jobUrl); } catch { /* storage restricted */ }
    }, url).catch(() => { });
    console.error(`[run-ats] sessionStorage["jobtrack-tab-url"] = ${url}`);

    result = await applyFn(page, { jobId, jobrightJobId, url, defaultResume: Boolean(defaultResume) }, defaultCtx);
} catch (err) {
    result = { success: false, error: err?.message ?? "unknown_error" };
} finally {
    // Disconnect CDP cleanly before Node exits. Abrupt process.exit while the
    // WebSocket is still tearing down causes UV_HANDLE_CLOSING on Windows.
    if (browser) {
        try {
            await browser.close();
        } catch (closeErr) {
            console.error(`[run-ats] browser disconnect: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
        }
        browser = null;
    }
}

const safeResult = (result && typeof result === "object")
    ? { success: Boolean(result.success), ...result }
    : { success: false, error: "invalid_result_from_ats_script" };

process.stdout.write(JSON.stringify(safeResult) + "\n");
process.exitCode = safeResult.success ? 0 : 1;
// Let libuv finish closing handles; avoid hard process.exit() on Windows.
await new Promise((r) => setTimeout(r, 250));
