/**
 * Migration script: Normalize Ashby URLs and merge duplicate records.
 *
 * Usage:
 *   node scripts/one-time/normalize-ashby-urls.mjs
 *   APP_USER=rishwa node scripts/one-time/normalize-ashby-urls.mjs
 *   node scripts/one-time/normalize-ashby-urls.mjs --user=rishwa
 */

import { MongoClient } from "mongodb";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadUserEnv, getMongoUri } from "../lib/user-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const userArg = process.argv.find((arg) => arg.startsWith("--user="))?.split("=")[1];
if (userArg) {
  process.env.APP_USER = userArg.trim();
}

loadUserEnv(ROOT);
const uri = getMongoUri(ROOT);

if (!uri) {
  console.error(`[normalize-ashby] No MongoDB URI found. Check your .env.local or .env.<user>.local file.`);
  process.exit(1);
}

function cleanAshby(url) {
  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase() !== "jobs.ashbyhq.com") return url;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `https://jobs.ashbyhq.com/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
    }
    return `https://jobs.ashbyhq.com${u.pathname.replace(/\/application\/?$/i, "")}`;
  } catch {
    return url.replace(/\/application\/?$/i, "");
  }
}

function joinUnique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].join(" | ");
}

async function run() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const jobs = db.collection("jobs");

  console.log(`[normalize-ashby] Connected to DB: ${db.databaseName}`);

  const ashbyJobs = await jobs.find({ applyLink: { $regex: /ashbyhq\.com/i } }).toArray();
  console.log(`[normalize-ashby] Found ${ashbyJobs.length} Ashby jobs.`);

  if (ashbyJobs.length === 0) {
    console.log(`[normalize-ashby] No Ashby jobs found. Done.`);
    await client.close();
    return;
  }

  const map = new Map();
  for (const j of ashbyJobs) {
    const clean = cleanAshby(j.applyLink);
    if (!map.has(clean)) map.set(clean, []);
    map.get(clean).push(j);
  }

  let singleUpdates = 0;
  let mergedGroups = 0;
  let deletedDuplicates = 0;

  for (const [canonical, list] of map.entries()) {
    if (list.length === 1) {
      const j = list[0];
      if (j.applyLink !== canonical) {
        await jobs.updateOne(
          { _id: j._id },
          { $set: { applyLink: canonical, updatedAt: new Date() } }
        );
        singleUpdates++;
      }
    } else {
      mergedGroups++;
      list.sort((a, b) => {
        const aApplied = Boolean(a.applied || a.manualApplied || a.autoApplied);
        const bApplied = Boolean(b.applied || b.manualApplied || b.autoApplied);
        if (aApplied !== bApplied) return aApplied ? -1 : 1;

        const aJobright = Boolean(a.jobrightId);
        const bJobright = Boolean(b.jobrightId);
        if (aJobright !== bJobright) return aJobright ? -1 : 1;

        return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
      });

      const winner = list[0];
      const losers = list.slice(1);

      const allTabs = [...new Set(list.flatMap((j) => j.tabCategory || []))];
      const allTags = [...new Set(list.flatMap((j) => j.sourceTags || []))];

      const detailsMap = new Map();
      for (const j of list) {
        for (const d of j.sourceDetails || []) {
          if (d && d.key && !detailsMap.has(d.key)) {
            detailsMap.set(d.key, d);
          }
        }
      }
      const allDetails = Array.from(detailsMap.values());

      const allAliases = [
        ...new Set(
          list
            .flatMap((j) => [...(j.jobrightAliases || []), ...(j.jobrightId ? [j.jobrightId] : [])])
            .filter((id) => id && id !== winner.jobrightId)
        ),
      ];

      const validPostedDates = list
        .map((j) => (j.postedAt ? new Date(j.postedAt) : null))
        .filter((d) => d && !isNaN(d.getTime()));
      const earliestPostedAt = validPostedDates.length
        ? new Date(Math.min(...validPostedDates.map((d) => d.getTime())))
        : winner.postedAt;

      const sourceKind = joinUnique(list.flatMap((j) => String(j.sourceKind || "").split("|")));
      const sourceRepo = joinUnique(list.flatMap((j) => String(j.sourceRepo || "").split("|")));
      const sourceLabel = joinUnique(list.flatMap((j) => String(j.sourceLabel || "").split("|")));

      const isApplied = list.some((j) => j.applied);
      const isManualApplied = list.some((j) => j.manualApplied);
      const isAutoApplied = list.some((j) => j.autoApplied);

      const appliedAt = list.map((j) => j.appliedAt).filter(Boolean)[0] || null;
      const manualAppliedAt = list.map((j) => j.manualAppliedAt).filter(Boolean)[0] || null;
      const autoAppliedAt = list.map((j) => j.autoAppliedAt).filter(Boolean)[0] || null;

      const updateDoc = {
        applyLink: canonical,
        tabCategory: allTabs,
        sourceTags: allTags,
        sourceDetails: allDetails,
        sourceKind,
        sourceRepo,
        sourceLabel,
        postedAt: earliestPostedAt,
        applied: isApplied,
        manualApplied: isManualApplied,
        autoApplied: isAutoApplied,
        updatedAt: new Date(),
      };

      if (appliedAt) updateDoc.appliedAt = appliedAt;
      if (manualAppliedAt) updateDoc.manualAppliedAt = manualAppliedAt;
      if (autoAppliedAt) updateDoc.autoAppliedAt = autoAppliedAt;
      if (allAliases.length) updateDoc.jobrightAliases = allAliases;

      await jobs.updateOne({ _id: winner._id }, { $set: updateDoc });

      const loserIds = losers.map((l) => l._id);
      const delResult = await jobs.deleteMany({ _id: { $in: loserIds } });
      deletedDuplicates += delResult.deletedCount;

      console.log(`[normalize-ashby] Merged ${canonical}: kept ${winner.jobId}, deleted ${delResult.deletedCount} duplicates`);
    }
  }

  console.log(`\n[normalize-ashby] Finished migration:`);
  console.log(`- Single applyLink updates: ${singleUpdates}`);
  console.log(`- Duplicate groups merged: ${mergedGroups}`);
  console.log(`- Redundant duplicate documents deleted: ${deletedDuplicates}`);
  console.log(`- Total canonical Ashby jobs: ${map.size}`);

  await client.close();
}

run().catch((err) => {
  console.error("[normalize-ashby] Fatal error:", err);
  process.exit(1);
});
