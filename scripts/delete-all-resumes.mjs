#!/usr/bin/env node
/**
 * Delete all ResumeDashboardItem records from MongoDB.
 * 
 * Usage: node scripts/delete-all-resumes.mjs
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
    console.log(`[delete-all-resumes] Fetching all resume entries from ${ORIGIN}…`);

    const { res, json } = await httpJson(`${ORIGIN}/api/resume-dashboard`);
    if (!res.ok || !json?.resumes) {
        console.error(`[delete-all-resumes] ❌ Failed to fetch resumes: ${res.status}`, json);
        process.exit(1);
    }

    const allResumes = json.resumes;
    console.log(`[delete-all-resumes] Total resumes in index: ${allResumes.length}`);

    if (allResumes.length === 0) {
        console.log("[delete-all-resumes] ✅ index is already empty.");
        return;
    }

    console.log(`[delete-all-resumes] Deleting ${allResumes.length} records…`);

    // We can't batch delete through the existing API easily without a new bulk endpoint,
    // so we'll just loop and call the DELETE endpoint for each.
    // In a real prod environment we'd add a bulk DELETE route, but for a one-off script loop is fine.
    
    let deleted = 0;
    let failed = 0;

    for (const resume of allResumes) {
        const { res: r } = await httpJson(`${ORIGIN}/api/resume-dashboard`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                mode: resume.mode,
                email: resume.email,
                folder: resume.folder
            })
        });

        if (r.ok) {
            deleted++;
            process.stdout.write(".");
            if (deleted % 50 === 0) console.log(` ${deleted}`);
        } else {
            failed++;
            process.stdout.write("x");
        }
    }

    console.log();
    console.log(`[delete-all-resumes] Done. ✅ ${deleted} deleted  ❌ ${failed} failed`);
}

main().catch((err) => {
    console.error("[delete-all-resumes] Fatal:", err);
    process.exit(1);
});
