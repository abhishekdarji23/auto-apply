import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import AtsAutomation from "@/models/AtsAutomation";

export const runtime = "nodejs";

// PATCH /api/automations/[atsId] — toggle enabled on/off
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ atsId: string }> }
) {
  try {
    const { atsId } = await params;
    const body = (await request.json()) as { enabled?: boolean };

    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled (boolean) is required" },
        { status: 400 }
      );
    }

    await dbConnect();
    const doc = await AtsAutomation.findOneAndUpdate(
      { atsId },
      { $set: { enabled: body.enabled } },
      { new: true }
    );

    if (!doc) {
      return NextResponse.json({ error: "ATS not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, enabled: doc.enabled });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
