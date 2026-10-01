/**
 * Dedup is handled before insert/update now.
 *
 * Keep this function as a harmless compatibility shim for existing API routes
 * that still report a dedupMarked count, but do not mark jobs inactive.
 */
export async function deduplicateByApplyUrl(): Promise<number> {
  return 0;
}
