"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  FileText,
  ExternalLink,
  Search,
  RotateCcw,
  Trash2,
  Copy,
  Info,
  Layers,
  BarChart3,
  TrendingUp,
} from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

type FailedJob = {
  id: string;
  jobUrl: string;
  title: string;
  company: string;
  ats: string;
  email: string;
  errorReason: string;
  errorDetails: string;
  failedAt: string;
  source: string;
};

type AnalyticsStats = {
  totalProcessed: number;
  savedInDriveCount: number;
  failedCount: number;
  successRate: number;
  reasonBreakdown: Record<string, number>;
  atsBreakdown: Record<string, number>;
};

export default function ResumeAnalyticsPage() {
  const [stats, setStats] = useState<AnalyticsStats | null>(null);
  const [failedJobs, setFailedJobs] = useState<FailedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filters & Search
  const [search, setSearch] = useState("");
  const [atsFilter, setAtsFilter] = useState("all");
  const [reasonFilter, setReasonFilter] = useState("all");

  // Pagination & Modals
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);
  const [activeErrorModal, setActiveErrorModal] = useState<FailedJob | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const fetchAnalytics = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    else setRefreshing(true);

    try {
      const res = await fetch("/api/resume-analytics", { cache: "no-store" });
      const data = await res.json();
      if (res.ok && data.success) {
        setStats(data.stats);
        setFailedJobs(data.failedJobs || []);
      }
    } catch (err) {
      console.error("Failed to fetch analytics:", err);
    } finally {
      if (showSpinner) setLoading(false);
      else setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchAnalytics(true);

    // Live auto-polling every 10 seconds
    const interval = setInterval(() => {
      fetchAnalytics(false);
    }, 10000);

    const onFocus = () => fetchAnalytics(false);
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchAnalytics]);

  // Unique options for filter dropdowns
  const atsOptions = useMemo(() => {
    if (!stats?.atsBreakdown) return [];
    return Object.keys(stats.atsBreakdown).sort();
  }, [stats]);

  const reasonOptions = useMemo(() => {
    if (!stats?.reasonBreakdown) return [];
    return Object.keys(stats.reasonBreakdown).sort();
  }, [stats]);

  // Filtered Jobs
  const filteredJobs = useMemo(() => {
    return failedJobs.filter((job) => {
      const matchesSearch =
        !search.trim() ||
        job.title.toLowerCase().includes(search.toLowerCase()) ||
        job.company.toLowerCase().includes(search.toLowerCase()) ||
        job.jobUrl.toLowerCase().includes(search.toLowerCase());

      const matchesAts = atsFilter === "all" || job.ats.toLowerCase() === atsFilter.toLowerCase();
      const matchesReason = reasonFilter === "all" || job.errorReason === reasonFilter;

      return matchesSearch && matchesAts && matchesReason;
    });
  }, [failedJobs, search, atsFilter, reasonFilter]);

  // Pagination
  const totalPages = Math.ceil(filteredJobs.length / itemsPerPage) || 1;
  const paginatedJobs = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredJobs.slice(start, start + itemsPerPage);
  }, [filteredJobs, currentPage, itemsPerPage]);

  const handleRetry = async (job: FailedJob) => {
    setActionInProgress(job.id);
    try {
      const res = await fetch("/api/resume-analytics/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobUrl: job.jobUrl, id: job.id }),
      });
      if (res.ok) {
        setFailedJobs((prev) => prev.filter((j) => j.id !== job.id));
        fetchAnalytics(false);
      }
    } finally {
      setActionInProgress(null);
    }
  };

  const handleDismiss = async (job: FailedJob) => {
    setActionInProgress(job.id);
    try {
      const res = await fetch("/api/resume-analytics/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: job.id, jobUrl: job.jobUrl }),
      });
      if (res.ok) {
        setFailedJobs((prev) => prev.filter((j) => j.id !== job.id));
        fetchAnalytics(false);
      }
    } finally {
      setActionInProgress(null);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedUrl(text);
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  return (
    <div className="h-screen flex flex-col overflow-y-auto bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      {/* Top Navbar */}
      <header className="sticky top-0 z-40 backdrop-blur-xl bg-white/80 dark:bg-neutral-900/80 border-b border-neutral-200 dark:border-neutral-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="p-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              title="Back to Home"
            >
              <ArrowLeft className="w-4 h-4 text-neutral-600 dark:text-neutral-400" />
            </Link>
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-amber-500 to-red-600 flex items-center justify-center shadow-xs">
              <BarChart3 className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight leading-none">Resume Analytics</h1>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold uppercase tracking-wider border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
                </span>
              </div>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">
                Resume Generation & Drive Upload Failure Insights
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/auto-apply-dashboard"
              className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              Auto Apply Dashboard
            </Link>
            <Link
              href="/resume-dashboard"
              className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              Resume Dashboard
            </Link>
            <button
              onClick={() => fetchAnalytics(false)}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin text-amber-500" : ""}`} />
              Refresh
            </button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 flex-1 space-y-6">
        {loading ? (
          <div className="py-24 flex flex-col items-center justify-center gap-3">
            <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
            <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">Loading Resume Analytics...</p>
          </div>
        ) : (
          <>
            {/* Top Cards Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Total Processed Card */}
              <div className="p-4 rounded-2xl border border-neutral-200/80 dark:border-neutral-800/80 bg-white dark:bg-neutral-900/60 shadow-xs backdrop-blur-sm relative overflow-hidden group">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    Total Processed
                  </span>
                  <div className="w-8 h-8 rounded-lg bg-blue-500/10 dark:bg-blue-400/10 flex items-center justify-center">
                    <FileText className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  </div>
                </div>
                <div className="mt-3 flex items-baseline justify-between">
                  <span className="text-2xl font-extrabold tracking-tight">
                    {stats?.totalProcessed.toLocaleString() || 0}
                  </span>
                  <span className="text-xs text-neutral-400 dark:text-neutral-500">jobs attempted</span>
                </div>
                <div className="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
                  Total resume generation requests processed
                </div>
              </div>

              {/* Saved in Drive Card */}
              <div className="p-4 rounded-2xl border border-emerald-200/80 dark:border-emerald-900/30 bg-emerald-50/40 dark:bg-emerald-950/20 shadow-xs backdrop-blur-sm relative overflow-hidden group">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                    Saved in Google Drive
                  </span>
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/10 dark:bg-emerald-400/10 flex items-center justify-center">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  </div>
                </div>
                <div className="mt-3 flex items-baseline justify-between">
                  <span className="text-2xl font-extrabold text-emerald-700 dark:text-emerald-400 tracking-tight">
                    {stats?.savedInDriveCount.toLocaleString() || 0}
                  </span>
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {stats?.successRate}% success
                  </span>
                </div>
                <div className="mt-2 text-[11px] text-emerald-600/80 dark:text-emerald-400/70">
                  Resumes compiled & uploaded to Drive
                </div>
              </div>

              {/* Failed Resumes Card */}
              <div className="p-4 rounded-2xl border border-rose-200/80 dark:border-rose-900/30 bg-rose-50/40 dark:bg-rose-950/20 shadow-xs backdrop-blur-sm relative overflow-hidden group">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-400">
                    Failed Resumes
                  </span>
                  <div className="w-8 h-8 rounded-lg bg-rose-500/10 dark:bg-rose-400/10 flex items-center justify-center">
                    <XCircle className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                  </div>
                </div>
                <div className="mt-3 flex items-baseline justify-between">
                  <span className="text-2xl font-extrabold text-rose-700 dark:text-rose-400 tracking-tight">
                    {stats?.failedCount.toLocaleString() || 0}
                  </span>
                  <span className="text-xs font-medium text-rose-600 dark:text-rose-400">
                    {stats?.totalProcessed ? ((stats.failedCount / stats.totalProcessed) * 100).toFixed(1) : 0}%
                  </span>
                </div>
                <div className="mt-2 text-[11px] text-rose-600/80 dark:text-rose-400/70">
                  Compile/Drive upload failures or dead links
                </div>
              </div>

              {/* Efficiency & Success Rate Card */}
              <div className="p-4 rounded-2xl border border-neutral-200/80 dark:border-neutral-800/80 bg-white dark:bg-neutral-900/60 shadow-xs backdrop-blur-sm relative overflow-hidden group">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    Drive Saved Rate
                  </span>
                  <div className="w-8 h-8 rounded-lg bg-amber-500/10 dark:bg-amber-400/10 flex items-center justify-center">
                    <TrendingUp className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  </div>
                </div>
                <div className="mt-3 flex items-baseline justify-between">
                  <span className="text-2xl font-extrabold tracking-tight">{stats?.successRate || 0}%</span>
                  <span className="text-xs text-neutral-400">Target: 95%+</span>
                </div>
                <div className="mt-3 w-full bg-neutral-200 dark:bg-neutral-800 h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-gradient-to-r from-emerald-500 to-teal-400 h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(100, Math.max(0, stats?.successRate || 0))}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Failure Distribution & ATS Breakdown Bar */}
            {stats && stats.failedCount > 0 && (
              <div className="p-5 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/50 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    <h2 className="text-sm font-bold tracking-tight">Failure Reason Breakdown</h2>
                  </div>
                  <span className="text-xs text-neutral-500">{stats.failedCount} jobs with resume issues</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Reasons pills */}
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Top Causes</span>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(stats.reasonBreakdown).map(([reason, count]) => (
                        <button
                          key={reason}
                          onClick={() => setReasonFilter(reasonFilter === reason ? "all" : reason)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                            reasonFilter === reason
                              ? "bg-rose-600 text-white shadow-xs"
                              : "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                          }`}
                        >
                          <span>{reason}</span>
                          <span className="px-1.5 py-0.5 rounded-md bg-black/10 dark:bg-white/10 text-[10px] font-bold">
                            {count}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* ATS Breakdown pills */}
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Affected ATS</span>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(stats.atsBreakdown).map(([ats, count]) => (
                        <button
                          key={ats}
                          onClick={() => setAtsFilter(atsFilter === ats ? "all" : ats)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 uppercase ${
                            atsFilter === ats
                              ? "bg-blue-600 text-white shadow-xs"
                              : "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                          }`}
                        >
                          <span>{ats}</span>
                          <span className="px-1.5 py-0.5 rounded-md bg-black/10 dark:bg-white/10 text-[10px] font-bold">
                            {count}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Filter & Search Bar */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/60 shadow-xs">
              <div className="relative w-full sm:w-80">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  type="text"
                  placeholder="Search by job title or company..."
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-xs focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                />
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto overflow-x-auto">
                <select
                  value={atsFilter}
                  onChange={(e) => {
                    setAtsFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="px-2.5 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-xs font-medium focus:outline-hidden"
                >
                  <option value="all">All ATS Platforms</option>
                  {atsOptions.map((ats) => (
                    <option key={ats} value={ats}>
                      {ats.toUpperCase()}
                    </option>
                  ))}
                </select>

                <select
                  value={reasonFilter}
                  onChange={(e) => {
                    setReasonFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="px-2.5 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-xs font-medium focus:outline-hidden max-w-[200px] truncate"
                >
                  <option value="all">All Failure Reasons</option>
                  {reasonOptions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>

                {(search || atsFilter !== "all" || reasonFilter !== "all") && (
                  <button
                    onClick={() => {
                      setSearch("");
                      setAtsFilter("all");
                      setReasonFilter("all");
                      setCurrentPage(1);
                    }}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 transition-colors"
                  >
                    Clear Filters
                  </button>
                )}
              </div>
            </div>

            {/* Failed Jobs Table */}
            <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/60 shadow-xs overflow-hidden">
              <div className="px-5 py-4 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold tracking-tight">Failed Resume Jobs ({filteredJobs.length})</h2>
                  <p className="text-xs text-neutral-500">
                    Jobs where resume generation, LaTeX compilation, or Drive upload failed
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs text-neutral-500">
                  <span>Show:</span>
                  <select
                    value={itemsPerPage}
                    onChange={(e) => {
                      setItemsPerPage(Number(e.target.value));
                      setCurrentPage(1);
                    }}
                    className="px-2 py-1 rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-xs font-medium"
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </div>
              </div>

              {paginatedJobs.length === 0 ? (
                <div className="py-16 text-center space-y-2">
                  <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto opacity-80" />
                  <p className="text-sm font-semibold">No Failed Resume Jobs Found</p>
                  <p className="text-xs text-neutral-500">
                    {search || atsFilter !== "all" || reasonFilter !== "all"
                      ? "Try adjusting your search filters above."
                      : "All resume generation attempts have completed successfully."}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-950/50 text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">
                        <th className="py-3 px-4 w-12 text-center">#</th>
                        <th className="py-3 px-4">Job Title & Company</th>
                        <th className="py-3 px-4 w-28">ATS</th>
                        <th className="py-3 px-4">Failure Reason</th>
                        <th className="py-3 px-4 w-36">Failed At</th>
                        <th className="py-3 px-4 w-36 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800 text-xs">
                      {paginatedJobs.map((job, idx) => {
                        const globalIndex = (currentPage - 1) * itemsPerPage + idx + 1;
                        const isProcessing = actionInProgress === job.id;

                        return (
                          <tr
                            key={job.id}
                            className="hover:bg-neutral-50/80 dark:hover:bg-neutral-800/40 transition-colors group"
                          >
                            <td className="py-3 px-4 text-center font-mono text-neutral-400 text-[11px]">
                              {globalIndex}
                            </td>
                            <td className="py-3 px-4">
                              <div className="flex flex-col gap-0.5">
                                <a
                                  href={job.jobUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-bold text-neutral-900 dark:text-neutral-100 hover:text-amber-600 dark:hover:text-amber-400 flex items-center gap-1.5 max-w-md truncate group-hover:underline"
                                >
                                  <span className="truncate">{job.title}</span>
                                  <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
                                </a>
                                <span className="text-[11px] text-neutral-500 font-medium">{job.company}</span>
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <span className="px-2 py-0.5 rounded-md bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-[10px] font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
                                {job.ats || "unknown"}
                              </span>
                            </td>
                            <td className="py-3 px-4">
                              <button
                                onClick={() => setActiveErrorModal(job)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-700 dark:text-rose-400 hover:bg-rose-500/20 transition-colors text-[11px] font-medium text-left max-w-sm truncate"
                                title="Click to view full error log"
                              >
                                <AlertTriangle className="w-3 h-3 shrink-0" />
                                <span className="truncate">{job.errorReason}</span>
                                <Info className="w-3 h-3 shrink-0 opacity-60 ml-auto" />
                              </button>
                            </td>
                            <td className="py-3 px-4 text-neutral-500 text-[11px]">
                              {job.failedAt ? new Date(job.failedAt).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              }) : "Recently"}
                            </td>
                            <td className="py-3 px-4 text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  onClick={() => copyToClipboard(job.jobUrl)}
                                  className="p-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-600 dark:text-neutral-400 transition-colors"
                                  title="Copy Job URL"
                                >
                                  <Copy className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleRetry(job)}
                                  disabled={isProcessing}
                                  className="px-2.5 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/20 text-xs font-semibold flex items-center gap-1 transition-colors disabled:opacity-50"
                                  title="Reset job to retry resume generation"
                                >
                                  {isProcessing ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <RotateCcw className="w-3 h-3" />
                                  )}
                                  Retry
                                </button>
                                <button
                                  onClick={() => handleDismiss(job)}
                                  disabled={isProcessing}
                                  className="p-1.5 rounded-lg text-neutral-400 hover:text-rose-600 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition-colors"
                                  title="Dismiss / Remove from list"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Table Footer / Pagination */}
              {filteredJobs.length > 0 && (
                <div className="px-5 py-3 border-t border-neutral-200 dark:border-neutral-800 flex items-center justify-between text-xs text-neutral-500">
                  <span>
                    Showing {Math.min((currentPage - 1) * itemsPerPage + 1, filteredJobs.length)} to{" "}
                    {Math.min(currentPage * itemsPerPage, filteredJobs.length)} of {filteredJobs.length} failed jobs
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="px-2.5 py-1 rounded-md border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 transition-colors"
                    >
                      Previous
                    </button>
                    <span className="px-2 font-semibold text-neutral-700 dark:text-neutral-300">
                      {currentPage} / {totalPages}
                    </span>
                    <button
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                      className="px-2.5 py-1 rounded-md border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 transition-colors"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </main>

      {/* Error Details Modal */}
      {activeErrorModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-4 relative animate-in fade-in zoom-in-95">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-rose-500/10 flex items-center justify-center">
                  <AlertTriangle className="w-4 h-4 text-rose-500" />
                </div>
                <div>
                  <h3 className="text-base font-bold tracking-tight">Resume Failure Details</h3>
                  <p className="text-xs text-neutral-500">{activeErrorModal.company} — {activeErrorModal.title}</p>
                </div>
              </div>
              <button
                onClick={() => setActiveErrorModal(null)}
                className="p-1.5 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-neutral-500">
                <span className="font-semibold uppercase tracking-wider text-[10px]">Error Traceback / Reason</span>
                <span>{activeErrorModal.ats.toUpperCase()}</span>
              </div>
              <pre className="p-4 rounded-xl bg-neutral-950 text-rose-400 font-mono text-xs overflow-x-auto max-h-80 whitespace-pre-wrap border border-neutral-800 leading-relaxed">
                {activeErrorModal.errorDetails || activeErrorModal.errorReason}
              </pre>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-neutral-200 dark:border-neutral-800">
              <a
                href={activeErrorModal.jobUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
              >
                Open Job URL <ExternalLink className="w-3 h-3" />
              </a>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => copyToClipboard(activeErrorModal.errorDetails || activeErrorModal.errorReason)}
                  className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 text-xs font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors flex items-center gap-1.5"
                >
                  <Copy className="w-3.5 h-3.5" />
                  {copiedUrl ? "Copied!" : "Copy Error"}
                </button>
                <button
                  onClick={() => setActiveErrorModal(null)}
                  className="px-4 py-1.5 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-xs font-bold hover:opacity-90 transition-opacity"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
