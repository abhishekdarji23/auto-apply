const GREENHOUSE_EMBED_BASE_URL = "https://boards.greenhouse.io/embed/job_app";
const ASHBY_HOST = "jobs.ashbyhq.com";

function isNumericToken(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d+$/.test(value.trim());
}

function extractNumericFromHash(hash: string): string | null {
  const match = hash.match(/(\d{6,})/);
  return match?.[1] ?? null;
}

function extractNumericFromPath(pathname: string): string | null {
  const jobsMatch = pathname.match(/\/jobs\/(\d+)(?:\/|$)/i);
  if (jobsMatch?.[1]) return jobsMatch[1];
  return null;
}

function removeJobrightTrackingParam(url: URL): void {
  const values = url.searchParams.getAll("utm_source");
  if (values.some((value) => value.toLowerCase() === "jobright")) {
    url.searchParams.delete("utm_source");
  }
}

export function buildGreenhouseEmbedUrl(token: string): string {
  return `${GREENHOUSE_EMBED_BASE_URL}?token=${encodeURIComponent(token)}`;
}

export function extractGreenhouseToken(rawUrl: string): string | null {
  const input = rawUrl.trim();
  if (!input) return null;

  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();
    const isGreenhouseHost = hostname === "greenhouse.io" || hostname.endsWith(".greenhouse.io");
    const token = url.searchParams.get("token");
    if (isNumericToken(token)) return token;

    const ghJid = url.searchParams.get("gh_jid");
    if (isNumericToken(ghJid)) return ghJid;

    if (isGreenhouseHost) {
      const pathToken = extractNumericFromPath(url.pathname);
      if (pathToken) return pathToken;

      const hashToken = extractNumericFromHash(url.hash);
      if (hashToken) return hashToken;
    }
  } catch {
    // Fall through to regex extraction for malformed URLs.
  }

  const queryTokenMatch = input.match(/[?&]token=(\d+)/i);
  if (queryTokenMatch?.[1]) return queryTokenMatch[1];

  const ghJidMatch = input.match(/[?&]gh_jid=(\d+)/i);
  if (ghJidMatch?.[1]) return ghJidMatch[1];

  if (/greenhouse\.io/i.test(input)) {
    const jobsPathMatch = input.match(/\/jobs\/(\d+)(?:[/?#]|$)/i);
    if (jobsPathMatch?.[1]) return jobsPathMatch[1];

    const hashMatch = input.match(/#\/(\d+)(?:[/?#]|$)/i);
    if (hashMatch?.[1]) return hashMatch[1];
  }

  return null;
}

export function normalizeJobUrlForStorage(rawUrl: string): string {
  const input = rawUrl.trim();
  if (!input) return "";

  let stripped = input;
  try {
    const url = new URL(input);
    removeJobrightTrackingParam(url);
    stripped = url.toString();
  } catch {
    stripped = input.replace(/([?&])utm_source=jobright(&|$)/gi, (_m, leading, trailing) => {
      if (leading === "?" && trailing === "&") return "?";
      if (leading === "&" && trailing === "&") return "&";
      return "";
    }).replace(/[?&]$/, "");
  }

  const token = extractGreenhouseToken(stripped);
  if (token) {
    return buildGreenhouseEmbedUrl(token);
  }

  const ashbyUrl = normalizeAshbyApplicationUrl(stripped);
  if (ashbyUrl) return ashbyUrl;

  return stripped;
}

export function normalizeAshbyApplicationUrl(rawUrl: string): string | null {
  const input = rawUrl.trim();
  if (!input) return null;

  try {
    const url = new URL(input);
    if (url.hostname.toLowerCase() !== ASHBY_HOST) return null;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;

    return `https://${ASHBY_HOST}/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
  } catch {
    return null;
  }
}
