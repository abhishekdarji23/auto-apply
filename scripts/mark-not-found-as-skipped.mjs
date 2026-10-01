#!/usr/bin/env node
/**
 * Find all tracker records where lastError contains
 * "workday_job_not_available" or "greenhouse_page_not_found"
 * and set their status to "skipped" so bulk apply ignores them.
 *
 * Usage: node scripts/mark-not-found-as-skipped.mjs
 *    or: npm run mark-not-found
 */

import { getJobtrackOrigin } from "./lib/user-config.mjs";

const ORIGIN = getJobtrackOrigin();

const NOT_FOUND_ERRORS = [
    "workday_job_not_available",
    "greenhouse_page_not_found",
    "workday_page_not_found",
];

async function httpJson(url, init = undefined) {
    const res = await fetch(url, init);
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { res, json };
}

async function main() {
    console.log(`[mark-not-found] Fetching all tracker records from ${ORIGIN}…`);

    const { res, json } = await httpJson(`${ORIGIN}/api/auto-apply-tracker`);
    if (!res.ok || !json?.rows) {
        console.error(`[mark-not-found] ❌ Failed to fetch tracker records: ${res.status}`, json);
        process.exit(1);
    }

    const allRows = json.rows;
    console.log(`[mark-not-found] Total records: ${allRows.length}`);

    const targets = allRows.filter((row) => {
        if (row.status === "skipped") return false; // already skipped
        const err = String(row.lastError || "");
        return NOT_FOUND_ERRORS.some((e) => err.includes(e));
    });

    if (targets.length === 0) {
        console.log("[mark-not-found] ✅ No records to update — all clear.");
        return;
    }

    console.log(`[mark-not-found] Found ${targets.length} record(s) to mark as skipped:`);
    for (const row of targets) {
        console.log(`  • ${row.company || "(no company)"} — ${row.title || "(no title)"} | error: ${row.lastError}`);
    }
    console.log();

    let ok = 0;
    let fail = 0;
    const BATCH = 10;

    for (let i = 0; i < targets.length; i += BATCH) {
        const batch = targets.slice(i, i + BATCH);
        const results = await Promise.all(
            batch.map(async (row) => {
                const { res: r, json: j } = await httpJson(
                    `${ORIGIN}/api/auto-apply-tracker`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            jobUrl: row.jobUrl,
                            status: "skipped",
                            lastError: row.lastError,
                        }),
                    }
                );
                return { row, ok: r.ok && j?.row, json: j };
            })
        );

        for (const result of results) {
            if (result.ok) {
                ok++;
                console.log(`  ✅ skipped: ${result.row.company} — ${result.row.title}`);
            } else {
                fail++;
                console.error(`  ❌ failed:  ${result.row.company} — ${result.row.title}`, result.json);
            }
        }
    }

    console.log();
    console.log(`[mark-not-found] Done. ✅ ${ok} marked skipped  ❌ ${fail} failed`);
}

main().catch((err) => {
    console.error("[mark-not-found] Fatal:", err);
    process.exit(1);
});
