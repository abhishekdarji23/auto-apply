import { NextRequest, NextResponse } from "next/server";
import { findPdfInDriveJobFolder, downloadDriveFileById } from "@/lib/googleDriveResume";

export const runtime = "nodejs";

const MODES = ["autoApply", "manualApply"] as const;

function isSafeName(name: string): boolean {
  return !!name && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const email = (searchParams.get("email") || "").trim();
  const mode = (searchParams.get("mode") || "").trim();
  const folder = (searchParams.get("folder") || "").trim();

  if (!isSafeName(email) || !isSafeName(folder) || !MODES.includes(mode as (typeof MODES)[number])) {
    return NextResponse.json({ error: "invalid_params" }, { status: 400 });
  }

  const pdf = await findPdfInDriveJobFolder({ mode, email, folderName: folder });
  if (!pdf) {
    return NextResponse.json({ error: "pdf_not_found_on_drive" }, { status: 404 });
  }

  const bytes = await downloadDriveFileById(pdf.fileId);
  if (!bytes) {
    return NextResponse.json({ error: "pdf_download_failed" }, { status: 502 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${pdf.name}"`,
    },
  });
}
