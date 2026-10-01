#!/usr/bin/env node
/**
 * Retry Google Drive upload for all tracker records where lastError contains
 * "drive_upload_failed". Updates resumePreviewLink and clears the drive error
 * from lastError on success.
 *
 * Usage: node scripts/retry-drive-upload.mjs
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
    console.error("[retry-drive] Fetching all tracked jobs…");

    const { res, json } = await httpJson(`${ORIGIN}/api/auto-apply-tracker`);
    if (!res.ok) {
        console.error(`[retry-drive] Failed to fetch tracker: HTTP ${res.status}`);
        process.exit(1);
    }

    const rows = Array.isArray(json?.rows) ? json.rows : [];
    const targets = rows.filter((r) =>
        typeof r.lastError === "string" &&
        r.lastError.includes("drive_upload_failed")
    );

    console.error(`[retry-drive] ${targets.length} records with drive_upload_failed (out of ${rows.length} total)\n`);

    if (targets.length === 0) {
        console.error("[retry-drive] Nothing to retry.");
        return;
    }

    let ok = 0;
    let fail = 0;
    const BATCH = 10;

    for (let i = 0; i < targets.length; i += BATCH) {
        const batch = targets.slice(i, i + BATCH);
        console.error(`\n[retry-drive] Batch ${Math.floor(i / BATCH) + 1} — jobs ${i + 1}–${Math.min(i + BATCH, targets.length)} of ${targets.length}`);

        const results = await Promise.all(
            batch.map(async (row) => {
                const { res: rRes, json: rJson } = await httpJson(
                    `${ORIGIN}/api/auto-apply-tracker/${row._id}/retry-drive`,
                    { method: "POST", headers: { "Content-Type": "application/json" } }
                );
                return { row, ok: rRes.ok && rJson?.success, error: rJson?.error };
            })
        );

        for (const r of results) {
            if (r.ok) {
                ok++;
                console.error(`[retry-drive] ✅ ${r.row.title || r.row._id}`);
            } else {
                fail++;
                console.error(`[retry-drive] ❌ ${r.row.title || r.row._id} — ${r.error || "unknown"}`);
            }
        }
    }

    console.error(`\n[retry-drive] Done. ✅ ${ok}  ❌ ${fail}`);
}

main().catch((e) => {
    console.error(`[retry-drive] Fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
