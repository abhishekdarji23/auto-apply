import { NextRequest, NextResponse } from "next/server";
import "@/lib/userConfig";

const JOBRIGHT_INFO_URL = "https://jobright.ai/jobs/info";
const REQUEST_TIMEOUT_MS = 12_000;

let cachedHeaders: Record<string, string> | null = null;

function buildHeaders() {
  if (cachedHeaders) return cachedHeaders;
  cachedHeaders = {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "max-age=0",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent":
      process.env.JOBRIGHT_USER_AGENT ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    cookie: process.env.JOBRIGHT_COOKIE || "",
  };
  return cachedHeaders;
}

function extractJobDescription(html: string): { title: string; description: string } | null {
  const match = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match?.[1]) return null;

  try {
    const data = JSON.parse(match[1]);
    const job = data?.props?.pageProps?.dataSource?.jobResult;
    if (!job) return null;

    const title = (typeof job.jobTitle === "string" ? job.jobTitle : "").trim();
    if (!title) return null;

    // Build a rich description from the structured fields Jobright provides
    const parts: string[] = [];

    const summary = (typeof job.jobSummary === "string" ? job.jobSummary : "").trim();
    if (summary) parts.push(summary);

    const responsibilities: string[] = Array.isArray(job.coreResponsibilities)
      ? job.coreResponsibilities.filter((s: unknown) => typeof s === "string" && s.trim())
      : [];
    if (responsibilities.length) {
      parts.push("\nResponsibilities:\n" + responsibilities.map((r) => `- ${r.trim()}`).join("\n"));
    }

    const mustHave: string[] = Array.isArray(job.qualifications?.mustHave)
      ? job.qualifications.mustHave.filter((s: unknown) => typeof s === "string" && s.trim())
      : Array.isArray(job.skillSummaries)
      ? job.skillSummaries.filter((s: unknown) => typeof s === "string" && s.trim())
      : [];
    if (mustHave.length) {
      parts.push("\nQualifications:\n" + mustHave.map((q) => `- ${q.trim()}`).join("\n"));
    }

    const preferred: string[] = Array.isArray(job.qualifications?.preferredHave)
      ? job.qualifications.preferredHave.filter((s: unknown) => typeof s === "string" && s.trim())
      : [];
    if (preferred.length) {
      parts.push("\nPreferred:\n" + preferred.map((q) => `- ${q.trim()}`).join("\n"));
    }

    const description = parts.join("\n").trim();
    return { title, description };
  } catch {
    return null;
  }
}

/**
 * GET /api/job-description?jobId=<jobrightJobId>
 *
 * Fetches the Jobright detail page for the given jobId, extracts the job title
 * and description from the embedded __NEXT_DATA__ script tag, and returns:
 *   { title: string, description: string }
 *
 * Used by gptService as a fallback when Greenhouse page scraping fails.
 */
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId")?.trim();
  if (!jobId) {
    return NextResponse.json({ error: "Required query param: jobId" }, { status: 400 });
  }

  try {
    const res = await fetch(`${JOBRIGHT_INFO_URL}/${encodeURIComponent(jobId)}`, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `jobright_fetch_failed:${res.status}` },
        { status: 502 }
      );
    }

    const html = await res.text();
    const result = extractJobDescription(html);

    if (!result) {
      return NextResponse.json(
        { error: "parse_failed — __NEXT_DATA__ missing or job not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
