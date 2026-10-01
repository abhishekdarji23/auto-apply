import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import AtsAutomation from "@/models/AtsAutomation";

export const runtime = "nodejs";

// Seed list — active ATS automation configs exposed in the dashboard.
const DEFAULT_ATS = [
  { atsId: "workday",    atsName: "Workday" },
  { atsId: "greenhouse", atsName: "Greenhouse" },
];

// GET /api/automations — return all ATS automation configs (seed defaults if missing)
export async function GET() {
  try {
    await dbConnect();

    // Upsert defaults so every known ATS always has a record
    for (const ats of DEFAULT_ATS) {
      await AtsAutomation.updateOne(
        { atsId: ats.atsId },
        { $setOnInsert: { ...ats, enabled: false, email: "", latex: "", folderName: "" } },
        { upsert: true }
      );
    }

    const records = await AtsAutomation.find(
      { atsId: { $in: DEFAULT_ATS.map((a) => a.atsId) } },
      { __v: 0 }
    ).lean();

    return NextResponse.json({ automations: records });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
