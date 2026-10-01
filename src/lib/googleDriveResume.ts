import { google } from "googleapis";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const DEFAULT_SERVICE_ACCOUNT_FILE = "gen-lang-client.json";
const DEFAULT_RESUME_ROOT_FOLDER_NAME = "Resume";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

type UploadResult = {
  ok: boolean;
  webViewLink: string;
  webContentLink: string;
  fileId: string;
  error?: string;
};

type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
};

function buildDirectDriveDownloadLink(fileId: string): string {
  return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0`;
}

function normalizeEmailFolderName(email: string): string {
  const value = String(email || "").trim().toLowerCase();
  if (!value) return "unknown-email";
  return value.replace(/[^a-z0-9@._-]/g, "_");
}

function buildFileNameFromJobUrl(jobUrl: string): string {
  return `${encodeURIComponent(String(jobUrl || "").trim())}.pdf`;
}

function getDriveConfig() {
  return {
    serviceAccountJson: process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || "",
    serviceAccountFile: process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE || DEFAULT_SERVICE_ACCOUNT_FILE,
    rootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || "",
    rootFolderName: process.env.GOOGLE_DRIVE_ROOT_FOLDER_NAME || DEFAULT_RESUME_ROOT_FOLDER_NAME,
    fallbackRootFolderIds: process.env.GOOGLE_DRIVE_FALLBACK_ROOT_FOLDER_IDS || "",
  };
}

function getDriveReadRootFolderIds(primaryRootId: string): string[] {
  const cfg = getDriveConfig();
  const fallback = cfg.fallbackRootFolderIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ordered = [primaryRootId, ...fallback];
  return Array.from(new Set(ordered));
}

async function loadServiceAccountCredentials(): Promise<ServiceAccountCredentials | null> {
  const cfg = getDriveConfig();

  if (cfg.serviceAccountJson) {
    try {
      const parsed = JSON.parse(cfg.serviceAccountJson) as Partial<ServiceAccountCredentials>;
      if (parsed.client_email && parsed.private_key) {
        return {
          client_email: String(parsed.client_email),
          private_key: String(parsed.private_key).replace(/\\n/g, "\n"),
        };
      }
    } catch {
      return null;
    }
  }

  try {
    const resolved = path.isAbsolute(cfg.serviceAccountFile)
      ? cfg.serviceAccountFile
      : path.resolve(process.cwd(), cfg.serviceAccountFile);
    const raw = await fs.readFile(resolved, "utf8");
    const parsed = JSON.parse(raw) as Partial<ServiceAccountCredentials>;
    if (parsed.client_email && parsed.private_key) {
      return {
        client_email: String(parsed.client_email),
        private_key: String(parsed.private_key).replace(/\\n/g, "\n"),
      };
    }
  } catch {
    return null;
  }

  return null;
}

const folderIdCache = new Map<string, string>();

async function resolveResumeRootFolderId(
  drive: ReturnType<typeof google.drive>
): Promise<string> {
  const cfg = getDriveConfig();
  if (cfg.rootFolderId) return cfg.rootFolderId;

  const cacheKey = `root:${cfg.rootFolderName}`;
  const cached = folderIdCache.get(cacheKey);
  if (cached) return cached;

  const escaped = cfg.rootFolderName.replace(/'/g, "\\'");
  const q = `mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '${escaped}'`;
  const found = await drive.files.list({
    q,
    fields: "files(id, name)",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const id = found.data.files?.[0]?.id;
  if (!id) {
    throw new Error(`resume_root_folder_not_found:${cfg.rootFolderName}`);
  }
  folderIdCache.set(cacheKey, id);
  return id;
}

async function ensureFolder(
  drive: ReturnType<typeof google.drive>,
  folderName: string,
  parentId?: string
): Promise<string> {
  const cacheKey = `folder:${parentId || "root"}:${folderName}`;
  const cached = folderIdCache.get(cacheKey);
  if (cached) return cached;

  const escaped = folderName.replace(/'/g, "\\'");
  const parentsFilter = parentId ? ` and '${parentId}' in parents` : "";
  const q = `mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '${escaped}'${parentsFilter}`;

  const found = await drive.files.list({
    q,
    fields: "files(id, name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const existingId = found.data.files?.[0]?.id;
  if (existingId) {
    folderIdCache.set(cacheKey, existingId);
    return existingId;
  }

  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : undefined,
    },
    fields: "id",
    supportsAllDrives: true,
  });

  const id = created.data.id;
  if (!id) throw new Error("drive_folder_create_failed");
  folderIdCache.set(cacheKey, id);
  return id;
}

async function findFileInFolder(
  drive: ReturnType<typeof google.drive>,
  folderId: string,
  fileName: string
): Promise<string | null> {
  const escaped = fileName.replace(/'/g, "\\'");
  const q = `trashed = false and name = '${escaped}' and '${folderId}' in parents`;
  const found = await drive.files.list({
    q,
    fields: "files(id, name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return found.data.files?.[0]?.id || null;
}

async function makeAnyoneReadable(
  drive: ReturnType<typeof google.drive>,
  fileId: string
): Promise<void> {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: {
        type: "anyone",
        role: "reader",
      },
      supportsAllDrives: true,
    });
  } catch {
    // Ignore if permission already exists or cannot be applied in this Drive.
  }
}

export async function uploadResumeToDrive(params: {
  email: string;
  jobUrl: string;
  resumeUrl: string;
}): Promise<UploadResult> {
  const { email, jobUrl, resumeUrl } = params;

  if (!resumeUrl) {
    return {
      ok: false,
      webViewLink: "",
      webContentLink: "",
      fileId: "",
      error: "missing_resume_url",
    };
  }

  const serviceAccount = await loadServiceAccountCredentials();
  if (!serviceAccount) {
    return {
      ok: false,
      webViewLink: "",
      webContentLink: "",
      fileId: "",
      error: "missing_google_drive_service_account_credentials",
    };
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: serviceAccount.client_email,
        private_key: serviceAccount.private_key,
      },
      scopes: [DRIVE_SCOPE],
    });

    const drive = google.drive({ version: "v3", auth });

    const downloadRes = await fetch(resumeUrl, { method: "GET" });
    if (!downloadRes.ok) {
      return {
        ok: false,
        webViewLink: "",
        webContentLink: "",
        fileId: "",
        error: `resume_download_failed:${downloadRes.status}`,
      };
    }

    const fileBuffer = Buffer.from(await downloadRes.arrayBuffer());
    if (!fileBuffer.length) {
      return {
        ok: false,
        webViewLink: "",
        webContentLink: "",
        fileId: "",
        error: "empty_resume_file",
      };
    }

    const folderName = normalizeEmailFolderName(email);
    const fileName = buildFileNameFromJobUrl(jobUrl);
    const rootFolderId = await resolveResumeRootFolderId(drive);

    const emailFolderId = await ensureFolder(drive, folderName, rootFolderId);
    const existingFileId = await findFileInFolder(drive, emailFolderId, fileName);

    const media = {
      mimeType: "application/pdf",
      body: Readable.from(fileBuffer),
    };

    const saved = existingFileId
      ? await drive.files.update({
          fileId: existingFileId,
          media,
          fields: "id, webViewLink, webContentLink",
          supportsAllDrives: true,
        })
      : await drive.files.create({
          requestBody: {
            name: fileName,
            parents: [emailFolderId],
          },
          media,
          fields: "id, webViewLink, webContentLink",
          supportsAllDrives: true,
        });

    const fileId = saved.data.id || "";
    if (!fileId) {
      return {
        ok: false,
        webViewLink: "",
        webContentLink: "",
        fileId: "",
        error: "drive_file_save_failed",
      };
    }

    await makeAnyoneReadable(drive, fileId);

    const meta = await drive.files.get({
      fileId,
      fields: "id, webViewLink, webContentLink",
      supportsAllDrives: true,
    });

    return {
      ok: true,
      fileId,
      webViewLink: meta.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
      webContentLink: buildDirectDriveDownloadLink(fileId),
    };
  } catch (error) {
    return {
      ok: false,
      webViewLink: "",
      webContentLink: "",
      fileId: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// uploadFilesToDriveFolder
// Uploads an array of in-memory files to:
//   {rootFolderId}/{mode}/{normalizedEmail}/{folderName}/
// Returns the Drive folder ID and per-file results (fileId, webViewLink,
// webContentLink). PDF links are also surfaced as top-level pdfWebViewLink /
// pdfWebContentLink for convenience.
// ─────────────────────────────────────────────────────────────────────────────

type DriveFileEntry = {
  name: string;
  buffer: Buffer;
  mimeType?: string;
};

export type PreparedDriveFileEntry = {
  name: string;
  buffer: Buffer;
  mimeType?: string;
  pregeneratedId?: string;
};

type DriveFileResult = {
  fileId: string;
  webViewLink: string;
  webContentLink: string;
};

export type DriveUploadFolderResult = {
  ok: boolean;
  jobFolderId: string;
  files: Record<string, DriveFileResult>;
  error?: string;
};

export type DriveJobFolderPrepResult = {
  ok: boolean;
  drive?: ReturnType<typeof google.drive>;
  jobFolderId: string;
  existingFiles: Map<string, string>;
  pregeneratedPdfId?: string;
  error?: string;
};

export async function prepareDriveJobFolder(params: {
  mode: string;
  email: string;
  folderName: string;
}): Promise<DriveJobFolderPrepResult> {
  const drive = await buildDriveClient();
  if (!drive) {
    return {
      ok: false,
      jobFolderId: "",
      existingFiles: new Map(),
      error: "missing_google_drive_service_account_credentials",
    };
  }

  try {
    const rootFolderId = await resolveResumeRootFolderId(drive);
    const modeFolderId = await ensureFolder(drive, params.mode, rootFolderId);
    const emailFolderId = await ensureFolder(drive, normalizeEmailFolderName(params.email), modeFolderId);
    const jobFolderId = await ensureFolder(drive, params.folderName, emailFolderId);

    // List all existing files in jobFolderId in one call
    const filesList = await listDriveFiles(jobFolderId, drive);
    const existingFiles = new Map<string, string>();
    for (const f of filesList) {
      if (f.name && f.id) existingFiles.set(f.name, f.id);
    }

    let pregeneratedPdfId: string | undefined;
    for (const [name, id] of existingFiles.entries()) {
      if (name.endsWith(".pdf")) {
        pregeneratedPdfId = id;
        break;
      }
    }

    if (!pregeneratedPdfId) {
      try {
        const idsRes = await drive.files.generateIds({ count: 1 });
        pregeneratedPdfId = idsRes.data.ids?.[0];
      } catch (err) {
        console.warn("[Drive] generateIds warning, will fallback to post-create ID", err);
      }
    }

    return {
      ok: true,
      drive,
      jobFolderId,
      existingFiles,
      pregeneratedPdfId,
    };
  } catch (error) {
    return {
      ok: false,
      jobFolderId: "",
      existingFiles: new Map(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function uploadPreparedDriveFiles(params: {
  drive: ReturnType<typeof google.drive>;
  jobFolderId: string;
  files: PreparedDriveFileEntry[];
  existingFiles?: Map<string, string>;
}): Promise<DriveUploadFolderResult> {
  const { drive, jobFolderId, files, existingFiles } = params;
  const fileResults: Record<string, DriveFileResult> = {};

  try {
    await Promise.all(
      files.map(async (entry) => {
        const mimeType =
          entry.mimeType ??
          (entry.name.endsWith(".pdf") ? "application/pdf" : "text/plain");

        const existingId = existingFiles?.get(entry.name);
        const media = { mimeType, body: Readable.from(entry.buffer) };

        let fileId = "";
        let webViewLink = "";

        if (existingId) {
          const res = await drive.files.update({
            fileId: existingId,
            media,
            fields: "id, webViewLink",
            supportsAllDrives: true,
          });
          fileId = res.data.id || existingId;
          webViewLink = res.data.webViewLink || "";
        } else {
          const requestBody: {
            name: string;
            parents: string[];
            id?: string;
          } = {
            name: entry.name,
            parents: [jobFolderId],
          };
          if (entry.pregeneratedId) {
            requestBody.id = entry.pregeneratedId;
          }

          const res = await drive.files.create({
            requestBody,
            media,
            fields: "id, webViewLink",
            supportsAllDrives: true,
          });
          fileId = res.data.id || entry.pregeneratedId || "";
          webViewLink = res.data.webViewLink || "";
        }

        if (fileId) {
          // Only PDF files need public read permissions for downloads/previews
          if (entry.name.endsWith(".pdf")) {
            await makeAnyoneReadable(drive, fileId);
          }
          fileResults[entry.name] = {
            fileId,
            webViewLink:
              webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
            webContentLink: buildDirectDriveDownloadLink(fileId),
          };
        }
      })
    );

    return { ok: true, jobFolderId, files: fileResults };
  } catch (error) {
    return {
      ok: false,
      jobFolderId,
      files: fileResults,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function uploadFilesToDriveFolder(params: {
  mode: string;
  email: string;
  folderName: string;
  files: DriveFileEntry[];
}): Promise<DriveUploadFolderResult> {
  const prep = await prepareDriveJobFolder({
    mode: params.mode,
    email: params.email,
    folderName: params.folderName,
  });
  if (!prep.ok || !prep.drive) {
    return {
      ok: false,
      jobFolderId: "",
      files: {},
      error: prep.error || "Drive folder prep failed",
    };
  }

  const preparedEntries: PreparedDriveFileEntry[] = params.files.map((f) => ({
    name: f.name,
    buffer: f.buffer,
    mimeType: f.mimeType,
    pregeneratedId: f.name.endsWith(".pdf") ? prep.pregeneratedPdfId : undefined,
  }));

  return uploadPreparedDriveFiles({
    drive: prep.drive,
    jobFolderId: prep.jobFolderId,
    files: preparedEntries,
    existingFiles: prep.existingFiles,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Drive read helpers — used by API routes to serve content from Drive only
// ─────────────────────────────────────────────────────────────────────────────

let cachedDriveClient: ReturnType<typeof google.drive> | null = null;

/** Build an authenticated Drive v3 client, or null if credentials are missing. */
export async function buildDriveClient(): Promise<ReturnType<typeof google.drive> | null> {
  if (cachedDriveClient) return cachedDriveClient;
  const serviceAccount = await loadServiceAccountCredentials();
  if (!serviceAccount) return null;
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: serviceAccount.client_email,
      private_key: serviceAccount.private_key,
    },
    scopes: [DRIVE_SCOPE],
  });
  cachedDriveClient = google.drive({ version: "v3", auth });
  return cachedDriveClient;
}

/** Find a direct child folder by name inside parentId. Returns folder ID or null. */
async function findFolderInParent(
  drive: ReturnType<typeof google.drive>,
  parentId: string,
  name: string
): Promise<string | null> {
  const escaped = name.replace(/'/g, "\\'");
  const q = `mimeType='application/vnd.google-apps.folder' and trashed=false and name='${escaped}' and '${parentId}' in parents`;
  const found = await drive.files.list({
    q,
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return found.data.files?.[0]?.id || null;
}

/**
 * Walk path segments from the Drive root folder, returning the leaf folder ID.
 * Returns null if any segment is not found.
 */
async function resolveDriveFolderPath(
  drive: ReturnType<typeof google.drive>,
  segments: string[],
  rootFolderId?: string
): Promise<string | null> {
  let currentId = rootFolderId || (await resolveResumeRootFolderId(drive));
  for (const segment of segments) {
    const next = await findFolderInParent(drive, currentId, segment);
    if (!next) return null;
    currentId = next;
  }
  return currentId;
}

/**
 * Download a single file's bytes from Drive at:
 *   {root}/{mode}/{normalizedEmail}/{folderName}/{fileName}
 * Returns null if the file is not found or credentials are missing.
 */
export async function downloadFileFromDriveFolder(params: {
  mode: string;
  email: string;
  folderName: string;
  fileName: string;
}): Promise<Buffer | null> {
  const drive = await buildDriveClient();
  if (!drive) return null;
  try {
    const normalizedEmail = normalizeEmailFolderName(params.email);
    const primaryRootId = await resolveResumeRootFolderId(drive);
    const rootCandidates = getDriveReadRootFolderIds(primaryRootId);
    for (const rootFolderId of rootCandidates) {
      const jobFolderId = await resolveDriveFolderPath(
        drive,
        [params.mode, normalizedEmail, params.folderName],
        rootFolderId
      );
      if (!jobFolderId) continue;
      const fileId = await findFileInFolder(drive, jobFolderId, params.fileName);
      if (!fileId) continue;
      const res = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" }
      );
      return Buffer.from(res.data as ArrayBuffer);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find the first PDF file inside:
 *   {root}/{mode}/{normalizedEmail}/{folderName}/
 * Returns metadata (name, fileId, webViewLink, webContentLink) or null.
 */
export async function findPdfInDriveJobFolder(params: {
  mode: string;
  email: string;
  folderName: string;
}): Promise<{ name: string; fileId: string; webViewLink: string; webContentLink: string } | null> {
  const drive = await buildDriveClient();
  if (!drive) return null;
  try {
    const normalizedEmail = normalizeEmailFolderName(params.email);
    const primaryRootId = await resolveResumeRootFolderId(drive);
    const rootCandidates = getDriveReadRootFolderIds(primaryRootId);
    for (const rootFolderId of rootCandidates) {
      const jobFolderId = await resolveDriveFolderPath(
        drive,
        [params.mode, normalizedEmail, params.folderName],
        rootFolderId
      );
      if (!jobFolderId) continue;
      const q = `trashed=false and '${jobFolderId}' in parents and mimeType='application/pdf'`;
      const found = await drive.files.list({
        q,
        fields: "files(id, name, webViewLink, webContentLink)",
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const file = found.data.files?.[0];
      if (!file?.id) continue;
      const fileId = file.id;
      return {
        name: file.name || "",
        fileId,
        webViewLink: file.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
        webContentLink: buildDirectDriveDownloadLink(fileId),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** List all direct subfolders of a Drive folder. */
export async function listDriveChildFolders(
  parentFolderId: string,
  drive?: ReturnType<typeof google.drive> | null
): Promise<Array<{ id: string; name: string }>> {
  const d = drive ?? (await buildDriveClient());
  if (!d) return [];
  const q = `mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentFolderId}' in parents`;
  const results: Array<{ id: string; name: string }> = [];
  let pageToken: string | undefined;
  do {
    const res = await d.files.list({
      q,
      fields: "nextPageToken, files(id, name)",
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) results.push({ id: f.id, name: f.name });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return results;
}

/** List all non-folder files in a Drive folder. */
export async function listDriveFiles(
  folderId: string,
  drive?: ReturnType<typeof google.drive> | null
): Promise<Array<{ id: string; name: string; mimeType: string }>> {
  const d = drive ?? (await buildDriveClient());
  if (!d) return [];
  const q = `trashed=false and '${folderId}' in parents and mimeType!='application/vnd.google-apps.folder'`;
  const res = await d.files.list({
    q,
    fields: "files(id, name, mimeType)",
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files ?? []).map((f) => ({
    id: f.id || "",
    name: f.name || "",
    mimeType: f.mimeType || "",
  }));
}

/**
 * Download a file by Drive file ID and return its bytes.
 * Returns null on any error.
 */
export async function downloadDriveFileById(
  fileId: string,
  drive?: ReturnType<typeof google.drive> | null
): Promise<Buffer | null> {
  const d = drive ?? (await buildDriveClient());
  if (!d) return null;
  try {
    const res = await d.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );
    return Buffer.from(res.data as ArrayBuffer);
  } catch {
    return null;
  }
}

/** Return the Drive root resume folder ID (from env or by name lookup). */
export async function getResumeRootFolderId(): Promise<string | null> {
  const drive = await buildDriveClient();
  if (!drive) return null;
  try {
    return await resolveResumeRootFolderId(drive);
  } catch {
    return null;
  }
}

/**
 * Trash the Drive job folder at:
 *   {root}/{mode}/{normalizedEmail}/{folderName}
 * Returns true if the folder was successfully trashed, false otherwise.
 */
export async function deleteDriveJobFolder(params: {
  mode: string;
  email: string;
  folderName: string;
}): Promise<boolean> {
  const drive = await buildDriveClient();
  if (!drive) return false;
  try {
    const normalizedEmail = normalizeEmailFolderName(params.email);
    const folderId = await resolveDriveFolderPath(drive, [
      params.mode,
      normalizedEmail,
      params.folderName,
    ]);
    if (!folderId) return false;
    await drive.files.update({
      fileId: folderId,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
    return true;
  } catch {
    return false;
  }
}
