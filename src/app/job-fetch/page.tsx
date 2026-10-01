"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BarChart3,
  Calendar,
  Filter,
  Layers,
  Loader2,
  RefreshCw,
  TrendingUp,
  Building2,
  PieChart,
  CheckCircle2,
  Search,
} from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

interface DailyDataItem {
  date: string;
  total: number;
  greenhouse: number;
  workday: number;
  other: number;
  byCategory: Record<string, number>;
}

interface CategoryBreakdownItem {
  category: string;
  categoryLabel: string;
  categoryPriority: number;
  count: number;
  greenhouseCount: number;
  workdayCount: number;
  otherCount: number;
  percentage: number;
}

interface SummaryData {
  totalJobs: number;
  greenhouseJobs: number;
  workdayJobs: number;
  otherJobs: number;
  greenhousePercent: number;
  workdayPercent: number;
  otherPercent: number;
  totalDays: number;
  avgJobsPerDay: number;
}

interface CategoryMeta {
  id: string;
  label: string;
  priority: number;
}

export default function JobFetchAnalyticsPage() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [days, setDays] = useState<string>("30");
  const [atsFilter, setAtsFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [categorySearch, setCategorySearch] = useState<string>("");
  const [activeHoverDate, setActiveHoverDate] = useState<DailyDataItem | null>(null);

  const [summary, setSummary] = useState<SummaryData>({
    totalJobs: 0,
    greenhouseJobs: 0,
    workdayJobs: 0,
    otherJobs: 0,
    greenhousePercent: 0,
    workdayPercent: 0,
    otherPercent: 0,
    totalDays: 0,
    avgJobsPerDay: 0,
  });

  const [dailyData, setDailyData] = useState<DailyDataItem[]>([]);
  const [categoryBreakdown, setCategoryBreakdown] = useState<CategoryBreakdownItem[]>([]);
  const [categoriesList, setCategoriesList] = useState<CategoryMeta[]>([]);

  const fetchData = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    else setRefreshing(true);

    try {
      const params = new URLSearchParams({
        days,
        ats: atsFilter,
        category: categoryFilter,
      });

      const res = await fetch(`/api/analytics/job-fetch?${params.toString()}`, {
        cache: "no-store",
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setSummary(data.summary);
        setDailyData(data.dailyData || []);
        setCategoryBreakdown(data.categoryBreakdown || []);
        if (data.categoriesList) {
          setCategoriesList(data.categoriesList);
        }
      }
    } catch (err) {
      console.error("Failed to fetch job-fetch analytics:", err);
    } finally {
      if (showSpinner) setLoading(false);
      else setRefreshing(false);
    }
  }, [days, atsFilter, categoryFilter]);

  useEffect(() => {
    void fetchData(true);
  }, [fetchData]);

  // Maximum value for bar scaling
  const maxDailyCount = useMemo(() => {
    if (dailyData.length === 0) return 1;
    return Math.max(...dailyData.map((d) => d.total), 1);
  }, [dailyData]);

  const filteredCategories = useMemo(() => {
    const q = categorySearch.trim().toLowerCase();
    if (!q) return categoryBreakdown;
    return categoryBreakdown.filter((cat) =>
      cat.categoryLabel.toLowerCase().includes(q)
    );
  }, [categoryBreakdown, categorySearch]);

  const topCategory = useMemo(() => {
    if (categoryBreakdown.length === 0) return null;
    return categoryBreakdown.reduce((prev, current) =>
      prev.count > current.count ? prev : current
    );
  }, [categoryBreakdown]);

  return (
    <main className="min-h-screen flex flex-col bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      {/* Header */}
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-white/80 dark:bg-neutral-950/80 border-b border-neutral-200 dark:border-neutral-800">
        <div className="w-full px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-xs">
              <BarChart3 className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">Job-Fetch Analytics</h1>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400 -mt-0.5">
                Daily job postings, ATS distribution & category trends
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void fetchData(false)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Refresh
            </button>

            <Link
              href="/auto-apply-dashboard"
              className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              Auto Apply Dashboard
            </Link>

            <Link
              href="/resume-dashboard"
              className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              Resume Dashboard
            </Link>

            <Link
              href="/resume-analytics"
              className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              Resume Analytics
            </Link>

            <Link
              href="/"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </Link>

            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="w-full px-4 sm:px-6 py-6 space-y-6 flex-1 max-w-7xl mx-auto">
        {/* Filter Controls Bar */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 space-y-4 shadow-2xs">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Filter className="w-4 h-4 text-indigo-500" />
              <span>Filters & Timeframes</span>
            </div>

            {/* Range Presets */}
            <div className="flex items-center gap-1.5 bg-neutral-100 dark:bg-neutral-800/80 p-1 rounded-lg">
              {[
                { label: "Last 7 Days", value: "7" },
                { label: "Last 14 Days", value: "14" },
                { label: "Last 30 Days", value: "30" },
                { label: "Last 90 Days", value: "90" },
                { label: "All Time", value: "0" },
              ].map((item) => (
                <button
                  key={item.value}
                  onClick={() => setDays(item.value)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                    days === item.value
                      ? "bg-white dark:bg-neutral-900 text-indigo-600 dark:text-indigo-400 shadow-xs"
                      : "text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 pt-2 border-t border-neutral-100 dark:border-neutral-800">
            {/* ATS Selection */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400 flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-emerald-500" /> ATS Platform
              </label>
              <select
                value={atsFilter}
                onChange={(e) => setAtsFilter(e.target.value)}
                className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-xs font-medium focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">All ATS Platforms</option>
                <option value="greenhouse">Greenhouse Only</option>
                <option value="workday">Workday Only</option>
                <option value="other">Other ATS Only</option>
              </select>
            </div>

            {/* Category Filter */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-neutral-500 dark:text-neutral-400 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-purple-500" /> Job Category
              </label>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="w-full rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-xs font-medium focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">All Job Categories</option>
                {categoriesList.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.priority}. {cat.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Filter Summary */}
            <div className="flex items-end">
              <button
                onClick={() => {
                  setDays("30");
                  setAtsFilter("all");
                  setCategoryFilter("all");
                  setCategorySearch("");
                }}
                className="w-full px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-xs text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              >
                Reset All Filters
              </button>
            </div>
          </div>
        </div>

        {/* Key Metrics Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {/* Total Jobs */}
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 space-y-1">
            <p className="text-xs text-neutral-500 dark:text-neutral-400 font-medium">Total Jobs Posted</p>
            <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
              {summary.totalJobs.toLocaleString()}
            </p>
            <p className="text-[11px] text-neutral-500 flex items-center gap-1">
              <TrendingUp className="w-3 h-3 text-indigo-500" />
              ~{summary.avgJobsPerDay} / day ({summary.totalDays} days)
            </p>
          </div>

          {/* Greenhouse */}
          <div className="rounded-xl border border-emerald-200/70 dark:border-emerald-900/50 bg-emerald-50/30 dark:bg-emerald-950/20 p-4 space-y-1">
            <p className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">Greenhouse ATS</p>
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">
              {summary.greenhouseJobs.toLocaleString()}
            </p>
            <p className="text-[11px] text-emerald-600/80 dark:text-emerald-400/80 font-medium">
              {summary.greenhousePercent}% of total postings
            </p>
          </div>

          {/* Workday */}
          <div className="rounded-xl border border-blue-200/70 dark:border-blue-900/50 bg-blue-50/30 dark:bg-blue-950/20 p-4 space-y-1">
            <p className="text-xs text-blue-700 dark:text-blue-300 font-medium">Workday ATS</p>
            <p className="text-2xl font-bold text-blue-700 dark:text-blue-300">
              {summary.workdayJobs.toLocaleString()}
            </p>
            <p className="text-[11px] text-blue-600/80 dark:text-blue-400/80 font-medium">
              {summary.workdayPercent}% of total postings
            </p>
          </div>

          {/* Other ATS */}
          <div className="rounded-xl border border-purple-200/70 dark:border-purple-900/50 bg-purple-50/30 dark:bg-purple-950/20 p-4 space-y-1">
            <p className="text-xs text-purple-700 dark:text-purple-300 font-medium">Other ATS</p>
            <p className="text-2xl font-bold text-purple-700 dark:text-purple-300">
              {summary.otherJobs.toLocaleString()}
            </p>
            <p className="text-[11px] text-purple-600/80 dark:text-purple-400/80 font-medium">
              {summary.otherPercent}% of total postings
            </p>
          </div>

          {/* Top Category */}
          <div className="col-span-2 sm:col-span-1 rounded-xl border border-indigo-200/70 dark:border-indigo-900/50 bg-indigo-50/30 dark:bg-indigo-950/20 p-4 space-y-1">
            <p className="text-xs text-indigo-700 dark:text-indigo-300 font-medium">Top Category</p>
            <p className="text-sm font-bold text-indigo-950 dark:text-indigo-200 truncate" title={topCategory?.categoryLabel || "N/A"}>
              {topCategory?.categoryLabel || "None"}
            </p>
            <p className="text-[11px] text-indigo-600/80 dark:text-indigo-400/80 font-medium">
              {topCategory ? `${topCategory.count} jobs (${topCategory.percentage}%)` : "No jobs"}
            </p>
          </div>
        </div>

        {/* Daily Jobs Posted Graph Section */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-4 shadow-2xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold tracking-tight">Daily Job Postings Graph</h2>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Daily volume of scraped jobs broken down by Greenhouse, Workday, and Other ATS
              </p>
            </div>

            {/* Legend */}
            <div className="flex items-center gap-4 text-xs font-medium">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-xs bg-emerald-500"></span> Greenhouse
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-xs bg-blue-500"></span> Workday
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-xs bg-purple-500"></span> Other ATS
              </span>
            </div>
          </div>

          {loading ? (
            <div className="h-64 flex flex-col items-center justify-center text-neutral-400 space-y-2">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
              <p className="text-xs">Loading analytics data...</p>
            </div>
          ) : dailyData.length === 0 ? (
            <div className="h-64 flex flex-col items-center justify-center text-neutral-400 space-y-2">
              <Calendar className="w-8 h-8 opacity-40" />
              <p className="text-xs">No job posting data available for selected filters</p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Active Hover Detail Popup / Banner */}
              <div className="h-10 px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800/60 flex items-center justify-between text-xs transition-all">
                {activeHoverDate ? (
                  <>
                    <span className="font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
                      <Calendar className="w-3.5 h-3.5 text-indigo-500" />
                      {activeHoverDate.date}
                    </span>
                    <div className="flex items-center gap-4">
                      <span>Total: <strong className="text-neutral-900 dark:text-neutral-100">{activeHoverDate.total}</strong></span>
                      <span className="text-emerald-600 dark:text-emerald-400">Greenhouse: <strong>{activeHoverDate.greenhouse}</strong></span>
                      <span className="text-blue-600 dark:text-blue-400">Workday: <strong>{activeHoverDate.workday}</strong></span>
                      <span className="text-purple-600 dark:text-purple-400">Other: <strong>{activeHoverDate.other}</strong></span>
                    </div>
                  </>
                ) : (
                  <span className="text-neutral-400 italic">Hover over any bar in the graph to inspect daily details</span>
                )}
              </div>

              {/* Stacked Interactive Bar Chart */}
              <div className="h-64 pt-6 pb-2 flex items-end gap-1.5 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800">
                {dailyData.map((item) => {
                  const ghPct = (item.greenhouse / maxDailyCount) * 100;
                  const wdPct = (item.workday / maxDailyCount) * 100;
                  const otPct = (item.other / maxDailyCount) * 100;
                  const totalPct = (item.total / maxDailyCount) * 100;

                  return (
                    <div
                      key={item.date}
                      onMouseEnter={() => setActiveHoverDate(item)}
                      onMouseLeave={() => setActiveHoverDate(null)}
                      className="group flex-1 min-w-[14px] max-w-[42px] h-full flex flex-col justify-end items-center cursor-pointer relative"
                    >
                      {/* Count badge on hover */}
                      <span className="opacity-0 group-hover:opacity-100 transition-opacity absolute -top-6 text-[10px] font-bold px-1.5 py-0.5 rounded bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 shadow-xs pointer-events-none z-10 whitespace-nowrap">
                        {item.total}
                      </span>

                      {/* Stacked bar */}
                      <div
                        className="w-full rounded-t-xs flex flex-col justify-end overflow-hidden group-hover:ring-2 group-hover:ring-indigo-500 transition-all"
                        style={{ height: `${Math.max(totalPct, 3)}%` }}
                      >
                        {item.other > 0 && (
                          <div
                            className="w-full bg-purple-500 transition-all"
                            style={{ height: `${(item.other / item.total) * 100}%` }}
                          />
                        )}
                        {item.workday > 0 && (
                          <div
                            className="w-full bg-blue-500 transition-all"
                            style={{ height: `${(item.workday / item.total) * 100}%` }}
                          />
                        )}
                        {item.greenhouse > 0 && (
                          <div
                            className="w-full bg-emerald-500 transition-all"
                            style={{ height: `${(item.greenhouse / item.total) * 100}%` }}
                          />
                        )}
                      </div>

                      {/* Date label */}
                      <span className="text-[9px] text-neutral-400 truncate w-full text-center mt-1">
                        {item.date.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Category Breakdown Table / Grid */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 space-y-4 shadow-2xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold tracking-tight">Category Distribution</h2>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Jobs classified by role categories (ordered by category priority)
              </p>
            </div>

            {/* Category Search Input */}
            <div className="relative w-full sm:w-64">
              <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-neutral-400" />
              <input
                type="text"
                value={categorySearch}
                onChange={(e) => setCategorySearch(e.target.value)}
                placeholder="Search categories..."
                className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {filteredCategories.length === 0 ? (
            <div className="py-8 text-center text-xs text-neutral-400">
              No matching categories found
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredCategories.map((cat) => (
                <div
                  key={cat.category}
                  className="rounded-lg border border-neutral-200/80 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-950/50 p-3.5 space-y-2.5 hover:border-indigo-300 dark:hover:border-indigo-800 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="shrink-0 w-6 h-6 rounded-md bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 text-xs font-bold flex items-center justify-center">
                        #{cat.categoryPriority}
                      </span>
                      <span className="font-semibold text-xs truncate" title={cat.categoryLabel}>
                        {cat.categoryLabel}
                      </span>
                    </div>

                    <div className="text-right shrink-0">
                      <span className="font-bold text-xs">{cat.count} jobs</span>
                      <span className="text-[10px] text-neutral-400 ml-1.5">({cat.percentage}%)</span>
                    </div>
                  </div>

                  {/* Percentage Progress Bar */}
                  <div className="w-full h-2 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden flex">
                    <div
                      className="h-full bg-emerald-500"
                      style={{
                        width: `${cat.count > 0 ? (cat.greenhouseCount / cat.count) * 100 : 0}%`,
                      }}
                      title={`Greenhouse: ${cat.greenhouseCount}`}
                    />
                    <div
                      className="h-full bg-blue-500"
                      style={{
                        width: `${cat.count > 0 ? (cat.workdayCount / cat.count) * 100 : 0}%`,
                      }}
                      title={`Workday: ${cat.workdayCount}`}
                    />
                    <div
                      className="h-full bg-purple-500"
                      style={{
                        width: `${cat.count > 0 ? (cat.otherCount / cat.count) * 100 : 0}%`,
                      }}
                      title={`Other ATS: ${cat.otherCount}`}
                    />
                  </div>

                  {/* ATS breakdown pills */}
                  <div className="flex items-center gap-3 text-[10px] text-neutral-500 dark:text-neutral-400">
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-xs bg-emerald-500"></span> Greenhouse: <strong>{cat.greenhouseCount}</strong>
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-xs bg-blue-500"></span> Workday: <strong>{cat.workdayCount}</strong>
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-xs bg-purple-500"></span> Other: <strong>{cat.otherCount}</strong>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
