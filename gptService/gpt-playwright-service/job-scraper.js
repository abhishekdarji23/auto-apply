/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * job-scraper.js
 *
 * Opens a job posting URL in a new browser page, detects the ATS,
 * delegates scraping to the ATS module's exported scrapeJobDetails function,
 * then closes the page.
 *
 * Usage:
 *   const { scrapeJobDetails } = require("./job-scraper");
 *   const { title, description, atsId } = await scrapeJobDetails(browserContext, jobUrl, jobrightJobId);
 *
 * To add scraping support for a new ATS: implement and export
 *   scrapeJobDetails(page, jobrightJobId?) in that ATS's index.mjs.
 */

const path = require("path");
const { pathToFileURL } = require("url");
const { detectAts } = require("./ats-map");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACTIVE_GPT_SERVICE_ATS = new Set(["workday", "greenhouse"]);

// ─────────────────────────────────────────────────────────────────────────────
// scrapeJobDetails(browserContext, jobUrl, jobrightJobId?)
//
// Opens jobUrl in a fresh page, detects the ATS, dynamically imports its
// index.mjs module, and calls module.scrapeJobDetails(page, jobrightJobId).
// Retries once (with page reload) if the first attempt returns empty fields.
//
// Returns: { title, description, atsId, atsName }
// Throws:  if ATS unsupported, module missing scrapeJobDetails, or fields
//          cannot be extracted after retries.
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeJobDetails(browserContext, jobUrl, jobrightJobId = null) {
    const ats = await detectAts(jobUrl);
    if (!ats) {
        throw new Error(`Unsupported ATS for URL: ${jobUrl}`);
    }
    if (!ACTIVE_GPT_SERVICE_ATS.has(ats.id)) {
        throw new Error(`Unsupported ATS for GPT service: ${ats.id}`);
    }

    const modulePath = path.resolve(
        __dirname,
        "../../scripts/ats/ats_scripts",
        ats.id,
        "index.mjs"
    );

    let atsModule;
    try {
        atsModule = await import(pathToFileURL(modulePath).href);
    } catch (e) {
        throw new Error(`Failed to load ATS module for "${ats.id}": ${e.message}`);
    }

    if (typeof atsModule.scrapeJobDetails !== "function") {
        throw new Error(`ATS module "${ats.id}" does not export a scrapeJobDetails function`);
    }

    const page = await browserContext.newPage();
    try {
        let response;
        try {
            response = await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        } catch (navErr) {
            const msg = String(navErr.message || "");
            if (msg.includes("ERR_NAME_NOT_RESOLVED") || msg.includes("ERR_CONNECTION_REFUSED") || msg.includes("net::ERR_") || msg.includes("Timeout")) {
                throw new Error(`dead_link: ${msg}`);
            }
            throw navErr;
        }

        if (response && (response.status() === 404 || response.status() === 410)) {
            throw new Error(`dead_link_or_404: HTTP ${response.status()}`);
        }

        await sleep(3000);

        // Check DOM for known expired/not-found indicators
        const pageText = await page.evaluate(() => document.body?.innerText?.toLowerCase() || "").catch(() => "");
        if (ats.id === "workday") {
            if (pageText.includes("job is no longer available") ||
                pageText.includes("the page you are looking for doesn't exist") ||
                pageText.includes("job not found")) {
                throw new Error("workday_page_not_found");
            }
        } else if (ats.id === "greenhouse") {
            if (pageText.includes("sorry, but we can't find that page") || pageText.includes("404: not found")) {
                throw new Error("greenhouse_page_not_found");
            }
        }

        // First attempt: page scrape only (no fallback yet)
        let { title, description } = await atsModule.scrapeJobDetails(page, null);

        if (!title || !description) {
            // Reload, then try again — pass jobrightJobId so fallback fires exactly once
            await page.reload({ waitUntil: "domcontentloaded" });
            await sleep(3000);
            ({ title, description } = await atsModule.scrapeJobDetails(page, jobrightJobId));
        }

        if (!title || !description) {
            if (ats.id === "workday") {
                throw new Error("workday_page_not_found");
            }
            if (ats.id === "greenhouse") {
                throw new Error("greenhouse_page_not_found");
            }
            throw new Error(`dead_link_or_404: could not extract content from ${jobUrl}`);
        }

        return { title, description, atsId: ats.id, atsName: ats.name };

    } finally {
        await page.close().catch(() => { });
    }
}

module.exports = { scrapeJobDetails };
