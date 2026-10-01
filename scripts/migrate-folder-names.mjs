/**
 * One-time migration: rename encodeURIComponent(url) folder names
 * to the new u{sha256-decimal-18} hash names.
 *
 * Usage:  node scripts/migrate-folder-names.mjs [--dry-run]
 *
 * Pass --dry-run to preview renames without touching the filesystem.
 */

import { createHash } from "node:crypto";
import { readdir, rename, access } from "node:fs/promises";
import { constants as fsC } from "node:fs";
import path from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");
const GENERATED_ROOT = new URL("../generated-resumes", import.meta.url).pathname;
const KEY_LENGTH = Math.max(8, Math.min(32, Number(process.env.RESUME_FOLDER_KEY_LENGTH || 18)));

// ── same algorithm as resumeFolderKey.ts ──────────────────────────────────────
function toNumericHash(input) {
    const bytes = createHash("sha256").update(input).digest();
    return Array.from(bytes, (b) => String(b % 10)).join("");
}

function getNewFolderName(url) {
    const digits = toNumericHash(String(url || "").trim());
    return `u${digits.slice(0, KEY_LENGTH)}`;
}

function isLegacyFolder(name) {
    // Legacy names are encodeURIComponent output: start with "https%3A" or similar
    return name.startsWith("https%3A") || name.startsWith("http%3A");
}

// ── walk generated-resumes/{mode}/{email}/ ────────────────────────────────────
async function main() {
    let renamed = 0;
    let skipped = 0;
    let conflicts = 0;

    const modes = await readdir(GENERATED_ROOT).catch(() => []);

    for (const mode of modes) {
        const modeDir = path.join(GENERATED_ROOT, mode);
        const emails = await readdir(modeDir).catch(() => []);

        for (const email of emails) {
            const emailDir = path.join(modeDir, email);
            const folders = await readdir(emailDir).catch(() => []);

            for (const folder of folders) {
                if (!isLegacyFolder(folder)) {
                    // Already a hash name (or something else) — skip
                    skipped++;
                    continue;
                }

                // Decode the legacy name back to the original URL
                let originalUrl;
                try {
                    originalUrl = decodeURIComponent(folder);
                } catch {
                    console.warn(`  WARN  cannot decode: ${folder}`);
                    skipped++;
                    continue;
                }

                const newName = getNewFolderName(originalUrl);
                const oldPath = path.join(emailDir, folder);
                const newPath = path.join(emailDir, newName);

                // Check for collision
                const exists = await access(newPath, fsC.F_OK).then(() => true).catch(() => false);
                if (exists) {
                    console.warn(`  CONFLICT  ${newName} already exists — skipping ${folder}`);
                    conflicts++;
                    continue;
                }

                if (DRY_RUN) {
                    console.log(`  DRY  ${email}/${folder}`);
                    console.log(`    →  ${newName}  (url: ${originalUrl})`);
                } else {
                    await rename(oldPath, newPath);
                    console.log(`  OK  ${email}/${folder} → ${newName}`);
                }
                renamed++;
            }
        }
    }

    console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}Done — renamed: ${renamed}, skipped: ${skipped}, conflicts: ${conflicts}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
