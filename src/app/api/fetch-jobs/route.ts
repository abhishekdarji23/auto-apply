import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import { normalizeStoredJobUrls } from "@/lib/normalizeStoredJobUrls";
import { deduplicateByApplyUrl } from "@/lib/deduplicateByApplyUrl";

let inFlightFetch: Promise<{
  success: true;
  newJobs: number;
  reactivated: number;
  markedInactive: number;
  fetched: number;
  dedupMarked: number;
  normalizedUrls: number;
}> | null = null;

async function runFetchJobs() {
  await dbConnect();

  const normalizedUrls = await normalizeStoredJobUrls();
  const dedupMarked = await deduplicateByApplyUrl();

  console.log(
    `[fetch-jobs] done newJobs=0 reactivated=0 markedInactive=0 ` +
      `normalizedUrls=${normalizedUrls} dedupMarked=${dedupMarked}`
  );

  return {
    success: true as const,
    newJobs: 0,
    reactivated: 0,
    markedInactive: 0,
    fetched: 0,
    dedupMarked,
    normalizedUrls,
  };
}

export async function POST() {
  try {
    if (!inFlightFetch) {
      inFlightFetch = runFetchJobs().finally(() => {
        inFlightFetch = null;
      });
    }

    const result = await inFlightFetch;
    return NextResponse.json(result);
  } catch (error) {
    console.error("Fetch jobs error:", error);
    return NextResponse.json(
      { error: "Internal server error", details: String(error) },
      { status: 500 }
    );
  }
}
