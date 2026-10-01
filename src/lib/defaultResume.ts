export const DEFAULT_RESUME_FOLDER_NAME = "defaultResume";
export const DEFAULT_RESUME_JOB_URL = "https://auto-apply.local/default-resume";

export function isTruthy(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}
