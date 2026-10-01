"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { ArrowLeft, FileText, Loader2 } from "lucide-react";

type ResumeApiSuccess = {
  success: true;
  folderName: string;
  folderPath: string;
  pdfBytes: number;
  profileBytes: number;
  links: {
    resume_download: string;
    resume_preview: string;
    resume: string;
  };
  files: {
    jobUrl: string;
    latex: string;
    pdf: string;
    profile: string;
    log: string;
    meta: string;
  };
};

type ResumeApiFailure = {
  success?: false;
  error: string;
  details?: string;
  folderName?: string;
  folderPath?: string;
  files?: {
    jobUrl?: string;
    latex?: string;
  };
};

export default function ResumePage() {
  const [jobUrl, setJobUrl] = useState("");
  const [latex, setLatex] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ResumeApiSuccess | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setResult(null);

    try {
      const response = await fetch("/api/resume", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jobUrl,
          latex,
          mode: "manualApply",
        }),
      });

      const data = (await response.json()) as ResumeApiSuccess | ResumeApiFailure;
      if (!response.ok || !data || !("success" in data) || data.success !== true) {
        const err = data as ResumeApiFailure;
        const details = err.details ? `\n${err.details}` : "";
        throw new Error(`${err.error || "Failed to generate resume"}${details}`);
      }

      setResult(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="h-screen overflow-y-auto bg-neutral-50 dark:bg-neutral-950">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Resume PDF Builder</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
              Enter a job URL and LaTeX resume content. Files are saved under a folder named with the encoded URL.
            </p>
          </div>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-white dark:hover:bg-neutral-900 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </Link>
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 sm:p-5"
        >
          <div className="space-y-1.5">
            <label htmlFor="job-url" className="block text-sm font-medium">
              Job URL
            </label>
            <input
              id="job-url"
              type="url"
              placeholder="https://example.com/job/123"
              value={jobUrl}
              onChange={(e) => setJobUrl(e.target.value)}
              className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              required
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="latex" className="block text-sm font-medium">
              Resume LaTeX
            </label>
            <textarea
              id="latex"
              placeholder={"\\documentclass{article}\n\\begin{document}\nHello Resume\n\\end{document}"}
              value={latex}
              onChange={(e) => setLatex(e.target.value)}
              className="w-full min-h-[360px] rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              required
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-medium transition-colors"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <FileText className="w-4 h-4" />
                  Generate Resume Assets
                </>
              )}
            </button>

            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Requires `pdflatex` available in your PATH.
            </span>
          </div>
        </form>

        {error && (
          <div className="rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 p-3">
            <p className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap">{error}</p>
          </div>
        )}

        {result && (
          <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/20 p-4 space-y-2">
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
              resume.pdf + profile.json generated successfully
            </p>
            <p className="text-xs text-neutral-700 dark:text-neutral-300">
              Folder: <code>{result.folderPath}</code>
            </p>
            <p className="text-xs text-neutral-700 dark:text-neutral-300">
              PDF: <code>{result.files.pdf}</code> ({result.pdfBytes} bytes)
            </p>
            <p className="text-xs text-neutral-700 dark:text-neutral-300">
              Profile JSON: <code>{result.files.profile}</code> ({result.profileBytes} bytes)
            </p>
            <p className="text-xs text-neutral-700 dark:text-neutral-300">
              Saved files: <code>{result.files.jobUrl}</code>, <code>{result.files.latex}</code>,{" "}
              <code>{result.files.log}</code>, <code>{result.files.meta}</code>,{" "}
              <code>{result.files.profile}</code>
            </p>
            <p className="text-xs text-neutral-700 dark:text-neutral-300 break-all">
              Local links: <code>{result.links.resume_download}</code>
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
