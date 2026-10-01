#!/usr/bin/env node
/**
 * Delete all tracker records where status is "failed".
 *
 * Usage: node scripts/delete-failed-jobs.mjs
 */

import { getJobtrackOrigin } from "./lib/user-config.mjs";

const ORIGIN = getJobtrackOrigin();

async function httpJson(url, init = undefined) {
    const res = await fetch(url, init);
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { res, json };
}

async function main() {
    console.log(`[delete-failed-jobs] Fetching all tracker records from ${ORIGIN}…`);

    const { res, json } = await httpJson(`${ORIGIN}/api/auto-apply-tracker`);
    if (!res.ok || !json?.rows) {
        console.error(`[delete-failed-jobs] ❌ Failed to fetch tracker records: ${res.status}`, json);
        process.exit(1);
    }

    const allRows = json.rows;
    console.log(`[delete-failed-jobs] Total records: ${allRows.length}`);

    const targets = allRows.filter((row) =>
        String(row.status || "").toLowerCase() === "failed"
    );

    if (targets.length === 0) {
        console.log("[delete-failed-jobs] ✅ Nothing to delete — no failed jobs found.");
        return;
    }

    console.log(`[delete-failed-jobs] Found ${targets.length} record(s) to delete:`);
    for (const row of targets) {
        console.log(`  • ${row.company || "(no company)"} — ${row.title || "(no title)"} (${row.lastError || "unknown error"})`);
    }
    console.log();

    const ids = targets.map((r) => r._id);
    const BATCH = 50;
    let deleted = 0;
    let failed = 0;

    for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        const { res: r, json: j } = await httpJson(
            `${ORIGIN}/api/auto-apply-tracker`,
            {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: batch }),
            }
        );

        if (r.ok && j?.deleted != null) {
            deleted += j.deleted;
            console.log(`  ✅ Batch ${Math.floor(i / BATCH) + 1}: deleted ${j.deleted}`);
        } else {
            failed += batch.length;
            console.error(`  ❌ Batch ${Math.floor(i / BATCH) + 1} failed:`, j);
        }
    }

    console.log();
    console.log(`[delete-failed-jobs] Done. ✅ ${deleted} deleted  ❌ ${failed} failed`);
}

main().catch((err) => {
    console.error("[delete-failed-jobs] Fatal:", err);
    process.exit(1);
});
