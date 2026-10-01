/**
 * ats-map.mjs
 *
 * Maps URL patterns → ATS identifier.
 * Patterns use glob-style wildcards (* matches any chars except /,  ** matches any).
 * The first matching entry wins.
 *
 * ATS Scripts live at: scripts/ats/ats_scripts/<atsId>.mjs
 * Each script exports a default async function: apply(page, job, browser)
 */

export const ATS_MAP = [
    // ── Workday ────────────────────────────────────────────────────────────────
    {
        id: "workday",
        name: "Workday",
        urls: [
            "*://*.myworkdayjobs.com/*",
            "*://*.myworkdaysite.com/*",
        ],
        selectors: {
            title: '[data-automation-id="jobPostingHeader"]',
            description: '[data-automation-id="jobPostingDescription"]',
        },
    },

    // ── Greenhouse ─────────────────────────────────────────────────────────────
    {
        id: "greenhouse",
        name: "Greenhouse",
        urls: [
            "*://boards.greenhouse.io/*",
            "*://job-boards.greenhouse.io/*",
        ],
        selectors: {
            title: "h1.section-header",
            description: "div.job__description",
        },
    },

    // ── Lever ──────────────────────────────────────────────────────────────────
    {
        id: "lever",
        name: "Lever",
        urls: [
            "*://jobs.lever.co/*",
            "*://jobs.eu.lever.co/*",
        ],
    },

    // ── Ashby ──────────────────────────────────────────────────────────────────
    {
        id: "ashby",
        name: "Ashby",
        urls: [
            "*://jobs.ashbyhq.com/*",
        ],
    },

    // ── iCIMS ──────────────────────────────────────────────────────────────────
    {
        id: "icims",
        name: "iCIMS",
        urls: [
            "*://*.icims.com/*",
        ],
    },

    // ── Taleo ──────────────────────────────────────────────────────────────────
    {
        id: "taleo",
        name: "Taleo",
        urls: [
            "*://*.taleo.net/*",
        ],
    },

    // ── BambooHR ───────────────────────────────────────────────────────────────
    {
        id: "bamboohr",
        name: "BambooHR",
        urls: [
            "*://*.bamboohr.com/careers/*",
        ],
    },

    // ── SmartRecruiters ────────────────────────────────────────────────────────
    {
        id: "smartrecruiters",
        name: "SmartRecruiters",
        urls: [
            "*://jobs.smartrecruiters.com/*",
        ],
    },

    // ── Rippling ───────────────────────────────────────────────────────────────
    {
        id: "rippling",
        name: "Rippling",
        urls: [
            "*://ats.rippling.com/*",
        ],
    },
];

/**
 * Given a job URL string, return the matching ATS entry or null.
 * @param {string} url
 * @returns {{ id: string, name: string } | null}
 */
export function detectATS(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }

    for (const ats of ATS_MAP) {
        for (const pattern of ats.urls) {
            if (matchGlob(pattern, url)) return ats;
        }
    }
    return null;
}

/**
 * Simple glob matcher supporting * (no-slash) and ** (any).
 * Pattern format: scheme://host/path  — e.g. *://*.myworkdayjobs.com/*
 */
function matchGlob(pattern, url) {
    // Convert glob to a regex
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex special chars except * ?
        .replace(/\*\*\//g, "(.*/)?")           // **/ → any path segment prefix
        .replace(/\*\*/g, ".*")                 // ** → any
        .replace(/\*/g, "[^/]*");               // * → no-slash wildcard

    try {
        return new RegExp(`^${escaped}`, "i").test(url);
    } catch {
        return false;
    }
}
