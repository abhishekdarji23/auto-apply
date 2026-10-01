import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadDriveFileById } from "@/lib/googleDriveResume";
import { isSafeDriveFileId } from "@/lib/driveProxyLinks";

export const runtime = "nodejs";

const CACHE_DIR = path.join(os.tmpdir(), "jobtrack-drive-cache");

function isTruthy(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

async function readCachedFile(filePath: string): Promise<Buffer | null> {
  try {
    const bytes = await fs.readFile(filePath);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

async function writeCacheFile(filePath: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, bytes);
  await fs.rename(tmpPath, filePath).catch(async () => {
    await fs.unlink(tmpPath).catch(() => undefined);
  });
}

export async function GET(request: NextRequest) {
  const fileId = String(request.nextUrl.searchParams.get("id") || "").trim();
  if (!isSafeDriveFileId(fileId)) {
    return NextResponse.json({ error: "invalid_drive_file_id" }, { status: 400 });
  }

  const shouldDownload = isTruthy(request.nextUrl.searchParams.get("download"));
  const cachePath = path.join(CACHE_DIR, `${fileId}.pdf`);

  let bytes = await readCachedFile(cachePath);
  if (!bytes) {
    const downloaded = await downloadDriveFileById(fileId);
    if (!downloaded || downloaded.length === 0) {
      return NextResponse.json({ error: "drive_file_not_found" }, { status: 404 });
    }
    bytes = downloaded;
    await writeCacheFile(cachePath, downloaded).catch(() => undefined);
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Cache-Control": "no-store",
      "Content-Disposition": `${shouldDownload ? "attachment" : "inline"}; filename="resume_${fileId}.pdf"`,
    },
  });
}
