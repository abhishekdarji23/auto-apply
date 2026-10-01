/**
 * ats-map.js
 *
 * Thin adapter — all ATS definitions (URL patterns + page selectors) live in
 * the shared ESM module at scripts/ats/ats-map.mjs.
 * This file lazy-loads that module on first use so CJS callers can use it.
 *
 * Exports:
 *   detectAts(url) → Promise<{ id, name, urls, selectors } | null>
 *
 * DO NOT add ATS entries here. Edit scripts/ats/ats-map.mjs instead.
 */

/** @type {((url: string) => { id: string, name: string, urls: string[], selectors?: Record<string,string> } | null) | null} */
let _detectATS = null;

async function loadShared() {
    if (_detectATS) return;
    const { detectATS } = await import("../../scripts/ats/ats-map.mjs");
    _detectATS = detectATS;
}

/**
 * Returns the matching ATS entry (including selectors) for the given URL, or null.
 * @param {string} url
 * @returns {Promise<{ id: string, name: string, selectors?: { title: string, description: string } } | null>}
 */
async function detectAts(url) {
    await loadShared();
    return _detectATS(url);
}

module.exports = { detectAts };
