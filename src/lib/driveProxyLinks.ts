function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

export function isSafeDriveFileId(fileId: string): boolean {
  return /^[A-Za-z0-9_-]{10,}$/.test(String(fileId || ""));
}

export function extractDriveFileIdFromUrl(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) return "";

  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();

    // Local proxy URLs
    if (u.pathname === "/api/drive-proxy") {
      const id = u.searchParams.get("id") || "";
      return isSafeDriveFileId(id) ? id : "";
    }

    // drive.google.com/uc?id=...
    if (host === "drive.google.com") {
      const idFromQuery = u.searchParams.get("id") || "";
      if (isSafeDriveFileId(idFromQuery)) return idFromQuery;

      // drive.google.com/file/d/<id>/view
      const match = u.pathname.match(/\/file\/d\/([^/]+)/);
      if (match?.[1] && isSafeDriveFileId(match[1])) return match[1];
    }

    // drive.usercontent.google.com/download?id=...
    if (host === "drive.usercontent.google.com" && u.pathname === "/download") {
      const id = u.searchParams.get("id") || "";
      return isSafeDriveFileId(id) ? id : "";
    }
  } catch {
    return "";
  }

  return "";
}

export function buildDriveProxyUrl(baseUrl: string, fileId: string, download: boolean): string {
  const base = normalizeBaseUrl(baseUrl);
  const id = String(fileId || "").trim();
  return `${base}/api/drive-proxy?id=${encodeURIComponent(id)}&download=${download ? "1" : "0"}`;
}

export function patchResumeLinksToDriveProxy(value: unknown, baseUrl: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => patchResumeLinksToDriveProxy(item, baseUrl));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const obj = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(obj)) {
    if (
      (key === "resume_download" || key === "resume" || key === "resume_preview") &&
      typeof val === "string"
    ) {
      const fileId = extractDriveFileIdFromUrl(val);
      if (fileId) {
        const download = key === "resume_preview" ? false : true;
        next[key] = buildDriveProxyUrl(baseUrl, fileId, download);
      } else {
        next[key] = val;
      }
    } else {
      next[key] = patchResumeLinksToDriveProxy(val, baseUrl);
    }
  }

  return next;
}
