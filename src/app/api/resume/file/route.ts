import { NextRequest, NextResponse } from "next/server";
import { readCurrentAutoApplyEmail, resolveModeAndCurrentEmail } from "@/lib/resumeReadResolver";
import {
  getLegacyResumeFolderNameFromUrl,
  getResumeFolderCandidatesFromUrl,
} from "@/lib/resumeFolderKey";
import { findPdfInDriveJobFolder, downloadDriveFileById } from "@/lib/googleDriveResume";
import { getDataDirName } from "@/lib/userConfig";
import { DEFAULT_RESUME_FOLDER_NAME } from "@/lib/defaultResume";

export const runtime = "nodejs";

function isTruthy(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isSafeFolderName(folderName: string): boolean {
  return (
    !!folderName &&
    !folderName.includes("/") &&
    !folderName.includes("\\") &&
    !folderName.includes("..")
  );
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function resolveFolderName(searchParams: URLSearchParams): string {
  const jobUrlRaw = (searchParams.get("jobUrl") || "").trim();
  if (jobUrlRaw) {
    return getResumeFolderCandidatesFromUrl(jobUrlRaw)[0];
  }

  const folderRaw = (searchParams.get("folder") || "").trim();
  if (folderRaw) {
    return folderRaw;
  }

  return "";
}

export async function GET(request: NextRequest) {
  const jobUrlRaw = (request.nextUrl.searchParams.get("jobUrl") || "").trim();
  const folderName = resolveFolderName(request.nextUrl.searchParams);
  if (!isSafeFolderName(folderName)) {
    return NextResponse.json(
      {
        error:
          "Missing/invalid identifier. Provide jobUrl or folder query parameter.",
      },
      { status: 400 }
    );
  }

  const rawUrl = jobUrlRaw || decodeURIComponent(folderName);
  let { mode, currentEmail } = await resolveModeAndCurrentEmail(rawUrl);
  if (folderName === DEFAULT_RESUME_FOLDER_NAME) {
    mode = "autoApply";
    currentEmail = await readCurrentAutoApplyEmail();
  }
  if (!currentEmail) {
    return NextResponse.json(
      {
        error: `current-emails.json is missing ${mode}Email. Set ${getDataDirName()}/current-emails.json before reading resumes.`,
        mode,
      },
      { status: 500 }
    );
  }

  const folderCandidates = jobUrlRaw
    ? getResumeFolderCandidatesFromUrl(jobUrlRaw)
    : (() => {
        const decoded = safeDecodeURIComponent(folderName);
        if (!decoded) return [folderName];
        const fromDecoded = getLegacyResumeFolderNameFromUrl(decoded);
        return fromDecoded === folderName ? [folderName] : [folderName, fromDecoded];
      })();
  if (mode === "autoApply") {
    folderCandidates.push(DEFAULT_RESUME_FOLDER_NAME);
  }

  const shouldDownload = isTruthy(request.nextUrl.searchParams.get("download"));

  // Try each folder candidate on Drive
  for (const candidate of folderCandidates) {
    const pdf = await findPdfInDriveJobFolder({ mode, email: currentEmail, folderName: candidate });
    if (!pdf) continue;

    const pdfBytes = await downloadDriveFileById(pdf.fileId);
    if (!pdfBytes) continue;

    return new NextResponse(new Uint8Array(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Cache-Control": "no-store",
        "Content-Disposition": `${
          shouldDownload ? "attachment" : "inline"
        }; filename="${pdf.name}"`,
      },
    });
  }

  return NextResponse.json(
    {
      error: "Resume PDF not found on Drive",
      folderName: folderCandidates[0] || folderName,
      mode,
      email: currentEmail,
    },
    { status: 404 }
  );
}
