import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const EXPLICIT_USER_ENV_KEYS = ["APP_USER", "JOBTRACK_USER", "DATA_USER"];
const OS_USER_ENV_KEYS = ["USER", "USERNAME"];
const USER_FILE_PROTECTED_KEYS = new Set(EXPLICIT_USER_ENV_KEYS);
const ORIGINAL_ENV_KEYS = new Set(Object.keys(process.env));
const LOADED_ENV_FILES = new Set<string>();

function normalizeUser(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function getFirstEnv(keys: string[]): string {
  for (const key of keys) {
    const value = normalizeUser(process.env[key]);
    if (value) return value;
  }
  return "";
}

export function loadEnvFile(
  envPath: string,
  { override = false, protectedKeys = ORIGINAL_ENV_KEYS }: { override?: boolean; protectedKeys?: Set<string> } = {}
): Set<string> {
  const resolved = path.resolve(envPath);
  if (LOADED_ENV_FILES.has(resolved) || !fs.existsSync(resolved)) return new Set();

  const parsed = parseEnv(fs.readFileSync(resolved, "utf8"));
  const loadedKeys = new Set<string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (protectedKeys.has(key)) continue;
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
      loadedKeys.add(key);
    }
  }

  LOADED_ENV_FILES.add(resolved);
  return loadedKeys;
}

export function loadUserEnv(projectRoot = process.cwd()): string {
  const root = path.resolve(projectRoot);
  loadEnvFile(path.join(root, ".env.local"));

  const appUser = getAppUser(root);
  if (appUser) {
    loadEnvFile(path.join(root, `.env.${appUser}.local`), {
      override: true,
      protectedKeys: USER_FILE_PROTECTED_KEYS,
    });
  }

  return appUser;
}

export function getAppUser(projectRoot = process.cwd(), args = process.argv.slice(2)): string {
  const cliUser = Array.isArray(args) ? args.find((a) => /^(user|appUser)=/i.test(a)) : null;
  if (cliUser) {
    const u = normalizeUser(cliUser.split("=")[1]);
    if (u) {
      process.env.APP_USER = u;
      return u;
    }
  }

  const explicitUser = getFirstEnv(EXPLICIT_USER_ENV_KEYS);
  if (explicitUser) return explicitUser;

  const osUser = getFirstEnv(OS_USER_ENV_KEYS);
  if (osUser && fs.existsSync(path.join(projectRoot, `data_${osUser}`))) {
    return osUser;
  }

  return "";
}

export function getDataDirName(projectRoot = process.cwd()): string {
  const explicitDataDir = String(process.env.DATA_DIR || "").trim();
  if (explicitDataDir) return explicitDataDir;

  const appUser = getAppUser(projectRoot);
  return appUser ? `data_${appUser}` : "data";
}

export function getDataPath(...parts: string[]): string {
  return path.join(process.cwd(), getDataDirName(), ...parts);
}

export function getMongoUri(): string {
  const appUser = getAppUser();
  const suffix = appUser.replace(/[^a-z0-9]+/gi, "_").toUpperCase();
  const keys = suffix
    ? [
        `MONGODB_URI_${suffix}`,
        `MONGOURL_${suffix}`,
        `MONGO_URL_${suffix}`,
        "MONGODB_URI",
        "MONGOURL",
      ]
    : ["MONGODB_URI", "MONGOURL"];

  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }

  return "";
}

export function getMongoEnvHint(): string {
  const appUser = getAppUser();
  if (!appUser) return "MONGODB_URI";
  const suffix = appUser.replace(/[^a-z0-9]+/gi, "_").toUpperCase();
  return `MONGODB_URI_${suffix} or MONGOURL_${suffix}`;
}

function autoLoadUserEnv(): void {
  const root = process.cwd();
  if (fs.existsSync(path.join(root, ".env.local"))) {
    loadUserEnv(root);
  }
}

autoLoadUserEnv();
