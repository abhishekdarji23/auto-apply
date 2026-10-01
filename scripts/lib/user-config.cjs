/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");

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

function loadEnvFile(envPath, { override = false, protectedKeys = ORIGINAL_ENV_KEYS } = {}) {
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

function loadUserEnv(projectRoot = process.cwd()) {
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

function getAppUser(projectRoot = process.cwd()) {
  const explicitUser = getFirstEnv(EXPLICIT_USER_ENV_KEYS);
  if (explicitUser) return explicitUser;

  const osUser = getFirstEnv(OS_USER_ENV_KEYS);
  if (osUser && fs.existsSync(path.join(projectRoot, `data_${osUser}`))) {
    return osUser;
  }

  return "";
}

function getDataDirName(projectRoot = process.cwd()) {
  const explicitDataDir = String(process.env.DATA_DIR || "").trim();
  if (explicitDataDir) return explicitDataDir;

  const appUser = getAppUser(projectRoot);
  return appUser ? `data_${appUser}` : "data";
}

function getDataPath(projectRoot, ...parts) {
  return path.join(projectRoot, getDataDirName(projectRoot), ...parts);
}

function getMongoUri(projectRoot = process.cwd()) {
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

function getMongoEnvHint(projectRoot = process.cwd()) {
  const appUser = getAppUser(projectRoot);
  if (!appUser) return "MONGODB_URI";
  const suffix = appUser.replace(/[^a-z0-9]+/gi, "_").toUpperCase();
  return `MONGODB_URI_${suffix} or MONGOURL_${suffix}`;
}

function applyUserMongoEnv(projectRoot = process.cwd()) {
  const mongoUri = getMongoUri(projectRoot);
  if (mongoUri) process.env.MONGODB_URI = mongoUri;
  return mongoUri;
}

function autoLoadUserEnv() {
  const root = process.cwd();
  if (fs.existsSync(path.join(root, ".env.local"))) {
    loadUserEnv(root);
  }
}

module.exports = {
  loadUserEnv,
  getAppUser,
  getDataDirName,
  getDataPath,
  getMongoUri,
  getMongoEnvHint,
  applyUserMongoEnv,
};

autoLoadUserEnv();
