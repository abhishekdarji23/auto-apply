"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, RefreshCw, Trash2, Eye } from "lucide-react";

type ResumeEntry = {
  mode: string;
  email: string;
  folder: string;
  jobUrl: string;
  ats: string;
  title: string;
  company: string;
  pdfFile: string;
  createdAt: string;
  postedAt: string;
};

export default function ResumeDashboardPage() {
  const [resumes, setResumes] = useState<ResumeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const [titleFilter, setTitleFilter] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");
  const [emailFilter, setEmailFilter] = useState("");
  const [atsFilter, setAtsFilter] = useState("all");

  const atsOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of resumes) if (r.ats) seen.add(r.ats);
    return Array.from(seen).sort();
  }, [resumes]);

  const filtered = useMemo(() => {
    return resumes.filter((r) => {
      const t = !titleFilter.trim() || r.title.toLowerCase().includes(titleFilter.trim().toLowerCase());
      const c = !companyFilter.trim() || r.company.toLowerCase().includes(companyFilter.trim().toLowerCase());
      const e = !emailFilter.trim() || r.email.toLowerCase().includes(emailFilter.trim().toLowerCase());
      const a = atsFilter === "all" || r.ats === atsFilter;
      return t && c && e && a;
    });
  }, [resumes, titleFilter, companyFilter, emailFilter, atsFilter]);

  const todayCount = useMemo(() => {
    return resumes.filter((r) => isToday(r.createdAt)).length;
  }, [resumes]);

  const loadResumes = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    else setRefreshing(true);
    try {
      const res = await fetch("/api/resume-dashboard", { cache: "no-store" });
      const data = (await res.json()) as { success: boolean; resumes?: ResumeEntry[] };
      if (res.ok && data.success) setResumes(data.resumes || []);
    } finally {
      if (showSpinner) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

  useEffect(() => { void loadResumes(true); }, [loadResumes]);

  async function handleDelete(entry: ResumeEntry) {
    const key = entryKey(entry);
    setDeletingKey(key);
    try {
      const res = await fetch("/api/resume-dashboard", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: entry.email, mode: entry.mode, folder: entry.folder }),
      });
      if (res.ok) {
        setResumes((prev) => prev.filter((r) => entryKey(r) !== key));
      }
    } finally {
      setDeletingKey(null);
    }
  }

  function previewUrl(entry: ResumeEntry): string {
    const p = new URLSearchParams({ email: entry.email, mode: entry.mode, folder: entry.folder });
    return `/api/resume-dashboard/file?${p.toString()}`;
  }

  return (
    <main className="h-screen overflow-y-auto bg-neutral-50 dark:bg-neutral-950">
      <div className="w-full px-4 sm:px-6 lg:px-8 py-8 space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Resume Dashboard</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
              Generated resumes that have not been applied yet. Applied resumes appear in the Auto Apply Dashboard.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void loadResumes(false)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-sm hover:bg-white dark:hover:bg-neutral-900 transition-colors"
            >
              {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </button>
            <Link
              href="/resume-analytics"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-sm hover:bg-white dark:hover:bg-neutral-900 transition-colors"
            >
              Resume Analytics
            </Link>
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-sm hover:bg-white dark:hover:bg-neutral-900 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> Back
            </Link>
          </div>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Total Pending" value={resumes.length} color="text-blue-700 dark:text-blue-300" />
          <StatCard label="Generated Today" value={todayCount} color="text-violet-700 dark:text-violet-300" />
          <StatCard label="Showing" value={filtered.length} color="text-neutral-700 dark:text-neutral-300" />
        </div>

        {/* Filters */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <input
              value={titleFilter}
              onChange={(e) => setTitleFilter(e.target.value)}
              placeholder="Filter by title"
              className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
            />
            <input
              value={companyFilter}
              onChange={(e) => setCompanyFilter(e.target.value)}
              placeholder="Filter by company"
              className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
            />
            <input
              value={emailFilter}
              onChange={(e) => setEmailFilter(e.target.value)}
              placeholder="Filter by email"
              className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
            />
            <select
              value={atsFilter}
              onChange={(e) => setAtsFilter(e.target.value)}
              className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
            >
              <option value="all">All ATS</option>
              {atsOptions.map((a) => (
                <option key={a} value={a}>{a.toUpperCase()}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-100 dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-800 text-left">
                <th className="px-3 py-2 w-10">#</th>
                <th className="px-3 py-2 w-24">ATS</th>
                <th className="px-3 py-2 min-w-40">Email</th>
                <th className="px-3 py-2 min-w-56">Job</th>
                <th className="px-3 py-2 min-w-36">Company</th>
                <th className="px-3 py-2 w-28">Posted</th>
                <th className="px-3 py-2 w-28">Generated</th>
                <th className="px-3 py-2 w-24">Preview</th>
                <th className="px-3 py-2 w-20">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-neutral-500">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                    </span>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-neutral-500">
                    {resumes.length === 0
                      ? "No pending resumes found. All generated resumes have been applied or none exist yet."
                      : "No resumes match the current filters."}
                  </td>
                </tr>
              ) : (
                filtered.map((entry, idx) => {
                  const key = entryKey(entry);
                  const busy = deletingKey === key;
                  return (
                    <tr key={key} className="border-b border-neutral-100 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-900/50">
                      <td className="px-3 py-2 text-neutral-400">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 uppercase font-medium">
                          {entry.ats}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400 break-all">
                        {entry.email || "—"}
                      </td>
                      <td className="px-3 py-2">
                        <a
                          href={entry.jobUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-blue-600 dark:text-blue-400 hover:underline line-clamp-2"
                        >
                          {entry.title || "(untitled)"}
                        </a>
                      </td>
                      <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">
                        {entry.company || "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-neutral-500 dark:text-neutral-400">
                        {formatDate(entry.postedAt)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-neutral-500 dark:text-neutral-400">
                        {formatDate(entry.createdAt)}
                      </td>
                      <td className="px-3 py-2">
                        {entry.pdfFile ? (
                          <a
                            href={previewUrl(entry)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
                          >
                            <Eye className="w-3 h-3" /> Preview
                          </a>
                        ) : (
                          <span className="text-xs text-neutral-400">No PDF</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => void handleDelete(entry)}
                          disabled={busy}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs hover:bg-red-100 dark:hover:bg-red-900/50 disabled:opacity-50 transition-colors"
                        >
                          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

      </div>
    </main>
  );
}

function entryKey(entry: ResumeEntry): string {
  return `${entry.mode}|||${entry.email}|||${entry.folder}`;
}

function isToday(dateStr: string): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-4 py-3">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className={`text-xl font-semibold ${color}`}>{value}</p>
    </div>
  );
}
