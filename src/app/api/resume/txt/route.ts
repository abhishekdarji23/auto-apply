import { NextRequest, NextResponse } from "next/server";
import { resolveModeAndCurrentEmail } from "@/lib/resumeReadResolver";
import { getLegacyResumeFolderNameFromUrl, getResumeFolderCandidatesFromUrl } from "@/lib/resumeFolderKey";
import { downloadFileFromDriveFolder } from "@/lib/googleDriveResume";
import { getDataDirName } from "@/lib/userConfig";

export const runtime = "nodejs";

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
  const searchParams = request.nextUrl.searchParams;
  const jobUrlRaw = (searchParams.get("jobUrl") || "").trim();
  const folderName = resolveFolderName(searchParams);

  if (!isSafeFolderName(folderName)) {
    return NextResponse.json(
      {
        error: "Missing/invalid identifier. Provide jobUrl or folder query parameter.",
      },
      { status: 400 }
    );
  }

  const rawUrl = jobUrlRaw || decodeURIComponent(folderName);
  const { mode, currentEmail } = await resolveModeAndCurrentEmail(rawUrl);
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

  for (const candidate of folderCandidates) {
    const fileBuffer = await downloadFileFromDriveFolder({
      mode,
      email: currentEmail,
      folderName: candidate,
      fileName: "resume.txt",
    });

    if (fileBuffer) {
      return new NextResponse(fileBuffer.toString("utf8"), {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
  }

  return NextResponse.json(
    {
      error: "resume_text_not_found",
      mode,
      folderName,
      currentEmail,
      tried: folderCandidates,
    },
    { status: 404 }
  );
}
