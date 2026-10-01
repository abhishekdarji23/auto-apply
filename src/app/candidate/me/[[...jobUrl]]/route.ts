import { NextRequest, NextResponse } from "next/server";
import { resolveModeAndCurrentEmail } from "@/lib/resumeReadResolver";
import { getResumeFolderCandidatesFromUrl } from "@/lib/resumeFolderKey";
import { downloadFileFromDriveFolder } from "@/lib/googleDriveResume";
import { patchResumeLinksToDriveProxy } from "@/lib/driveProxyLinks";
import { findResumeDashboardLocatorByJobUrl } from "@/lib/resumeDashboardLookup";
import { getDataDirName } from "@/lib/userConfig";
import { DEFAULT_RESUME_FOLDER_NAME } from "@/lib/defaultResume";

const PROFILE_FILE_NAME = "profile.json";
const ROUTE_PREFIX = "/candidate/me";

export const runtime = "nodejs";

function pushUnique(target: string[], value: string) {
  const normalized = value.trim();
  if (!normalized) return;
  if (!target.includes(normalized)) {
    target.push(normalized);
  }
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isSafeFolderName(folderName: string): boolean {
  return (
    !!folderName &&
    !folderName.includes("/") &&
    !folderName.includes("\\") &&
    !folderName.includes("..")
  );
}

function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}


function deriveRawPathTail(request: NextRequest): string {
  const pathname = new URL(request.url).pathname;
  if (pathname === ROUTE_PREFIX) return "";
  if (pathname.startsWith(`${ROUTE_PREFIX}/`)) {
    return pathname.slice(ROUTE_PREFIX.length + 1);
  }
  return "";
}

function buildFolderCandidates(
  request: NextRequest,
  pathParts?: string[],
  queryJobUrl?: string
): string[] {
  const seedValues: string[] = [];
  const rawTail = deriveRawPathTail(request);
  const queryValue = (queryJobUrl || "").trim();
  const joinedPathParts = Array.isArray(pathParts) ? pathParts.join("/") : "";

  pushUnique(seedValues, queryValue);
  pushUnique(seedValues, joinedPathParts);
  pushUnique(seedValues, rawTail);

  if (Array.isArray(pathParts) && pathParts.length === 1) {
    pushUnique(seedValues, pathParts[0]);
  }

  const expandedValues: string[] = [];
  for (const seed of seedValues) {
    pushUnique(expandedValues, seed);
    pushUnique(expandedValues, encodeURIComponent(seed));

    const decoded = safeDecodeURIComponent(seed);
    if (decoded) {
      pushUnique(expandedValues, decoded);
      pushUnique(expandedValues, encodeURIComponent(decoded));
    }
  }

  const folderNames: string[] = [];
  for (const value of expandedValues) {
    if (looksLikeHttpUrl(value)) {
      for (const candidate of getResumeFolderCandidatesFromUrl(value)) {
        pushUnique(folderNames, candidate);
      }
    } else {
      pushUnique(folderNames, value);
    }
  }

  return folderNames.filter(isSafeFolderName);
}

async function findProfileFromDrive(
  folderCandidates: string[],
  mode: string,
  currentEmail: string
): Promise<{ folderName: string; profileBytes: Buffer } | null> {
  for (const folderName of folderCandidates) {
    const buf = await downloadFileFromDriveFolder({
      mode,
      email: currentEmail,
      folderName,
      fileName: PROFILE_FILE_NAME,
    });
    if (buf) return { folderName, profileBytes: buf };
  }
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobUrl?: string[] }> }
) {
  try {
    const resolvedParams = await params;
    const pathParts = resolvedParams.jobUrl;
    const queryJobUrl = request.nextUrl.searchParams.get("jobUrl") || "";
    const folderCandidates = buildFolderCandidates(request, pathParts, queryJobUrl);

    if (folderCandidates.length === 0) {
      return NextResponse.json(
        {
          error:
            "Missing job identifier. Pass encoded URL in /candidate/me/<encoded-job-url> or use ?jobUrl=<url>.",
        },
        { status: 400 }
      );
    }

    // Determine mode from ATS toggle and email from current-emails.json.
    const rawTail = deriveRawPathTail(request);
    const decodedRawTail = safeDecodeURIComponent(rawTail);
    const decodedPathParts = Array.isArray(pathParts)
      ? safeDecodeURIComponent(pathParts.join("/"))
      : null;
    const rawUrl = queryJobUrl || decodedRawTail || decodedPathParts || "";

    const { mode, currentEmail } = await resolveModeAndCurrentEmail(rawUrl);
    if (!currentEmail) {
      return NextResponse.json(
        {
          error: `current-emails.json is missing ${mode}Email. Set ${getDataDirName()}/current-emails.json before reading candidate profile.`,
          mode,
        },
        { status: 500 }
      );
    }

    let match = await findProfileFromDrive(folderCandidates, mode, currentEmail);
    if (!match) {
      const locator = await findResumeDashboardLocatorByJobUrl({
        jobUrl: rawUrl,
        preferredMode: mode,
        preferredEmail: currentEmail,
      });

      if (locator) {
        pushUnique(folderCandidates, locator.folder);
        match = await findProfileFromDrive([locator.folder], locator.mode, locator.email);
      }
    }

    if (!match && mode === "autoApply") {
      pushUnique(folderCandidates, DEFAULT_RESUME_FOLDER_NAME);
      match = await findProfileFromDrive([DEFAULT_RESUME_FOLDER_NAME], mode, currentEmail);
    }

    if (!match) {
      return NextResponse.json(
        {
          error: "profile.json not found for provided job URL",
          triedFolderNames: folderCandidates,
          mode,
          currentEmail,
        },
        { status: 404 }
      );
    }

    const rawProfile = match.profileBytes.toString("utf8");
    const profileJson = patchResumeLinksToDriveProxy(
      JSON.parse(rawProfile) as Record<string, unknown>
    , request.nextUrl.origin) as Record<string, unknown>;

    // For Greenhouse requests: strip the second (BTech) education entry, keep only the first (Masters).
    const isGreenhouse = /greenhouse\.io/i.test(rawUrl);
    if (isGreenhouse && Array.isArray(profileJson.education) && profileJson.education.length > 1) {
      profileJson.education = (profileJson.education as unknown[]).slice(0, 1);
    }

    return NextResponse.json(profileJson, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Internal server error", details: String(error) },
      { status: 500 }
    );
  }
}
