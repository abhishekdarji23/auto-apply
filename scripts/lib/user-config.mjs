import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const EXPLICIT_USER_ENV_KEYS = ["APP_USER", "JOBTRACK_USER", "DATA_USER"];
const OS_USER_ENV_KEYS = ["USER", "USERNAME"];
const USER_FILE_PROTECTED_KEYS = new Set(EXPLICIT_USER_ENV_KEYS);
const ORIGINAL_ENV_KEYS = new Set(Object.keys(process.env));
const LOADED_ENV_FILES = new Set();

function normalizeUser(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function getFirstEnv(keys) {
  for (const key of keys) {
    const value = normalizeUser(process.env[key]);
    if (value) return value;
  }
  return "";
}

export function loadEnvFile(envPath, { override = false, protectedKeys = ORIGINAL_ENV_KEYS } = {}) {
  const resolved = path.resolve(envPath);
  if (LOADED_ENV_FILES.has(resolved) || !fs.existsSync(resolved)) return new Set();

  const parsed = parseEnv(fs.readFileSync(resolved, "utf8"));
  const loadedKeys = new Set();
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

export function loadUserEnv(projectRoot = process.cwd()) {
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

export function getAppUser(projectRoot = process.cwd(), args = process.argv.slice(2)) {
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

export function getDataDirName(projectRoot = process.cwd()) {
  const explicitDataDir = String(process.env.DATA_DIR || "").trim();
  if (explicitDataDir) return explicitDataDir;

  const appUser = getAppUser(projectRoot);
  return appUser ? `data_${appUser}` : "data";
}

export function getDataPath(projectRoot, ...parts) {
  return path.join(projectRoot, getDataDirName(projectRoot), ...parts);
}

export function getMongoUri(projectRoot = process.cwd()) {
  const appUser = getAppUser(projectRoot);
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

export function getMongoEnvHint(projectRoot = process.cwd()) {
  const appUser = getAppUser(projectRoot);
  if (!appUser) return "MONGODB_URI";
  const suffix = appUser.replace(/[^a-z0-9]+/gi, "_").toUpperCase();
  return `MONGODB_URI_${suffix} or MONGOURL_${suffix}`;
}

export function applyUserMongoEnv(projectRoot = process.cwd()) {
  const mongoUri = getMongoUri(projectRoot);
  if (mongoUri) process.env.MONGODB_URI = mongoUri;
  return mongoUri;
}

export function getJobtrackOrigin(args = process.argv.slice(2)) {
  // 1. CLI argument: origin=http://localhost:3001
  const cliOrigin = Array.isArray(args) ? args.find((a) => /^origin=/i.test(a)) : null;
  if (cliOrigin) {
    const val = String(cliOrigin.split("=")[1] || "").trim().replace(/\/+$/, "");
    if (val) {
      process.env.JOBTRACK_API_ORIGIN = val;
      return val;
    }
  }

  // 2. CLI argument: port=3001
  const cliPort = Array.isArray(args) ? args.find((a) => /^port=/i.test(a)) : null;
  if (cliPort) {
    const port = String(cliPort.split("=")[1] || "").trim();
    if (port) {
      const val = `http://localhost:${port}`;
      process.env.JOBTRACK_API_ORIGIN = val;
      process.env.PORT = port;
      return val;
    }
  }

  // 3. Explicit env variable: JOBTRACK_API_ORIGIN
  if (process.env.JOBTRACK_API_ORIGIN) {
    return String(process.env.JOBTRACK_API_ORIGIN).trim().replace(/\/+$/, "");
  }

  // 4. Env variable: PORT or JOBTRACK_PORT (e.g. PORT=3001 npm run ...)
  const envPort = String(process.env.PORT || process.env.JOBTRACK_PORT || "").trim();
  if (envPort) {
    const val = `http://localhost:${envPort}`;
    process.env.JOBTRACK_API_ORIGIN = val;
    return val;
  }

  // 5. Default: port 3000
  const defaultOrigin = "http://localhost:3000";
  process.env.JOBTRACK_API_ORIGIN = defaultOrigin;
  return defaultOrigin;
}

function autoLoadUserEnv() {
  const root = process.cwd();
  if (fs.existsSync(path.join(root, ".env.local"))) {
    loadUserEnv(root);
  }
  getJobtrackOrigin();
}

autoLoadUserEnv();
