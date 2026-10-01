import { promises as fs } from "node:fs";
import dbConnect from "@/lib/mongodb";
import AtsAutomation from "@/models/AtsAutomation";
import { getDataPath } from "@/lib/userConfig";

export type ResumeMode = "autoApply" | "manualApply";

type CurrentEmailsConfig = {
  autoApplyEmail?: string;
  manualApplyEmail?: string;
};

const CURRENT_EMAILS_FILE_NAME = "current-emails.json";

const ATS_HOST_PATTERNS: Array<{ pattern: RegExp; atsId: string }> = [
  { pattern: /myworkdayjobs\.com$/i, atsId: "workday" },
  { pattern: /myworkdaysite\.com$/i, atsId: "workday" },
  { pattern: /boards\.greenhouse\.io$/i, atsId: "greenhouse" },
  { pattern: /job-boards\.greenhouse\.io$/i, atsId: "greenhouse" },
  { pattern: /jobs\.ashbyhq\.com$/i, atsId: "ashby" },
];

export function detectAtsId(rawUrl: string): string | null {
  const candidates = [rawUrl];
  try {
    const decoded = decodeURIComponent(rawUrl);
    if (decoded !== rawUrl) candidates.push(decoded);
  } catch {
    // ignore malformed encodings
  }

  for (const url of candidates) {
    try {
      const { hostname } = new URL(url);
      for (const { pattern, atsId } of ATS_HOST_PATTERNS) {
        if (pattern.test(hostname)) return atsId;
      }
    } catch {
      // ignore non-URL values
    }
  }

  return null;
}

async function isAutoApplyEnabled(atsId: string): Promise<boolean> {
  try {
    await dbConnect();
    const doc = await AtsAutomation.findOne({ atsId }, { enabled: 1 }).lean();
    return Boolean(doc?.enabled);
  } catch {
    return false;
  }
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

async function readCurrentEmails(): Promise<CurrentEmailsConfig | null> {
  const configPath = getDataPath(CURRENT_EMAILS_FILE_NAME);
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as CurrentEmailsConfig;
    return parsed;
  } catch {
    return null;
  }
}

export async function readCurrentAutoApplyEmail(): Promise<string> {
  const emailsConfig = await readCurrentEmails();
  return normalizeEmail(emailsConfig?.autoApplyEmail);
}

export async function resolveModeAndCurrentEmail(rawUrl: string): Promise<{
  mode: ResumeMode;
  currentEmail: string;
}> {
  const atsId = detectAtsId(rawUrl);
  const autoApplyOn = atsId ? await isAutoApplyEnabled(atsId) : false;
  const mode: ResumeMode = autoApplyOn ? "autoApply" : "manualApply";

  const emailsConfig = await readCurrentEmails();
  const currentEmail = mode === "autoApply"
    ? normalizeEmail(emailsConfig?.autoApplyEmail)
    : normalizeEmail(emailsConfig?.manualApplyEmail);

  return { mode, currentEmail };
}
