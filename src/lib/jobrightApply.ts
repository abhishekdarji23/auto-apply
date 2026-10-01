import "@/lib/userConfig";

const JOBRIGHT_APPLY_URL = "https://jobright.ai/swan/job/apply";

type JobrightApplyCandidate = {
  jobId?: unknown;
  jobrightId?: unknown;
  jobrightAliases?: unknown;
  sourceKind?: unknown;
  sourceTags?: unknown;
  tabCategory?: unknown;
};

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isJobrightId(value: unknown): boolean {
  return /^[a-f0-9]{24}$/i.test(safeString(value));
}

export function getJobrightApplyId(job: JobrightApplyCandidate): string {
  const aliases = Array.isArray(job.jobrightAliases) ? job.jobrightAliases : [];
  const values = [job.jobrightId, ...aliases, job.jobId].map(safeString);
  const valid = values.find(isJobrightId);

  return valid || "";
}

export function isJobrightSourced(job: JobrightApplyCandidate): boolean {
  if (getJobrightApplyId(job)) return true;
  if (safeString(job.sourceKind).toLowerCase().includes("jobright")) return true;

  const sourceTags = Array.isArray(job.sourceTags) ? job.sourceTags : [];
  if (sourceTags.some((value) => safeString(value).toLowerCase().includes("jobright"))) return true;

  const tabCategory = Array.isArray(job.tabCategory) ? job.tabCategory : [];
  return tabCategory.some((value) => safeString(value).toLowerCase().startsWith("jobright"));
}

function buildJobrightApplyHeaders() {
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.5",
    "content-type": "application/json",
    priority: "u=1, i",
    "sec-ch-ua": '"Chromium";v="152", "Not?A_Brand";v="24", "Brave";v="152"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-gpc": "1",
    "user-agent":
      process.env.JOBRIGHT_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    "x-client-type": "web",
    referer: "https://jobright.ai/jobs/recommend",
  };
  if (process.env.JOBRIGHT_COOKIE) headers.cookie = process.env.JOBRIGHT_COOKIE;
  return headers;
}

export async function markJobrightApplied(job: JobrightApplyCandidate) {
  if (!process.env.JOBRIGHT_COOKIE) return { skipped: true, reason: "missing_cookie" };
  if (!isJobrightSourced(job)) return { skipped: true, reason: "not_jobright" };

  const jobrightId = getJobrightApplyId(job);
  if (!jobrightId) return { skipped: true, reason: "missing_jobright_id" };

  const res = await fetch(JOBRIGHT_APPLY_URL, {
    method: "POST",
    headers: buildJobrightApplyHeaders(),
    body: JSON.stringify({ jobId: jobrightId, source: 0 }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { skipped: false, ok: false, status: res.status, message: text.slice(0, 300) };
  }

  return { skipped: false, ok: true, status: res.status };
}
