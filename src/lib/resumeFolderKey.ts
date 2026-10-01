import { createHash } from "node:crypto";
import { normalizeJobUrlForStorage } from "@/lib/jobUrlNormalization";

const DEFAULT_KEY_LENGTH = 18;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 32;

function clampLength(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_KEY_LENGTH;
  return Math.max(MIN_KEY_LENGTH, Math.min(MAX_KEY_LENGTH, Math.floor(value)));
}

function resolveKeyLength(): number {
  const raw = Number(process.env.RESUME_FOLDER_KEY_LENGTH || DEFAULT_KEY_LENGTH);
  return clampLength(raw);
}

function toNumericHash(input: string): string {
  const bytes = createHash("sha256").update(input).digest();
  return Array.from(bytes, (byte) => String(byte % 10)).join("");
}

export function getLegacyResumeFolderNameFromUrl(jobUrl: string): string {
  return encodeURIComponent(String(jobUrl || "").trim());
}

function hashUrl(url: string): string {
  const keyLength = resolveKeyLength();
  return `u${toNumericHash(url).slice(0, keyLength)}`;
}

/**
 * Canonical folder name for a job URL.
 * Normalises through normalizeJobUrlForStorage first so that all URL
 * variants for the same job (embed vs direct, with/without utm params)
 * always produce the same folder key.
 */
export function getResumeFolderNameFromUrl(jobUrl: string): string {
  const canonical = normalizeJobUrlForStorage(String(jobUrl || "").trim());
  return hashUrl(canonical);
}

/**
 * Returns all folder name candidates to try in order.
 * Tries the canonical normalised form first, then fallbacks for resumes
 * that were saved before this normalisation was in place.
 */
export function getResumeFolderCandidatesFromUrl(jobUrl: string): string[] {
  const raw = String(jobUrl || "").trim();

  // 1. Canonical: normalised through normalizeJobUrlForStorage (current behaviour)
  const canonical = normalizeJobUrlForStorage(raw);
  const canonicalKey = hashUrl(canonical);

  // 2. Raw URL as-is (old resumes saved before normalisation)
  const rawKey = hashUrl(raw);

  // 3. Raw with utm stripped only (intermediate state from previous fix)
  const utmStripped = (() => {
    try {
      const url = new URL(raw);
      [...url.searchParams.keys()]
        .filter((k) => k.toLowerCase().startsWith("utm_"))
        .forEach((k) => url.searchParams.delete(k));
      return url.toString();
    } catch {
      return raw;
    }
  })();
  const utmStrippedKey = hashUrl(utmStripped);

  // 4. Legacy: encodeURIComponent (original folder naming scheme)
  const legacy = getLegacyResumeFolderNameFromUrl(raw);

  return [...new Set([canonicalKey, rawKey, utmStrippedKey, legacy])];
}
