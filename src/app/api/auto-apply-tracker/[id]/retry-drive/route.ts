import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import AutoApplyJob from "@/models/AutoApplyJob";
import { uploadResumeToDrive } from "@/lib/googleDriveResume";
import { resolveModeAndCurrentEmail } from "@/lib/resumeReadResolver";
import { getResumeFolderNameFromUrl, getResumeFolderCandidatesFromUrl } from "@/lib/resumeFolderKey";
import { findPdfInDriveJobFolder, downloadDriveFileById } from "@/lib/googleDriveResume";

async function findPdfBytesFromDrive(jobUrl: string, email: string): Promise<Buffer | null> {
  const candidates = getResumeFolderCandidatesFromUrl(jobUrl);
  const deterministic = getResumeFolderNameFromUrl(jobUrl);
  const orderedCandidates = [deterministic, ...candidates.filter((c) => c !== deterministic)];

  for (const folderName of orderedCandidates) {
    const pdfMeta = await findPdfInDriveJobFolder({ mode: "autoApply", email, folderName });
    if (!pdfMeta?.fileId) continue;
    const bytes = await downloadDriveFileById(pdfMeta.fileId);
    if (bytes && bytes.length > 0) return bytes;
  }

  return null;
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;

    const row = await AutoApplyJob.findById(id).lean();
    if (!row) {
      return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
    }

    const jobUrl = row.jobUrl;
    const { currentEmail } = await resolveModeAndCurrentEmail(jobUrl).catch(() => ({
      mode: "autoApply" as const,
      currentEmail: row.appliedEmail || "",
    }));
    const email = currentEmail || row.appliedEmail || "";

    if (!email) {
      return NextResponse.json({ success: false, error: "no_email_resolved" }, { status: 400 });
    }

    // Re-read the PDF from Drive job folder and re-upload it to Drive with fresh links.
    const pdfBytes = await findPdfBytesFromDrive(jobUrl, email);
    if (!pdfBytes) {
      return NextResponse.json({ success: false, error: "drive_pdf_not_found" }, { status: 404 });
    }
    const base64 = pdfBytes.toString("base64");
    const dataUrl = `data:application/pdf;base64,${base64}`;

    const result = await uploadResumeToDrive({ email, jobUrl, resumeUrl: dataUrl });

    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: 500 });
    }

    // Strip the drive_upload_failed part from lastError, keep any other error
    const cleaned = (row.lastError || "")
      .split(" | ")
      .filter((part) => !part.startsWith("drive_upload_failed"))
      .join(" | ");

    await AutoApplyJob.findByIdAndUpdate(id, {
      $set: {
        resumePreviewLink: result.webViewLink || result.webContentLink,
        lastError: cleaned,
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      webViewLink: result.webViewLink,
      webContentLink: result.webContentLink,
      fileId: result.fileId,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
