import dbConnect from "@/lib/mongodb";
import ResumeDashboardItem from "@/models/ResumeDashboardItem";
import { normalizeEmail } from "@/lib/resumeDashboardIndex";
import type { ResumeMode } from "@/lib/resumeReadResolver";

export type ResumeDashboardLocator = {
  mode: ResumeMode;
  email: string;
  folder: string;
};

type ResumeDashboardLeanItem = {
  mode?: string;
  email?: string;
  folder?: string;
  jobUrl?: string;
};

function normalizeComparableUrl(rawUrl: string): string {
  const value = String(rawUrl || "").trim();
  if (!value) return "";

  try {
    const url = new URL(value);
    url.hash = "";

    const keepEntries: Array<[string, string]> = [];
    for (const [key, val] of url.searchParams.entries()) {
      if (key.toLowerCase().startsWith("utm_")) continue;
      keepEntries.push([key.toLowerCase(), val.toLowerCase()]);
    }

    keepEntries.sort((a, b) => {
      if (a[0] === b[0]) return a[1].localeCompare(b[1]);
      return a[0].localeCompare(b[0]);
    });

    url.search = "";
    for (const [key, val] of keepEntries) {
      url.searchParams.append(key, val);
    }

    return url.toString().toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function toLocator(doc: ResumeDashboardLeanItem | null): ResumeDashboardLocator | null {
  if (!doc) return null;
  const modeRaw = String(doc.mode || "").trim();
  let mode: ResumeMode | null = null;
  if (modeRaw === "autoApply" || modeRaw === "manualApply") {
    mode = modeRaw;
  }
  const email = String(doc.email || "").trim();
  const folder = String(doc.folder || "").trim();
  if (!mode || !email || !folder) return null;
  return { mode, email, folder };
}

function buildExactQueryVariants(params: {
  jobUrlLower: string;
  preferredMode?: string;
  preferredEmail?: string;
}): Array<Record<string, unknown>> {
  const { jobUrlLower, preferredMode, preferredEmail } = params;
  const variants: Array<Record<string, unknown>> = [];

  if (preferredMode && preferredEmail) {
    variants.push({ jobUrlLower, mode: preferredMode, email: preferredEmail });
  }
  if (preferredMode) {
    variants.push({ jobUrlLower, mode: preferredMode });
  }
  if (preferredEmail) {
    variants.push({ jobUrlLower, email: preferredEmail });
  }
  variants.push({ jobUrlLower });

  return variants;
}

function buildCanonicalQueryVariants(params: {
  preferredMode?: string;
  preferredEmail?: string;
}): Array<Record<string, unknown>> {
  const { preferredMode, preferredEmail } = params;
  const variants: Array<Record<string, unknown>> = [];

  if (preferredMode && preferredEmail) {
    variants.push({ mode: preferredMode, email: preferredEmail });
  }
  if (preferredMode) {
    variants.push({ mode: preferredMode });
  }
  if (preferredEmail) {
    variants.push({ email: preferredEmail });
  }
  variants.push({});

  return variants;
}

export async function findResumeDashboardLocatorByJobUrl(params: {
  jobUrl: string;
  preferredMode?: string;
  preferredEmail?: string;
}): Promise<ResumeDashboardLocator | null> {
  const jobUrl = String(params.jobUrl || "").trim();
  if (!jobUrl) return null;

  const preferredMode = String(params.preferredMode || "").trim();
  const preferredEmailRaw = String(params.preferredEmail || "").trim();
  const preferredEmail = preferredEmailRaw ? normalizeEmail(preferredEmailRaw) : "";
  const jobUrlLower = jobUrl.toLowerCase();

  await dbConnect();

  for (const query of buildExactQueryVariants({ jobUrlLower, preferredMode, preferredEmail })) {
    const exact = await ResumeDashboardItem.findOne(
      query,
      { mode: 1, email: 1, folder: 1 }
    )
      .sort({ createdAt: -1 })
      .lean();

    const locator = toLocator(exact as ResumeDashboardLeanItem | null);
    if (locator) return locator;
  }

  const targetCanonical = normalizeComparableUrl(jobUrl);
  if (!targetCanonical) return null;

  for (const query of buildCanonicalQueryVariants({ preferredMode, preferredEmail })) {
    const candidates = await ResumeDashboardItem.find(
      query,
      { mode: 1, email: 1, folder: 1, jobUrl: 1, createdAt: 1 }
    )
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();

    for (const item of candidates as Array<ResumeDashboardLeanItem>) {
      const candidateCanonical = normalizeComparableUrl(String(item.jobUrl || ""));
      if (candidateCanonical !== targetCanonical) continue;
      const locator = toLocator(item);
      if (locator) return locator;
    }
  }

  return null;
}
