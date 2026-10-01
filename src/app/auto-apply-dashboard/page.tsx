"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, RefreshCw, Trash2, RotateCcw, Play, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";

type TrackStatus = "success" | "failed" | "running" | "applied" | "skipped";

type TrackRow = {
  _id: string;
  jobId: string;
  title: string;
  company: string;
  category?: string;
  categoryLabel?: string;
  jobUrl: string;
  atsId: string;
  appliedEmail: string;
  resumePreviewLink: string;
  status: TrackStatus;
  lastError: string;
  lastTriedAt: string | null;
  appliedAt: string | null;
  postedAt: string | null;
  updatedAt: string;
};

const STATUS_LABELS: Record<TrackStatus, string> = {
  success: "Successful",
  failed: "Failed",
  running: "Running",
  applied: "Applied",
  skipped: "Skipped",
};

const COLUMN_CONFIG = [
  { key: "index", label: "#", defaultWidth: 72, minWidth: 56, sortable: false },
  { key: "job", label: "Job", defaultWidth: 320, minWidth: 220, sortable: true },
  { key: "company", label: "Company", defaultWidth: 200, minWidth: 140, sortable: true },
  { key: "category", label: "Category", defaultWidth: 180, minWidth: 130, sortable: true },
  { key: "ats", label: "ATS", defaultWidth: 110, minWidth: 90, sortable: true },
  { key: "email", label: "Email Used", defaultWidth: 260, minWidth: 180, sortable: true },
  { key: "resume", label: "Resume Preview", defaultWidth: 160, minWidth: 130, sortable: false },
  { key: "postedAt", label: "Posted", defaultWidth: 120, minWidth: 95, sortable: true },
  { key: "appliedAt", label: "Applied", defaultWidth: 120, minWidth: 95, sortable: true },
  { key: "status", label: "Status", defaultWidth: 280, minWidth: 180, sortable: true },
  { key: "actions", label: "Actions", defaultWidth: 260, minWidth: 220, sortable: false },
] as const;

type ColumnKey = (typeof COLUMN_CONFIG)[number]["key"];
type SortableKey = "job" | "company" | "category" | "ats" | "email" | "postedAt" | "appliedAt" | "status";
type SortDir = "asc" | "desc";

const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> = COLUMN_CONFIG.reduce((acc, column) => {
  acc[column.key] = column.defaultWidth;
  return acc;
}, {} as Record<ColumnKey, number>);

const MIN_COLUMN_WIDTHS: Record<ColumnKey, number> = COLUMN_CONFIG.reduce((acc, column) => {
  acc[column.key] = column.minWidth;
  return acc;
}, {} as Record<ColumnKey, number>);

export default function AutoApplyDashboardPage() {
  const [rows, setRows] = useState<TrackRow[]>([]);
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>(DEFAULT_COLUMN_WIDTHS);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const resizeStateRef = useRef<{ key: ColumnKey; startX: number; startWidth: number } | null>(null);

  const [url, setUrl] = useState("");
  const [titleFilter, setTitleFilter] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");
  const [emailFilter, setEmailFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | TrackStatus>("all");
  const [atsFilter, setAtsFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortableKey>("appliedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");

  const atsOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.atsId) seen.add(row.atsId);
    }
    return Array.from(seen).sort();
  }, [rows]);

  const categoryOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const row of rows) {
      const label = row.categoryLabel || "Others";
      if (label) seen.add(label);
    }
    return Array.from(seen).sort();
  }, [rows]);

  function handleSortClick(key: SortableKey) {
    setSortKey((prev) => {
      if (prev === key) return prev;
      return key;
    });
    setSortDir((prev) => (sortKey === key ? (prev === "asc" ? "desc" : "asc") : "asc"));
  }

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const titleMatches = !titleFilter.trim() || row.title.toLowerCase().includes(titleFilter.trim().toLowerCase());
      const companyMatches = !companyFilter.trim() || row.company.toLowerCase().includes(companyFilter.trim().toLowerCase());
      const emailMatches = !emailFilter.trim() || row.appliedEmail.toLowerCase().includes(emailFilter.trim().toLowerCase());
      const statusMatches = statusFilter === "all" || row.status === statusFilter;
      const atsMatches = atsFilter === "all" || row.atsId === atsFilter;
      const categoryMatches = categoryFilter === "all" || (row.categoryLabel || "Others") === categoryFilter;
      return titleMatches && companyMatches && emailMatches && statusMatches && atsMatches && categoryMatches;
    });
  }, [rows, titleFilter, companyFilter, emailFilter, statusFilter, atsFilter, categoryFilter]);

  const sortedRows = useMemo(() => {
    const copy = [...filteredRows];
    copy.sort((a, b) => {
      let aVal: string;
      let bVal: string;
      if (sortKey === "job") {
        aVal = (a.title ?? "").toLowerCase();
        bVal = (b.title ?? "").toLowerCase();
      } else if (sortKey === "company") {
        aVal = (a.company ?? "").toLowerCase();
        bVal = (b.company ?? "").toLowerCase();
      } else if (sortKey === "category") {
        aVal = (a.categoryLabel || a.category || "Others").toLowerCase();
        bVal = (b.categoryLabel || b.category || "Others").toLowerCase();
      } else if (sortKey === "ats") {
        aVal = (a.atsId ?? "").toLowerCase();
        bVal = (b.atsId ?? "").toLowerCase();
      } else if (sortKey === "email") {
        aVal = (a.appliedEmail ?? "").toLowerCase();
        bVal = (b.appliedEmail ?? "").toLowerCase();
      } else if (sortKey === "status") {
        aVal = a.status ?? "";
        bVal = b.status ?? "";
      } else if (sortKey === "postedAt") {
        aVal = a.postedAt ?? "";
        bVal = b.postedAt ?? "";
      } else {
        // appliedAt
        aVal = a.appliedAt ?? a.lastTriedAt ?? "";
        bVal = b.appliedAt ?? b.lastTriedAt ?? "";
      }
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filteredRows, sortKey, sortDir]);

  const statusCounts = useMemo(() => {
    const counts: Record<TrackStatus, { total: number; today: number }> = {
      success: { total: 0, today: 0 },
      failed: { total: 0, today: 0 },
      running: { total: 0, today: 0 },
      applied: { total: 0, today: 0 },
      skipped: { total: 0, today: 0 },
    };
    for (const row of filteredRows) {
      counts[row.status].total += 1;
      if (isToday(row.updatedAt)) counts[row.status].today += 1;
    }
    return counts;
  }, [filteredRows]);

  // Unique job URLs that have at least one successful application (across all emails)
  const uniqueJobsApplied = useMemo(() => {
    const seen = new Set<string>();
    const seenToday = new Set<string>();
    for (const row of rows) {
      if (row.status !== "success") continue;
      const key = row.jobUrl.trim().toLowerCase();
      if (key) seen.add(key);
      if (key && isToday(row.appliedAt ?? row.updatedAt)) seenToday.add(key);
    }
    return { total: seen.size, today: seenToday.size };
  }, [rows]);

  const tableMinWidth = useMemo(
    () => Object.values(columnWidths).reduce((total, width) => total + width, 0),
    [columnWidths]
  );

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const activeResize = resizeStateRef.current;
      if (!activeResize) return;

      const delta = event.clientX - activeResize.startX;
      const nextWidth = Math.max(MIN_COLUMN_WIDTHS[activeResize.key], activeResize.startWidth + delta);

      setColumnWidths((prev) => ({
        ...prev,
        [activeResize.key]: nextWidth,
      }));
    }

    function stopResize() {
      if (!resizeStateRef.current) return;
      resizeStateRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
    };
  }, []);

  const loadRows = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    else setRefreshing(true);
    try {
      const res = await fetch("/api/auto-apply-tracker", { cache: "no-store" });
      const data = await res.json() as {
        success: boolean;
        rows?: TrackRow[];
      };
      if (res.ok && data.success) {
        setRows(data.rows || []);
      }
    } finally {
      if (showSpinner) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadRows(true);
  }, [loadRows]);

  async function handleApplyNow() {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;

    setApplying(true);
    setApplyError("");
    try {
      const res = await fetch("/api/auto-apply-tracker/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: trimmedUrl,
        }),
      });
      const data = await res.json() as { success: boolean; error?: string };
      if (!res.ok || !data.success) {
        throw new Error(data.error || "apply_failed");
      }
      setUrl("");
      await loadRows(false);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : String(error));
      await loadRows(false);
    } finally {
      setApplying(false);
    }
  }

  async function handleRetry(id: string) {
    setActionBusyId(id);
    try {
      await fetch(`/api/auto-apply-tracker/${id}/retry`, { method: "POST" });
      await loadRows(false);
    } finally {
      setActionBusyId(null);
    }
  }

  async function handleStatusUpdate(id: string, status: Extract<TrackStatus, "applied" | "skipped">) {
    setActionBusyId(id);
    try {
      await fetch(`/api/auto-apply-tracker/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          lastError: status === "applied" ? "marked_applied_from_dashboard" : "marked_skipped_from_dashboard",
        }),
      });
      await loadRows(false);
    } finally {
      setActionBusyId(null);
    }
  }

  async function handleDelete(id: string) {
    setActionBusyId(id);
    try {
      await fetch(`/api/auto-apply-tracker/${id}`, { method: "DELETE" });
      setRows((prev) => prev.filter((row) => row._id !== id));
    } finally {
      setActionBusyId(null);
    }
  }

  function startColumnResize(key: ColumnKey, event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    resizeStateRef.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key],
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  return (
    <main className="h-screen overflow-y-auto bg-neutral-50 dark:bg-neutral-950">
      <div className="w-full px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Auto Apply Dashboard</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
              Track all automated apply attempts with status, email used, and resume preview link.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void loadRows(false)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-sm hover:bg-white dark:hover:bg-neutral-900 transition-colors"
            >
              {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </button>
            <Link
              href="/job-fetch"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 text-sm font-medium hover:bg-indigo-100 dark:hover:bg-indigo-900/60 transition-colors"
            >
              Job-Fetch Analytics
            </Link>
            <Link
              href="/resume-dashboard"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-sm hover:bg-white dark:hover:bg-neutral-900 transition-colors"
            >
              Resume Dashboard
            </Link>
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

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
          <StatCard label="Successful" total={statusCounts.success.total} today={statusCounts.success.today} tone="green" />
          <StatCard label="Failed" total={statusCounts.failed.total} today={statusCounts.failed.today} tone="red" />
          <StatCard label="Running" total={statusCounts.running.total} today={statusCounts.running.today} tone="blue" />
          <StatCard label="Applied" total={statusCounts.applied.total} today={statusCounts.applied.today} tone="emerald" />
          <StatCard label="Skipped" total={statusCounts.skipped.total} today={statusCounts.skipped.today} tone="amber" />
          <StatCard label="Unique Applied" total={uniqueJobsApplied.total} today={uniqueJobsApplied.today} tone="purple" />
        </div>

        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4 space-y-3">
          <h2 className="font-semibold text-sm">Apply From URL</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Job URL (required)"
              className="md:col-span-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
            />
            <button
              onClick={() => void handleApplyNow()}
              disabled={applying || !url.trim()}
              className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {applying ? "Applying..." : "Apply"}
            </button>
          </div>
          {applyError && <p className="text-xs text-red-500">{applyError}</p>}
        </div>

        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 gap-3">
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
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
            >
              <option value="all">All categories</option>
              {categoryOptions.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
            <input
              value={emailFilter}
              onChange={(e) => setEmailFilter(e.target.value)}
              placeholder="Filter by email"
              className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "all" | TrackStatus)}
              className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
            >
              <option value="all">All statuses</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <select
              value={atsFilter}
              onChange={(e) => setAtsFilter(e.target.value)}
              className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
            >
              <option value="all">All ATS</option>
              {atsOptions.map((ats) => (
                <option key={ats} value={ats}>{ats.toUpperCase()}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 overflow-x-auto">
          <table className="w-full table-fixed text-sm" style={{ minWidth: `${tableMinWidth}px` }}>
            <colgroup>
              {COLUMN_CONFIG.map((column) => (
                <col key={column.key} style={{ width: `${columnWidths[column.key]}px` }} />
              ))}
            </colgroup>
            <thead>
              <tr className="bg-neutral-100 dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-800">
                {COLUMN_CONFIG.map((column) => (
                  <th key={column.key} className="relative text-left px-3 py-2 whitespace-nowrap">
                    {column.sortable ? (
                      <button
                        type="button"
                        onClick={() => handleSortClick(column.key as SortableKey)}
                        className="inline-flex items-center gap-1 pr-3 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
                      >
                        {column.label}
                        {sortKey === column.key ? (
                          sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
                        ) : (
                          <ChevronsUpDown className="w-3 h-3 opacity-30" />
                        )}
                      </button>
                    ) : (
                      <div className="pr-3">{column.label}</div>
                    )}
                    <button
                      type="button"
                      aria-label={`Resize ${column.label} column`}
                      onPointerDown={(event) => startColumnResize(column.key, event)}
                      className="absolute top-0 right-0 h-full w-3 cursor-col-resize touch-none"
                    >
                      <span className="absolute inset-y-1 right-1 w-px bg-neutral-300 dark:bg-neutral-600" />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-3 py-10 text-center text-neutral-500">
                    <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</span>
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-3 py-10 text-center text-neutral-500">No tracked auto-apply jobs found.</td>
                </tr>
              ) : (
                sortedRows.map((row, idx) => {
                  const busy = actionBusyId === row._id;
                  return (
                    <tr key={row._id} className="border-b border-neutral-100 dark:border-neutral-800">
                      <td className="px-3 py-2 text-neutral-500">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <a
                          href={row.jobUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {row.title || "(untitled job)"}
                        </a>
                      </td>
                      <td className="px-3 py-2">{row.company || "—"}</td>
                      <td className="px-3 py-2">
                        <CategoryBadge label={row.categoryLabel || "Others"} category={row.category} />
                      </td>
                      <td className="px-3 py-2 uppercase">{row.atsId || "—"}</td>
                      <td className="px-3 py-2 break-all">{row.appliedEmail || "—"}</td>
                      <td className="px-3 py-2">
                        {row.resumePreviewLink ? (
                          <a href={row.resumePreviewLink} target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
                            Preview
                          </a>
                        ) : "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-neutral-500 dark:text-neutral-400">
                        {formatAppliedDate(row.postedAt)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-neutral-500 dark:text-neutral-400">
                        {formatAppliedDate(row.appliedAt ?? row.lastTriedAt)}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={row.status} />
                        {row.status === "failed" && row.lastError ? (
                          <div className="text-xs text-red-500 mt-1 max-w-xs wrap-break-word">{row.lastError}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {row.status === "failed" ? (
                            <>
                              <button
                                onClick={() => void handleRetry(row._id)}
                                disabled={busy}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-xs hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-50"
                              >
                                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                                Retry
                              </button>
                              <button
                                onClick={() => void handleStatusUpdate(row._id, "applied")}
                                disabled={busy}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 text-xs hover:bg-emerald-200 dark:hover:bg-emerald-900/50 disabled:opacity-50"
                              >
                                Mark Applied
                              </button>
                              <button
                                onClick={() => void handleStatusUpdate(row._id, "skipped")}
                                disabled={busy}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 text-xs hover:bg-amber-200 dark:hover:bg-amber-900/50 disabled:opacity-50"
                              >
                                Skip
                              </button>
                            </>
                          ) : null}
                          <button
                            onClick={() => void handleDelete(row._id)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 text-xs hover:bg-red-200 dark:hover:bg-red-900/50 disabled:opacity-50"
                          >
                            <Trash2 className="w-3 h-3" /> Delete
                          </button>
                        </div>
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

function isToday(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function formatAppliedDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function StatusBadge({ status }: { status: TrackStatus }) {
  if (status === "success") {
    return <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Success</span>;
  }
  if (status === "failed") {
    return <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">Failed</span>;
  }
  if (status === "applied") {
    return <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300">Applied</span>;
  }
  if (status === "skipped") {
    return <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Skipped</span>;
  }
  return <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">Running</span>;
}

function CategoryBadge({ label, category }: { label: string; category?: string }) {
  const catLabel = label || "Others";
  const isOthers = !category || category === "others" || catLabel === "Others";

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium truncate max-w-full ${
        isOthers
          ? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
          : "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300 border border-indigo-200/50 dark:border-indigo-800/40"
      }`}
    >
      {catLabel}
    </span>
  );
}

function StatCard({
  label,
  total,
  today,
  tone,
  highlight = false,
}: {
  label: string;
  total: number;
  today: number;
  tone: "green" | "red" | "blue" | "emerald" | "amber" | "purple";
  highlight?: boolean;
}) {
  const color =
    tone === "green"
      ? "text-emerald-700 dark:text-emerald-300"
      : tone === "red"
      ? "text-red-700 dark:text-red-300"
      : tone === "emerald"
      ? "text-teal-700 dark:text-teal-300"
      : tone === "amber"
      ? "text-amber-700 dark:text-amber-300"
      : tone === "purple"
      ? "text-purple-700 dark:text-purple-300"
      : "text-blue-700 dark:text-blue-300";

  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        highlight
          ? "border-purple-300 dark:border-purple-800 bg-purple-50/40 dark:bg-purple-950/30"
          : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950"
      }`}
    >
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
      <p className={`text-xl font-semibold ${color}`}>
        {total}
        {today > 0 && (
          <span className="text-sm font-normal text-neutral-400 dark:text-neutral-500 ml-1">/ {today} today</span>
        )}
      </p>
    </div>
  );
}
