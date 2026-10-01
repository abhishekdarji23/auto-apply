/**
 * start-brave.mjs
 *
 * Launches Brave with the "auto-apply" profile for Auto Apply (CDP :9222).
 * GPT service keeps using its own Chrome/Playwright profile — do not touch chrome.exe.
 *
 * Chrome/Brave 136+ ignore --remote-debugging-port on the everyday User Data path,
 * so we sync the selected profile into a non-standard Brave-JobTrack copy, then launch
 * that copy with CDP + the local simplify-modify extension.
 */

import net from "net";
import os from "os";
import path from "path";
import fs from "fs";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { getAppUser, loadUserEnv } from "./lib/user-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
loadUserEnv(REPO_ROOT);
const APP_USER = getAppUser(REPO_ROOT);

const DEBUG_PORT = parseInt(process.env.BRAVE_DEBUG_PORT ?? process.env.CHROME_DEBUG_PORT ?? "9222", 10);
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

function firstExisting(candidates) {
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return "";
}

function resolveBraveExec() {
    if (process.env.BRAVE_PATH) return process.env.BRAVE_PATH;
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH; // override only if forced

    if (IS_WIN) {
        return firstExisting([
            path.join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            path.join(process.env.PROGRAMFILES || "C:\\Program Files", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        ]);
    }

    if (IS_MAC) {
        return firstExisting([
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            path.join(os.homedir(), "Applications", "Brave Browser.app", "Contents", "MacOS", "Brave Browser"),
            path.join(REPO_ROOT, "..", "Brave Browser.app", "Contents", "MacOS", "Brave Browser"),
            path.join(REPO_ROOT, "Brave Browser.app", "Contents", "MacOS", "Brave Browser"),
            "/Users/spartan/Desktop/coding/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]);
    }

    return firstExisting(["brave-browser", "brave"]);
}

/** Everyday Brave profile root (CDP blocked here on recent Chromium). */
function resolveSourceUserDataDir() {
    if (process.env.BRAVE_SOURCE_USER_DATA_DIR) return process.env.BRAVE_SOURCE_USER_DATA_DIR;
    if (IS_WIN) return path.join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "User Data");
    if (IS_MAC) return path.join(os.homedir(), "Library", "Application Support", "BraveSoftware", "Brave-Browser");
    return path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser");
}

/** Non-standard copy path so CDP actually enables. */
function resolveBraveUserDataDir() {
    if (process.env.BRAVE_USER_DATA_DIR) return process.env.BRAVE_USER_DATA_DIR;
    if (process.env.BRAVE_PROFILE) return process.env.BRAVE_PROFILE;
    if (process.env.CHROME_USER_DATA_DIR) return process.env.CHROME_USER_DATA_DIR;

    if (IS_WIN) return path.join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser-JobTrack");
    if (IS_MAC) return path.join(os.homedir(), "Library", "Application Support", "BraveSoftware", "Brave-Browser-JobTrack");
    return path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser-JobTrack");
}

/**
 * Resolve which profile directory to use.
 * On this machine Local State maps: Default=Personal, Profile 1=auto-apply.
 */
function resolveBraveProfileDirectory(sourceUserDataDir) {
    if (process.env.BRAVE_PROFILE_DIRECTORY || process.env.CHROME_PROFILE_DIRECTORY) {
        return process.env.BRAVE_PROFILE_DIRECTORY || process.env.CHROME_PROFILE_DIRECTORY;
    }

    const wanted = String(process.env.BRAVE_PROFILE_NAME || "auto-apply").trim().toLowerCase();
    const localStatePath = path.join(sourceUserDataDir, "Local State");
    try {
        const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
        const cache = localState?.profile?.info_cache || {};
        for (const [dir, info] of Object.entries(cache)) {
            const names = [info?.name, info?.gaia_name, info?.user_name]
                .filter(Boolean)
                .map((s) => String(s).trim().toLowerCase());
            if (names.some((n) => n === wanted || n.includes(wanted))) {
                return dir;
            }
        }
    } catch {
        // fall through
    }

    // Fallback known mapping for this user
    if (fs.existsSync(path.join(sourceUserDataDir, "Profile 1"))) return "Profile 1";
    return "Default";
}

function resolveSimplifyExtensionDir() {
    if (process.env.SIMPLIFY_EXTENSION_DIR) return process.env.SIMPLIFY_EXTENSION_DIR;
    return firstExisting([
        path.join(REPO_ROOT, "..", "simplify-modify"),
        path.join(os.homedir(), "Desktop", "coding", "simplify-modify"),
        "C:\\Users\\019158958\\Desktop\\coding\\simplify-modify",
    ]);
}

const BRAVE_EXEC = resolveBraveExec();
const SOURCE_USER_DATA_DIR = resolveSourceUserDataDir();
const BRAVE_USER_DATA_DIR = resolveBraveUserDataDir();
const BRAVE_PROFILE_DIRECTORY = resolveBraveProfileDirectory(SOURCE_USER_DATA_DIR);
const SIMPLIFY_EXTENSION_DIR = resolveSimplifyExtensionDir();

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function isCdpPortOpen() {
    return new Promise((resolve) => {
        const sock = net.createConnection({ host: "127.0.0.1", port: DEBUG_PORT });
        sock.once("connect", () => { sock.destroy(); resolve(true); });
        sock.once("error", () => resolve(false));
        sock.setTimeout(600, () => { sock.destroy(); resolve(false); });
    });
}

function isBraveRunning() {
    try {
        if (IS_WIN) {
            const out = execSync('tasklist /FI "IMAGENAME eq brave.exe"', { stdio: "pipe" }).toString();
            return /brave\.exe/i.test(out);
        }
        if (IS_MAC) {
            return execSync("pgrep -x 'Brave Browser'", { stdio: "pipe" }).toString().trim().length > 0;
        }
        execSync("pgrep -x brave || pgrep -x brave-browser", { stdio: "pipe", shell: true });
        return true;
    } catch {
        return false;
    }
}

async function quitBraveOnlyAndWait() {
    // Never kill chrome.exe — GPT service uses Chrome/Playwright.
    for (let attempt = 0; attempt < 12; attempt++) {
        try {
            if (IS_WIN) {
                execSync("taskkill /IM brave.exe /F /T", { stdio: "pipe" });
            } else if (IS_MAC) {
                try {
                    execSync("osascript -e 'quit app \"Brave Browser\"'", { stdio: "pipe" });
                } catch {
                    try { execSync("pkill -x 'Brave Browser'", { stdio: "pipe" }); } catch { /* gone */ }
                }
            } else {
                try {
                    execSync("pkill -x brave || pkill -x brave-browser || true", {
                        stdio: "pipe",
                        shell: true,
                    });
                } catch { /* ignore */ }
            }
        } catch {
            // already gone
        }
        await sleep(700);
        if (!isBraveRunning()) return true;
    }
    return !isBraveRunning();
}

function copyPathRecursive(src, dst) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (IS_WIN) {
        const exclude = [
            "Cache",
            "Code Cache",
            "GPUCache",
            "GrShaderCache",
            "ShaderCache",
            "DawnGraphiteCache",
            "DawnWebGPUCache",
        ];
        const args = [src, dst, "/E", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"];
        for (const dir of exclude) args.push("/XD", dir);

        const result = spawn("robocopy", args, {
            stdio: "ignore",
            windowsHide: true,
            shell: false,
        });
        return new Promise((resolve, reject) => {
            result.on("error", reject);
            result.on("close", (code) => {
                if (code != null && code >= 16) {
                    reject(new Error(`robocopy failed with code ${code}`));
                } else {
                    if (code != null && code >= 8) {
                        console.warn(`⚠️   Profile sync finished with robocopy code ${code} (some files skipped). Continuing.`);
                    }
                    resolve();
                }
            });
        });
    }

    fs.mkdirSync(dst, { recursive: true });
    execSync(`ditto ${JSON.stringify(src)} ${JSON.stringify(dst)}`, { stdio: "pipe" });
    return Promise.resolve();
}

function copyFileBestEffort(src, dst, label) {
    if (!fs.existsSync(src)) return false;

    fs.mkdirSync(path.dirname(dst), { recursive: true });

    try {
        fs.rmSync(dst, { force: true });
    } catch {
        // Continue and try copyFile below; the destination may not exist.
    }

    try {
        fs.copyFileSync(src, dst);
        return true;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️   Could not copy ${label}: ${message}`);
        console.warn("     Continuing with the existing/generated Brave-JobTrack metadata.");
        return false;
    }
}

function hasUsableBraveProfile(profileDir) {
    return fs.existsSync(path.join(profileDir, "Preferences")) ||
        fs.existsSync(path.join(profileDir, "Default", "Preferences"));
}

async function syncSelectedProfileIntoJobTrack() {
    const srcProfile = path.join(SOURCE_USER_DATA_DIR, BRAVE_PROFILE_DIRECTORY);
    const dstProfile = path.join(BRAVE_USER_DATA_DIR, BRAVE_PROFILE_DIRECTORY);
    const srcLocalState = path.join(SOURCE_USER_DATA_DIR, "Local State");
    const dstLocalState = path.join(BRAVE_USER_DATA_DIR, "Local State");

    const forceSync = process.argv.includes("--sync") ||
                      process.argv.includes("sync") ||
                      process.env.BRAVE_SYNC_PROFILE === "true";

    const dstExists = hasUsableBraveProfile(dstProfile);

    if (dstExists && !forceSync) {
        console.log(`🔒  Preserving existing Brave-JobTrack profile (logins & sessions retained).`);
        console.log(`    profile dir: ${BRAVE_PROFILE_DIRECTORY}`);
        console.log(`    running    : ${dstProfile}`);
        console.log(`    (To force re-sync from main Brave: npm run brave -- --sync)`);

        for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"]) {
            try { fs.unlinkSync(path.join(BRAVE_USER_DATA_DIR, name)); } catch { /* ok */ }
        }
        return;
    }

    if (!fs.existsSync(srcProfile)) {
        throw new Error(
            `Brave profile not found: ${srcProfile}. Expected "auto-apply" → Profile 1. Set BRAVE_PROFILE_DIRECTORY to override.`
        );
    }

    fs.mkdirSync(BRAVE_USER_DATA_DIR, { recursive: true });

    console.log(`📦  Syncing Brave profile "${process.env.BRAVE_PROFILE_NAME || "auto-apply"}" into Brave-JobTrack (initial setup/sync)…`);
    console.log(`    profile dir: ${BRAVE_PROFILE_DIRECTORY}`);
    console.log(`    from: ${srcProfile}`);
    console.log(`    to  : ${dstProfile}`);

    copyFileBestEffort(srcLocalState, dstLocalState, "Brave Local State");

    try {
        await copyPathRecursive(srcProfile, dstProfile);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!hasUsableBraveProfile(dstProfile)) throw err;

        console.warn(`⚠️   Profile copy blocked: ${message}`);
        console.warn("     Using the existing Brave-JobTrack profile copy.");
        console.warn("     If cookies look old, give Terminal Full Disk Access and run npm run brave again.");
    }

    for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"]) {
        try { fs.unlinkSync(path.join(BRAVE_USER_DATA_DIR, name)); } catch { /* ok */ }
    }
}

function launchBrave() {
    if (!BRAVE_EXEC) {
        throw new Error("Brave executable not found. Set BRAVE_PATH to brave.exe");
    }

    fs.mkdirSync(BRAVE_USER_DATA_DIR, { recursive: true });

    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${BRAVE_USER_DATA_DIR}`,
        `--profile-directory=${BRAVE_PROFILE_DIRECTORY}`,
    ];

    if (SIMPLIFY_EXTENSION_DIR && fs.existsSync(path.join(SIMPLIFY_EXTENSION_DIR, "manifest.json"))) {
        args.push(`--load-extension=${SIMPLIFY_EXTENSION_DIR}`);
        console.log(`🧩  Loading Simplify extension: ${SIMPLIFY_EXTENSION_DIR}`);
    } else {
        console.warn("⚠️   simplify-modify not found — install/path it next to auto-apply.");
    }

    const child = spawn(BRAVE_EXEC, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
    });
    child.on("error", (err) => {
        console.error("Failed to spawn Brave:", err.message);
    });
    child.unref();
}

async function waitForCdp(timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isCdpPortOpen()) return true;
        await sleep(400);
    }
    return false;
}

async function getCdpBrowserName() {
    try {
        const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        const json = await res.json();
        return String(json?.Browser || "");
    } catch {
        return "";
    }
}

async function freeCdpPortIfWrongBrowser() {
    if (!(await isCdpPortOpen())) return;

    // Brave's CDP "Browser" field often looks like "Chrome/…" — detect via process list.
    if (isBraveRunning()) {
        const lines = (() => {
            try {
                if (IS_WIN) {
                    const out = execSync(
                        "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"name='brave.exe'\\\" | Select-Object -ExpandProperty CommandLine\"",
                        { stdio: "pipe", windowsHide: true }
                    ).toString();
                    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
                }
                if (IS_MAC) {
                    const out = execSync("ps -eo command | grep -i 'Brave Browser' | grep -v grep", { stdio: "pipe" }).toString();
                    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
                }
                return [];
            } catch {
                return [];
            }
        })();
        const ours = lines.some((line) =>
            /remote-debugging-port=9222/i.test(line) || /Brave-Browser-JobTrack/i.test(line)
        );
        if (ours) return;
    }

    console.log(`ℹ️   Port ${DEBUG_PORT} is held by a non-Brave process — freeing it for Brave…`);
    if (IS_WIN) {
        const ps = `
Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | ForEach-Object {
  $cmd = $_.CommandLine
  if ($cmd -and ($cmd -match 'Chrome-JobTrack' -or $cmd -match 'remote-debugging-port=${DEBUG_PORT}')) {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
`;
        try {
            execSync(`powershell -NoProfile -Command ${JSON.stringify(ps)}`, {
                stdio: "pipe",
                windowsHide: true,
            });
        } catch { /* ignore */ }
    }
    await sleep(1500);
}

async function main() {
    await freeCdpPortIfWrongBrowser();

    if (await isCdpPortOpen()) {
        const browser = await getCdpBrowserName();
        console.log(`✅  Brave already running with --remote-debugging-port=${DEBUG_PORT}`);
        console.log(`    ${browser || "Brave"}`);
        console.log("    Auto Apply will use this Brave window (auto-apply profile + Simplify).");
        console.log("    GPT service Chrome is separate — left alone.");
        return;
    }

    if (!BRAVE_EXEC) {
        console.error("❌  Brave not found.");
        console.error("    Set BRAVE_PATH to your brave.exe and retry.");
        return;
    }

    // If something else (old Chrome JobTrack) is holding 9222 we already returned above.
    // Close Brave only so Chrome/GPT stays up.
    if (isBraveRunning()) {
        console.log("ℹ️   Closing Brave so we can launch with CDP… (Chrome / GPT left running)");
        const closed = await quitBraveOnlyAndWait();
        if (!closed) {
            console.warn("⚠️   Could not fully quit Brave. Close Brave windows, then run: npm run brave");
            return;
        }
    } else {
        console.log("ℹ️   Brave not running — preparing profile, then launching… (Chrome / GPT left alone)");
    }

    try {
        await syncSelectedProfileIntoJobTrack();
    } catch (err) {
        console.error("❌  Profile sync failed:", err instanceof Error ? err.message : String(err));
        return;
    }

    console.log(`🚀  Launching Brave (auto-apply) with CDP :${DEBUG_PORT}`);
    console.log(`    user     : ${APP_USER || "(default)"}`);
    console.log(`    exec     : ${BRAVE_EXEC}`);
    console.log(`    profile  : ${BRAVE_PROFILE_DIRECTORY} (auto-apply)`);
    console.log(`    source   : ${path.join(SOURCE_USER_DATA_DIR, BRAVE_PROFILE_DIRECTORY)}`);
    console.log(`    running  : ${path.join(BRAVE_USER_DATA_DIR, BRAVE_PROFILE_DIRECTORY)}`);
    console.log("    Apply → Brave/auto-apply | GPT service → Chrome (unchanged)");
    console.log("");

    launchBrave();

    console.log("⏳  Waiting for Brave CDP port to be ready…");
    const ready = await waitForCdp();
    if (ready) {
        console.log(`✅  Ready. CDP ${DEBUG_PORT} open on Brave profile auto-apply + Simplify.`);
        console.log("    Keep this Brave open, then run ats-bulk.");
    } else {
        console.warn(`⚠️   Brave did not open port ${DEBUG_PORT} in time.`);
        console.warn(`    BRAVE_EXEC: ${BRAVE_EXEC}`);
        console.warn(`    PROFILE  : ${BRAVE_PROFILE_DIRECTORY}`);
        console.warn(`    COPY     : ${BRAVE_USER_DATA_DIR}`);
    }
}

main().catch((err) => {
    console.error("start-brave error:", err?.message || err);
});
