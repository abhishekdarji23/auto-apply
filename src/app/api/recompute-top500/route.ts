import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Job from "@/models/Job";
import { companyMatchKeys, loadTop500TokensWithRank } from "@/lib/top500";

type RecomputeTop500Result = {
  success: true;
  companies: number;
  matchedDocs: number;
  modifiedDocs: number;
};

let inFlightRecompute: Promise<RecomputeTop500Result> | null = null;

async function runRecomputeTop500(): Promise<RecomputeTop500Result> {
  await dbConnect();
  const top500Tokens = loadTop500TokensWithRank();

  const dbCompanies = await Job.distinct("company");
  const normalizedCompanies = dbCompanies
    .map((company) => String(company || "").trim())
    .filter(Boolean);

  const bulkOps = normalizedCompanies.map((company) => {
    const matchKeys = companyMatchKeys(company);
    let bestRank = 999999;
    for (const k of matchKeys) {
      if (top500Tokens.has(k)) {
        bestRank = Math.min(bestRank, top500Tokens.get(k)!);
      }
    }
    const top500 = bestRank !== 999999;
    return {
      updateMany: {
        filter: { company },
        update: { $set: { top500, companyRank: bestRank } },
      },
    };
  });

  let matchedDocs = 0;
  let modifiedDocs = 0;
  for (let i = 0; i < bulkOps.length; i += 500) {
    const chunk = bulkOps.slice(i, i + 500);
    if (chunk.length === 0) continue;
    const result = await Job.bulkWrite(chunk, { ordered: false });
    matchedDocs += result.matchedCount || 0;
    modifiedDocs += result.modifiedCount || 0;
  }

  return {
    success: true,
    companies: normalizedCompanies.length,
    matchedDocs,
    modifiedDocs,
  };
}

export async function POST() {
  try {
    if (!inFlightRecompute) {
      inFlightRecompute = runRecomputeTop500().finally(() => {
        inFlightRecompute = null;
      });
    }

    const result = await inFlightRecompute;
    return NextResponse.json(result);
  } catch (error) {
    console.error("Recompute top500 error:", error);
    return NextResponse.json(
      { error: "Internal server error", details: String(error) },
      { status: 500 }
    );
  }
}
