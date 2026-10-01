import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import { deduplicateByApplyUrl } from "@/lib/deduplicateByApplyUrl";

let inFlight: Promise<{ success: true; deduplicatedMarked: number }> | null = null;

export async function POST() {
  try {
    if (!inFlight) {
      inFlight = (async () => {
        await dbConnect();
        const deduplicatedMarked = await deduplicateByApplyUrl();
        return { success: true as const, deduplicatedMarked };
      })().finally(() => {
        inFlight = null;
      });
    }
    const result = await inFlight;
    return NextResponse.json(result);
  } catch (error) {
    console.error("Dedup error:", error);
    return NextResponse.json(
      { error: "Internal server error", details: String(error) },
      { status: 500 }
    );
  }
}
