import { spawn } from "child_process";
import path from "path";
import { detectATS } from "@/lib/ats-map";

export type RunAutoApplyResult = {
  success: boolean;
  atsId: string;
  trackingSaved?: boolean;
  error?: string;
};

const ROOT = process.cwd();
const ACTIVE_APPLY_ATS = new Set(["workday", "greenhouse"]);

// Serial lock — ensures only one child process runs at a time.
// If a second call arrives while a job is in progress, it queues behind the first.
let _jobQueue: Promise<unknown> = Promise.resolve();

export async function runAutoApplyJob({
  jobId,
  jobrightJobId,
  url,
  defaultResume = false,
}: {
  jobId: string;
  jobrightJobId?: string;
  url: string;
  defaultResume?: boolean;
}): Promise<RunAutoApplyResult> {
  const atsEntry = detectATS(url);
  if (!atsEntry) {
    return { success: false, atsId: "", error: "unsupported_ats" };
  }
  if (!ACTIVE_APPLY_ATS.has(atsEntry.id)) {
    return { success: false, atsId: atsEntry.id, error: "unsupported_ats" };
  }

  // Chain onto the queue so concurrent HTTP calls run sequentially, not in parallel.
  const entry = _jobQueue.then(() => _runOne({ jobId, jobrightJobId, url, atsId: atsEntry.id, defaultResume }));
  // Update the tail — ignore errors so the chain never stalls.
  _jobQueue = entry.catch(() => undefined);
  return entry;
}

async function _runOne({
  jobId,
  jobrightJobId,
  url,
  atsId,
  defaultResume,
}: {
  jobId: string;
  jobrightJobId?: string;
  url: string;
  atsId: string;
  defaultResume?: boolean;
}): Promise<RunAutoApplyResult> {
  const runnerPath = path.join(ROOT, "scripts/ats/run-ats.mjs");
  const JOB_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes

  const result = await new Promise<{ success: boolean; error?: string; trackingSaved?: boolean }>((resolve) => {
    let settled = false;
    const settle = (value: { success: boolean; error?: string; trackingSaved?: boolean }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const child = spawn(process.execPath, [runnerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      windowsHide: true,
    });

    child.stdin.write(JSON.stringify({ atsId, jobId, jobrightJobId, url, defaultResume }));
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => {
      const str = d.toString();
      stderr += str;
      // Avoid writing assertion aborts mid-line into the same terminal as ats-bulk.
      process.stderr.write(`[run-ats] ${str}`);
    });

    child.on("close", (code, signal) => {
      const rawStdout = stdout.trim();
      if (rawStdout) {
        // Prefer the last JSON line (in case logs leaked to stdout).
        const lines = rawStdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          try {
            const parsed = JSON.parse(lines[i]) as { success: boolean; error?: string; trackingSaved?: boolean };
            settle(parsed);
            return;
          } catch {
            // keep scanning
          }
        }
      }

      if (code === 0) {
        settle({ success: true });
        return;
      }

      const joined = stderr.replace(/\s+/g, " ").trim();
      if (/UV_HANDLE_CLOSING|handle->flags/i.test(joined)) {
        settle({
          success: false,
          error:
            "playwright_cdp_aborted_windows: Brave CDP connection closed uncleanly. " +
            "Restart with npm run brave, keep that Brave window open, then retry.",
        });
        return;
      }

      const errLine =
        stderr
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .filter((l) => !/UV_HANDLE_CLOSING|Assertion failed/i.test(l))
          .pop()
        || (signal ? `killed_signal_${signal}` : `exit_code_${code ?? "unknown"}`);
      settle({ success: false, error: errLine });
    });

    child.on("error", (err) => {
      settle({ success: false, error: err.message });
    });

    const timeout = setTimeout(() => {
      console.error(`[runAutoApply] Job timeout (${JOB_TIMEOUT_MS / 60000}min) — killing child process`);
      try { child.kill(); } catch { /* ignore */ }
      settle({ success: false, error: "timeout" });
    }, JOB_TIMEOUT_MS);

    child.on("close", () => {
      clearTimeout(timeout);
    });
  });

  return {
    success: result.success,
    atsId,
    trackingSaved: Boolean(result.trackingSaved),
    error: result.error,
  };
}
