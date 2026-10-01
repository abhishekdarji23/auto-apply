/**
 * src/lib/ats-map.ts
 *
 * Maps URL patterns → ATS identifier.
 * The first matching entry wins.
 * ATS automation scripts live at: scripts/ats/<id>.mjs
 */

export interface AtsEntry {
  id: string;
  name: string;
  urls: string[];
}

export const ATS_MAP: AtsEntry[] = [
  // ── Workday ────────────────────────────────────────────────────────────────
  {
    id: "workday",
    name: "Workday",
    urls: [
      "*://*.myworkdayjobs.com/*",
      "*://*.myworkdaysite.com/*",
    ],
  },

  // ── Greenhouse ─────────────────────────────────────────────────────────────
  {
    id: "greenhouse",
    name: "Greenhouse",
    urls: [
      "*://boards.greenhouse.io/*",
      "*://job-boards.greenhouse.io/*",
    ],
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
 * Simple glob matcher: * matches any chars except /,  ** matches anything.
 * Pattern format: scheme://host/path  e.g. *://*.myworkdayjobs.com/*
 */
function matchGlob(pattern: string, url: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  try {
    return new RegExp(`^${escaped}`, "i").test(url);
  } catch {
    return false;
  }
}

/**
 * Given a job URL, return the matching ATS entry or null.
 */
export function detectATS(url: string): AtsEntry | null {
  for (const ats of ATS_MAP) {
    for (const pattern of ats.urls) {
      if (matchGlob(pattern, url)) return ats;
    }
  }
  return null;
}
