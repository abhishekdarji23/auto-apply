"use client";

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  startTransition,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { List } from "react-window";
import {
  ChevronUp,
  ChevronDown,
  Filter,
  X,
  Plus,
  RefreshCw,
  ExternalLink,
  Check,
  Layers,
  ChevronsUpDown,
  Search,
  Ban,
  Bookmark,
  Save,
  Trash2,
  Pencil,
  FileText,
  Loader2,
  Zap,
  Info,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────
interface JobSourceInfo {
  key?: string;
  kind?: string;
  label?: string;
  repo?: string;
  url?: string;
  jobrightId?: string;
}

interface Job {
  _id: string;
  jobId: string;
  title: string;
  applyLink?: string;
  recruiterName?: string;
  recruiterProfileUrl?: string;
  detailsFetchedAt?: string | null;
  detailsFetchStatus?: string;
  company: string;
  location: string;
  salary: string;
  workModel: string;
  industry: string[];
  companySize: string;
  qualifications: string;
  expLevel: string;
  jobFunction: string;
  h1bSponsored: string;
  isNewGrad: boolean;
  roleType: string;
  hireTime: string;
  graduateTime: string;
  tabCategory: string[];
  postedAt: string;
  fetchedAt: string;
  applied: boolean;
  appliedAt: string | null;
  autoApplied?: boolean;
  autoAppliedAt?: string | null;
  manualApplied?: boolean;
  manualAppliedAt?: string | null;
  notInterested: boolean;
  top500: boolean;
  companyRank: number;
  matchScore?: number | null;
  jobrightId?: string;
  sourceTags?: string[];
  sourceDetails?: JobSourceInfo[];
  sourceKind?: string;
  sourceRepo?: string;
  sourceLabel?: string;
  isH1bSponsor?: boolean | null;
  isCitizenOnly?: boolean | null;
  minSalary?: number | null;
  maxSalary?: number | null;
  notEligible?: boolean;
  notEligibleReason?: string;
  eligibilityStatus?: string;
  inactive?: boolean;
  category?: string;
  categoryLabel?: string;
  categoryPriority?: number;
  categoryConfidence?: number;
}

type FilterMode = "include" | "exclude";
type MatchType = "contains" | "exact" | "regex";

interface ColumnFilter {
  id: string;
  column: string;
  mode: FilterMode;
  matchType: MatchType;
  value: string | string[];
}

type SortDirection = "asc" | "desc" | null;

interface SavedFilterPreset {
  id: string;
  name: string;
  filters: Omit<ColumnFilter, "id">[];
}

type ActiveFilterView = "active" | "not-eligible" | "inactive" | "all";

interface ResumeApiSuccess {
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
}

interface ResumeApiFailure {
  success?: false;
  error: string;
  details?: string;
  folderName?: string;
  folderPath?: string;
  files?: {
    jobUrl?: string;
    latex?: string;
  };
}

const PRESETS_STORAGE_KEY = "jobtrack-filter-presets";
const COLUMN_WIDTHS_STORAGE_KEY = "jobtrack-column-widths";
const ROW_NUMBER_COLUMN_KEY = "__rowNumber";
const ROW_NUMBER_DEFAULT_WIDTH = 60;
const ROW_NUMBER_MIN_WIDTH = 48;
const APPLIED_DAY_START_HOUR = 7;
const INITIAL_FETCH_LIMIT = 300;
const STREAM_BATCH_SIZE = 1500;

function loadPresetsFromStorage(): SavedFilterPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePresetsToStorage(presets: SavedFilterPreset[]) {
  localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
}

const COLUMNS: {
  key: keyof Job;
  label: string;
  defaultWidth: number;
  minWidth: number;
}[] = [
    { key: "title", label: "Title", defaultWidth: 300, minWidth: 180 },
    { key: "categoryLabel", label: "Category", defaultWidth: 170, minWidth: 110 },
    { key: "companyRank", label: "Rank", defaultWidth: 70, minWidth: 60 },
    { key: "company", label: "Company", defaultWidth: 180, minWidth: 120 },
    { key: "postedAt", label: "Posted", defaultWidth: 150, minWidth: 125 },
    { key: "applied", label: "Status", defaultWidth: 300, minWidth: 220 },
    { key: "sourceTags", label: "Source", defaultWidth: 120, minWidth: 95 },
  ];

const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
  [ROW_NUMBER_COLUMN_KEY]: ROW_NUMBER_DEFAULT_WIDTH,
  ...Object.fromEntries(COLUMNS.map((col) => [col.key, col.defaultWidth])),
};

const COLUMN_MIN_WIDTHS: Record<string, number> = {
  [ROW_NUMBER_COLUMN_KEY]: ROW_NUMBER_MIN_WIDTH,
  ...Object.fromEntries(COLUMNS.map((col) => [col.key, col.minWidth])),
};

const VIRTUAL_ROW_HEIGHT = 41;

function loadColumnWidthsFromStorage(): Record<string, number> {
  if (typeof window === "undefined") return DEFAULT_COLUMN_WIDTHS;
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY);
    if (!raw) return DEFAULT_COLUMN_WIDTHS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const merged: Record<string, number> = { ...DEFAULT_COLUMN_WIDTHS };
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        merged[key] = value;
      }
    }
    return merged;
  } catch {
    return DEFAULT_COLUMN_WIDTHS;
  }
}

function saveColumnWidthsToStorage(columnWidths: Record<string, number>) {
  localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(columnWidths));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function matchFilter(text: string, pattern: string, matchType: MatchType): boolean {
  const t = String(text);
  const p = pattern.trim();
  if (!p) return true;

  switch (matchType) {
    case "exact":
      return t.toLowerCase() === p.toLowerCase();
    case "regex":
      try {
        return new RegExp(p, "i").test(t);
      } catch {
        return false;
      }
    case "contains":
    default:
      return t.toLowerCase().includes(p.toLowerCase());
  }
}

function getAppliedDayWindow(now: Date) {
  const start = new Date(now);
  start.setHours(APPLIED_DAY_START_HOUR, 0, 0, 0);
  if (now.getTime() < start.getTime()) {
    start.setDate(start.getDate() - 1);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function formatPST(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isJobrightInfoUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.hostname.toLowerCase().includes("jobright.ai") &&
      parsed.pathname.startsWith("/jobs/info/")
    );
  } catch {
    return false;
  }
}

function sanitizeExternalUrl(value: string): string {
  const input = value.trim();
  if (!input) return "";
  try {
    const parsed = new URL(input);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return input;
  } catch {
    return "";
  }
}

function resolveJobTitleUrl(job: Job): string {
  const fallbackUrl = `https://jobright.ai/jobs/info/${job.jobId}`;
  const apply = sanitizeExternalUrl(String(job.applyLink || "").trim());
  if (isValidHttpUrl(apply) && !isJobrightInfoUrl(apply)) return apply;
  return (isValidHttpUrl(apply) ? apply : null) || fallbackUrl;
}

function formatBooleanValue(value: boolean | null | undefined): string {
  if (value === true) return "true";
  if (value === false) return "false";
  return "not provided";
}

function formatMoneyValue(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : "not provided";
}

function getSourceButtonLabel(job: Job): string {
  const first = job.sourceTags?.[0] || job.sourceLabel || job.sourceKind || "Source";
  if (first.includes("JobRight API")) return "JobRight API";
  if (first.includes("JobRight Minisite")) return "JR Minisite";
  if (first.includes("JobRight GitHub")) return "JR GitHub";
  if (first.includes("Simplify")) return "Simplify";
  if (first.includes("Speedy")) return "Speedy";
  return first;
}

function formatNotEligibleReason(value: string | undefined): string {
  const reason = String(value || "").trim();
  if (!reason) return "Not eligible";
  const labels: Record<string, string> = {
    h1b: "H1B sponsor is not true",
    citizen_only: "Citizen-only role",
    salary: "Min salary is 100k or below",
    missing_score: "Missing match score",
    score_below_threshold: "Score below threshold",
    missing_apply_link: "Missing apply link",
    unresolved_apply_link: "External apply link unresolved",
    phd_title: "PhD title",
    canada_location: "Canada location",
  };
  return labels[reason] || reason.replace(/_/g, " ");
}

function getGroupKey(job: Job, groupByColumn: keyof Job): string {
  const val = job[groupByColumn];
  return Array.isArray(val)
    ? val.join(", ") || "(empty)"
    : String(val ?? "") || "(empty)";
}

function buildJobsApiUrl(params: {
  limit: number;
  skip?: number;
  withTotal?: boolean;
  statusGroup?: "active" | "inactive_or_not_eligible";
}): string {
  const searchParams = new URLSearchParams({
    limit: String(params.limit),
    sortField: "postedAt",
    sortOrder: "desc",
    withTotal: params.withTotal ? "1" : "0",
  });
  if (typeof params.skip === "number" && params.skip > 0) {
    searchParams.set("skip", String(params.skip));
  }
  if (params.statusGroup) {
    searchParams.set("statusGroup", params.statusGroup);
  }

  return `/api/jobs?${searchParams.toString()}`;
}

// ─── Table Row type for flat list (includes group headers) ────────────────────
type TableRow =
  | { type: "job"; job: Job }
  | { type: "group"; label: string; count: number };

// ─── Virtual row data passed from List to each row ────────────────────────────
interface VirtualRowData {
  tableRows: TableRow[];
  columnWidths: Record<string, number>;
  expandedGroups: Set<string>;
  jobIndexById: Map<string, number>;
  toggleGroup: (key: string) => void;
  markGroupApplied: (label: string) => Promise<void>;
  markGroupNotInterested: (label: string) => Promise<void>;
  renderCell: (job: Job, col: (typeof COLUMNS)[0]) => React.ReactNode;
  tableMinWidth: number;
}

const VirtualRow = React.memo(function VirtualRow(props: {
  index: number;
  style: React.CSSProperties;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ariaAttributes?: any;
} & VirtualRowData) {
  const {
    index,
    style,
    tableRows,
    columnWidths,
    expandedGroups,
    jobIndexById,
    toggleGroup,
    markGroupApplied,
    markGroupNotInterested,
    renderCell,
    tableMinWidth,
  } = props;
  const row = tableRows[index];

  if (row.type === "group") {
    return (
      <div
        style={{ ...style, minWidth: tableMinWidth }}
        onClick={() => toggleGroup(row.label)}
        className="flex items-center bg-neutral-100/70 dark:bg-neutral-800/40 cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800/60 transition-colors border-b border-neutral-100 dark:border-neutral-800 px-3"
      >
        <div className="flex items-center justify-between gap-3 w-full">
          <div className="flex items-center gap-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {expandedGroups.has(row.label) ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronUp className="w-4 h-4" />
            )}
            <span>{row.label}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400">
              {row.count}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                void markGroupApplied(row.label);
              }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300 hover:bg-emerald-100 hover:text-emerald-700 dark:hover:bg-emerald-900/40 dark:hover:text-emerald-300 transition-all"
            >
              <Check className="w-3 h-3" /> Apply Group
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                void markGroupNotInterested(row.label);
              }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300 hover:bg-red-100 hover:text-red-700 dark:hover:bg-red-900/40 dark:hover:text-red-300 transition-all"
            >
              <Ban className="w-3 h-3" /> Skip Group
            </button>
          </div>
        </div>
      </div>
    );
  }

  const rowNumber = (jobIndexById.get(row.job.jobId) ?? 0) + 1;
  return (
    <div
      style={{ ...style, minWidth: tableMinWidth }}
      className="flex items-center border-b border-neutral-100 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
    >
      <div
        className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400 shrink-0"
        style={{
          width: columnWidths[ROW_NUMBER_COLUMN_KEY] ?? ROW_NUMBER_DEFAULT_WIDTH,
          minWidth: columnWidths[ROW_NUMBER_COLUMN_KEY] ?? ROW_NUMBER_DEFAULT_WIDTH,
          maxWidth: columnWidths[ROW_NUMBER_COLUMN_KEY] ?? ROW_NUMBER_DEFAULT_WIDTH,
        }}
      >
        {rowNumber}
      </div>
      {COLUMNS.map((col) => (
        <div
          key={`${row.job.jobId}-${col.key}`}
          className="px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 shrink-0 overflow-hidden"
          style={{
            width: columnWidths[col.key] ?? col.defaultWidth,
            minWidth: columnWidths[col.key] ?? col.defaultWidth,
            maxWidth: columnWidths[col.key] ?? col.defaultWidth,
          }}
        >
          {renderCell(row.job, col)}
        </div>
      ))}
    </div>
  );
});

// ─── Component ───────────────────────────────────────────────────────────────
export default function JobTable() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [appliedView, setAppliedView] = useState<
    "all" | "applied" | "not-interested" | "not-applied"
  >("all");
  const [sortColumn, setSortColumn] = useState<keyof Job>("postedAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const [groupByColumn, setGroupByColumn] = useState<keyof Job | "">("");
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [searchGlobal, setSearchGlobal] = useState("");
  const [searchByUrl, setSearchByUrl] = useState(false);
  const [top500Only, setTop500Only] = useState(false);
  const [activeFilter, setActiveFilter] = useState<ActiveFilterView>("active");
  const [savedPresets, setSavedPresets] = useState<SavedFilterPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editingPresetName, setEditingPresetName] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState({ total: 0, new: 0 });
  const [appliedWindowTick, setAppliedWindowTick] = useState(() => Date.now());

  // Resume modal state
  const [resumeModalOpen, setResumeModalOpen] = useState(false);
  const [resumeJobUrl, setResumeJobUrl] = useState("");
  const [resumeLatex, setResumeLatex] = useState("");
  const [resumeSubmitting, setResumeSubmitting] = useState(false);
  const [resumeError, setResumeError] = useState("");
  const [resumeResult, setResumeResult] = useState<ResumeApiSuccess | null>(null);
  const [sourceModalJob, setSourceModalJob] = useState<Job | null>(null);

  // Progressive background streaming state
  const [backgroundStreaming, setBackgroundStreaming] = useState(false);
  const [streamProgress, setStreamProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [streamStatusText, setStreamStatusText] = useState("");
  const [streamCompleteNotice, setStreamCompleteNotice] = useState(false);
  const activeStreamAbortControllerRef = useRef<AbortController | null>(null);

  // Auto Apply state: jobId → "pending" | "running" | "done" | "error" | "unsupported"
  const [autoApplyStatus, setAutoApplyStatus] = useState<Record<string, string>>({});

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    ...DEFAULT_COLUMN_WIDTHS,
  });
  const [columnWidthsHydrated, setColumnWidthsHydrated] = useState(false);
  const resizeStateRef = useRef<{
    key: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const didInitialLoadRef = useRef(false);
  const prevGroupByRef = useRef<keyof Job | "">("");
  const prevGroupKeysRef = useRef<Set<string>>(new Set());
  const bodyContainerRef = useRef<HTMLDivElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(400);

  const tableMinWidth = useMemo(
    () =>
      COLUMNS.reduce(
        (sum, col) => sum + (columnWidths[col.key] ?? col.defaultWidth),
        columnWidths[ROW_NUMBER_COLUMN_KEY] ?? ROW_NUMBER_DEFAULT_WIDTH
      ),
    [columnWidths]
  );

  // Load saved presets from localStorage on mount
  useEffect(() => {
    setSavedPresets(loadPresetsFromStorage());
    return () => {
      activeStreamAbortControllerRef.current?.abort();
    };
  }, []);

  // Lazy fetch complete sourceDetails when opening a job's info modal
  useEffect(() => {
    if (!sourceModalJob?.jobId) return;
    if (sourceModalJob.sourceDetails && sourceModalJob.sourceDetails.length > 0) return;
    let isMounted = true;
    fetch(`/api/jobs/${encodeURIComponent(sourceModalJob.jobId)}`)
      .then((res) => res.json())
      .then((fullJob) => {
        if (isMounted && fullJob && Array.isArray(fullJob.sourceDetails)) {
          setSourceModalJob((prev) =>
            prev && prev.jobId === fullJob.jobId
              ? { ...prev, sourceDetails: fullJob.sourceDetails }
              : prev
          );
        }
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, [sourceModalJob?.jobId]);

  useEffect(() => {
    const storedWidths = loadColumnWidthsFromStorage();
    setColumnWidths((prev) => {
      const prevEntries = Object.entries(prev);
      const sameShape =
        prevEntries.length === Object.keys(storedWidths).length &&
        prevEntries.every(([key, value]) => storedWidths[key] === value);
      return sameShape ? prev : storedWidths;
    });
    setColumnWidthsHydrated(true);
  }, []);

  useEffect(() => {
    if (!columnWidthsHydrated || typeof window === "undefined") return;
    const timer = setTimeout(() => saveColumnWidthsToStorage(columnWidths), 120);
    return () => clearTimeout(timer);
  }, [columnWidths, columnWidthsHydrated]);

  // Track container height for virtualized list
  useEffect(() => {
    const el = bodyContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (h > 0) setContainerHeight(h);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleResizeMouseMove = useCallback((event: MouseEvent) => {
    const state = resizeStateRef.current;
    if (!state) return;
    const deltaX = event.clientX - state.startX;
    const minWidth = COLUMN_MIN_WIDTHS[state.key] ?? 80;
    const nextWidth = Math.max(minWidth, Math.round(state.startWidth + deltaX));
    setColumnWidths((prev) =>
      prev[state.key] === nextWidth ? prev : { ...prev, [state.key]: nextWidth }
    );
  }, []);

  const stopResize = useCallback(() => {
    if (!resizeStateRef.current) return;
    resizeStateRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const startResize = useCallback(
    (columnKey: string, event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      resizeStateRef.current = {
        key: columnKey,
        startX: event.clientX,
        startWidth: columnWidths[columnKey] ?? DEFAULT_COLUMN_WIDTHS[columnKey] ?? 120,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [columnWidths]
  );

  useEffect(() => {
    window.addEventListener("mousemove", handleResizeMouseMove);
    window.addEventListener("mouseup", stopResize);
    return () => {
      window.removeEventListener("mousemove", handleResizeMouseMove);
      window.removeEventListener("mouseup", stopResize);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [handleResizeMouseMove, stopResize]);

  // Debounced search
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const handleSearchChange = useCallback((value: string) => {
    setSearchGlobal(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(value), 200);
  }, []);

  const industryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const job of jobs) {
      if (Array.isArray(job.industry)) {
        for (const item of job.industry) {
          const v = String(item || "").trim();
          if (v) set.add(v);
        }
      } else if (job.industry) {
        const v = String(job.industry || "").trim();
        if (v) set.add(v);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [jobs]);

  const todayAppliedCount = useMemo(() => {
    const { start, end } = getAppliedDayWindow(new Date(appliedWindowTick));
    const startMs = start.getTime();
    const endMs = end.getTime();
    return jobs.reduce((count, job) => {
      if (!job.appliedAt) return count;
      const appliedAtMs = new Date(job.appliedAt).getTime();
      if (!Number.isFinite(appliedAtMs)) return count;
      return appliedAtMs >= startMs && appliedAtMs < endMs ? count + 1 : count;
    }, 0);
  }, [jobs, appliedWindowTick]);

  // Debounced filters
  const [debouncedFilters, setDebouncedFilters] = useState<ColumnFilter[]>([]);
  const filterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (filterTimerRef.current) clearTimeout(filterTimerRef.current);
    filterTimerRef.current = setTimeout(() => setDebouncedFilters(filters), 200);
  }, [filters]);

  // ─── Data Fetching with Progressive Streaming (Active First) ───────────────
  const loadJobs = useCallback(
    async (options?: {
      showLoading?: boolean;
      resetNewCount?: boolean;
    }) => {
      const showLoading = options?.showLoading ?? true;
      const resetNewCount = options?.resetNewCount ?? true;

      // Cancel any ongoing background stream
      if (activeStreamAbortControllerRef.current) {
        activeStreamAbortControllerRef.current.abort();
      }
      const abortController = new AbortController();
      activeStreamAbortControllerRef.current = abortController;
      const signal = abortController.signal;

      if (showLoading) setLoading(true);
      setBackgroundStreaming(false);
      setStreamProgress(null);
      setStreamStatusText("");
      setStreamCompleteNotice(false);

      try {
        // Step 1: Initial fast batch of ACTIVE jobs (300 jobs)
        const res = await fetch(
          buildJobsApiUrl({ limit: INITIAL_FETCH_LIMIT, skip: 0, statusGroup: "active", withTotal: true }),
          { signal }
        );
        const data = await res.json();
        const initialActiveJobs: Job[] = data.jobs || [];
        const activeTotal = typeof data.total === "number" ? data.total : initialActiveJobs.length;
        const overallTotal = typeof data.overallTotal === "number" ? data.overallTotal : activeTotal;

        setJobs(initialActiveJobs);
        if (resetNewCount) {
          setStats({ total: overallTotal, new: 0 });
        } else {
          setStats((prev) => ({ ...prev, total: overallTotal }));
        }

        // Unblock UI immediately so table renders right away
        if (showLoading) setLoading(false);

        // Step 2: Progressive background stream
        if (!signal.aborted) {
          setBackgroundStreaming(true);

          // 2A: Stream all remaining ACTIVE jobs first
          let currentActiveSkip = initialActiveJobs.length;
          setStreamStatusText(
            `Syncing active jobs (${currentActiveSkip.toLocaleString()} / ${activeTotal.toLocaleString()})...`
          );

          while (currentActiveSkip < activeTotal && !signal.aborted) {
            try {
              const batchRes = await fetch(
                buildJobsApiUrl({
                  limit: STREAM_BATCH_SIZE,
                  skip: currentActiveSkip,
                  statusGroup: "active",
                  withTotal: false,
                }),
                { signal }
              );
              if (!batchRes.ok) break;
              const batchData = await batchRes.json();
              const nextJobs: Job[] = batchData.jobs || [];
              if (nextJobs.length === 0) break;

              setJobs((prev) => {
                const seen = new Set(prev.map((j) => j.jobId));
                const filteredNext = nextJobs.filter((j) => !seen.has(j.jobId));
                return [...prev, ...filteredNext];
              });

              currentActiveSkip += nextJobs.length;
              setStreamStatusText(
                `Syncing active jobs (${Math.min(currentActiveSkip, activeTotal).toLocaleString()} / ${activeTotal.toLocaleString()})...`
              );
            } catch (batchErr) {
              if (signal.aborted) return;
              console.warn("Background active stream batch failed:", batchErr);
              break;
            }
          }

          // 2B: Now stream inactive & not-eligible jobs next
          const otherTotal = Math.max(0, overallTotal - activeTotal);
          let currentOtherSkip = 0;
          setStreamStatusText(
            `Active jobs ready (${activeTotal.toLocaleString()}) · Syncing other jobs...`
          );

          while (currentOtherSkip < otherTotal && !signal.aborted) {
            try {
              const batchRes = await fetch(
                buildJobsApiUrl({
                  limit: STREAM_BATCH_SIZE,
                  skip: currentOtherSkip,
                  statusGroup: "inactive_or_not_eligible",
                  withTotal: false,
                }),
                { signal }
              );
              if (!batchRes.ok) break;
              const batchData = await batchRes.json();
              const nextJobs: Job[] = batchData.jobs || [];
              if (nextJobs.length === 0) break;

              setJobs((prev) => {
                const seen = new Set(prev.map((j) => j.jobId));
                const filteredNext = nextJobs.filter((j) => !seen.has(j.jobId));
                return [...prev, ...filteredNext];
              });

              currentOtherSkip += nextJobs.length;
              setStreamStatusText(
                `Active jobs ready · Syncing other jobs (${Math.min(currentOtherSkip, otherTotal).toLocaleString()} / ${otherTotal.toLocaleString()})...`
              );
            } catch (batchErr) {
              if (signal.aborted) return;
              console.warn("Background other stream batch failed:", batchErr);
              break;
            }
          }

          if (!signal.aborted) {
            setBackgroundStreaming(false);
            setStreamStatusText("");
            setStreamCompleteNotice(true);
            setTimeout(() => setStreamCompleteNotice(false), 5000);
          }
        }
      } catch (err: unknown) {
        if (signal.aborted) return;
        console.error("Failed to load jobs:", err);
      } finally {
        if (showLoading && !signal.aborted) setLoading(false);
      }
    },
    []
  );

  const runFullSync = useCallback(async () => {
    // Reload from DB only — do not hit Jobright/Greenhouse fetch APIs on load/refresh.
    await loadJobs({ showLoading: true, resetNewCount: true });
  }, [loadJobs]);

  useEffect(() => {
    if (didInitialLoadRef.current) return;
    didInitialLoadRef.current = true;
    // Load existing data from DB only. No Jobright/Greenhouse fetch on page load.
    async function init() {
      await loadJobs({ showLoading: true });
    }
    void init();
  }, [loadJobs]);

  useEffect(() => {
    const now = new Date();
    const nextBoundary = new Date(now);
    nextBoundary.setHours(APPLIED_DAY_START_HOUR, 0, 0, 0);
    if (nextBoundary.getTime() <= now.getTime()) {
      nextBoundary.setDate(nextBoundary.getDate() + 1);
    }
    const msUntilBoundary = Math.max(
      nextBoundary.getTime() - now.getTime() + 1000,
      1000
    );
    const timer = window.setTimeout(() => {
      setAppliedWindowTick(Date.now());
    }, msUntilBoundary);
    return () => window.clearTimeout(timer);
  }, [appliedWindowTick]);

  // ─── Update Job Status ──────────────────────────────────────────────────────
  const updateJobStatusForIds = useCallback(
    async (jobIds: string[], mode: "apply" | "skip" | "clear") => {
      const uniqueIds = Array.from(new Set(jobIds.map((id) => id.trim()).filter(Boolean)));
      if (uniqueIds.length === 0) return;

      const idSet = new Set(uniqueIds);
      const nowIso = new Date().toISOString();
      setJobs((prev) =>
        prev.map((j) => {
          if (!idSet.has(j.jobId)) return j;
          if (mode === "apply") {
            return { ...j, applied: true, appliedAt: nowIso, manualApplied: true, manualAppliedAt: nowIso, notInterested: false };
          }
          if (mode === "skip") {
            return { ...j, notInterested: true, applied: false, appliedAt: null, manualApplied: false, manualAppliedAt: null };
          }
          return { ...j, applied: false, appliedAt: null, manualApplied: false, manualAppliedAt: null, notInterested: false };
        })
      );

      const body =
        mode === "apply"
          ? { applied: true }
          : mode === "skip"
            ? { notInterested: true }
            : { applied: false, notInterested: false };

      try {
        const requestBatchSize = 25;
        for (let i = 0; i < uniqueIds.length; i += requestBatchSize) {
          const batch = uniqueIds.slice(i, i + requestBatchSize);
          const results = await Promise.all(
            batch.map(async (jobId) => {
              const res = await fetch(`/api/jobs/${jobId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              });
              return res.ok;
            })
          );
          if (results.some((ok) => !ok)) {
            throw new Error(`Failed status update for one or more jobs (${mode})`);
          }
        }
      } catch (err) {
        console.error("Failed to update status:", err);
        await loadJobs();
      }
    },
    [loadJobs]
  );

  const markApplied = useCallback(
    async (jobId: string) => {
      await updateJobStatusForIds([jobId], "apply");
    },
    [updateJobStatusForIds]
  );

  const markNotInterested = useCallback(
    async (jobId: string) => {
      await updateJobStatusForIds([jobId], "skip");
    },
    [updateJobStatusForIds]
  );

  const clearStatus = useCallback(
    async (jobId: string) => {
      await updateJobStatusForIds([jobId], "clear");
    },
    [updateJobStatusForIds]
  );

  // ─── Sorting ───────────────────────────────────────────────────────────────
  const handleSort = useCallback(
    (col: keyof Job) => {
      if (sortColumn === col) {
        setSortDirection((d) =>
          d === "asc" ? "desc" : d === "desc" ? null : "asc"
        );
      } else {
        setSortColumn(col);
        setSortDirection("asc");
      }
    },
    [sortColumn]
  );

  // ─── Filter Management ────────────────────────────────────────────────────
  const addFilter = useCallback(() => {
    setFilters((f) => [
      ...f,
      { id: crypto.randomUUID(), column: "title", mode: "include" as FilterMode, matchType: "contains" as MatchType, value: "" },
    ]);
  }, []);

  const updateFilter = useCallback(
    (id: string, updates: Partial<ColumnFilter>) => {
      setFilters((f) =>
        f.map((filter) =>
          filter.id === id ? { ...filter, ...updates } : filter
        )
      );
    },
    []
  );

  const removeFilter = useCallback((id: string) => {
    setFilters((f) => f.filter((filter) => filter.id !== id));
  }, []);

  // ─── Saved Filter Presets ──────────────────────────────────────────────────
  const saveCurrentPreset = useCallback(() => {
    const name = presetName.trim();
    if (!name || filters.length === 0) return;
    const preset: SavedFilterPreset = {
      id: crypto.randomUUID(),
      name,
      filters: filters.map(({ column, mode, matchType, value }) => ({ column, mode, matchType, value })),
    };
    const updated = [...savedPresets, preset];
    setSavedPresets(updated);
    savePresetsToStorage(updated);
    setPresetName("");
  }, [presetName, filters, savedPresets]);

  const loadPreset = useCallback((preset: SavedFilterPreset) => {
    setFilters(
      preset.filters.map((f) => ({ ...f, id: crypto.randomUUID() }))
    );
  }, []);

  const deletePreset = useCallback(
    (id: string) => {
      const updated = savedPresets.filter((p) => p.id !== id);
      setSavedPresets(updated);
      savePresetsToStorage(updated);
    },
    [savedPresets]
  );

  const startRenamePreset = useCallback((preset: SavedFilterPreset) => {
    setEditingPresetId(preset.id);
    setEditingPresetName(preset.name);
  }, []);

  const confirmRenamePreset = useCallback(() => {
    if (!editingPresetId || !editingPresetName.trim()) {
      setEditingPresetId(null);
      return;
    }
    const updated = savedPresets.map((p) =>
      p.id === editingPresetId ? { ...p, name: editingPresetName.trim() } : p
    );
    setSavedPresets(updated);
    savePresetsToStorage(updated);
    setEditingPresetId(null);
    setEditingPresetName("");
  }, [editingPresetId, editingPresetName, savedPresets]);

  const updatePreset = useCallback(
    (id: string) => {
      if (filters.length === 0) return;
      const updated = savedPresets.map((p) =>
        p.id === id
          ? { ...p, filters: filters.map(({ column, mode, matchType, value }) => ({ column, mode, matchType, value })) }
          : p
      );
      setSavedPresets(updated);
      savePresetsToStorage(updated);
    },
    [filters, savedPresets]
  );

  const normalizedGlobalSearch = debouncedSearch.trim().toLowerCase();
  const globalSearchTextByJobId = useMemo(() => {
    const map = new Map<string, string>();
    for (const job of jobs) {
      const text = COLUMNS.map((col) => {
        const value = job[col.key];
        return Array.isArray(value) ? value.join(", ") : String(value ?? "");
      })
        .join(" ")
        .toLowerCase();
      map.set(job.jobId, text);
    }
    return map;
  }, [jobs]);

  const globalSearchUrlByJobId = useMemo(() => {
    const map = new Map<string, string>();
    for (const job of jobs) {
      const urlText = String(job.applyLink ?? "").toLowerCase();
      map.set(job.jobId, urlText);
    }
    return map;
  }, [jobs]);

  // ─── Process Data ──────────────────────────────────────────────────────────
  const processedJobs = useMemo(() => {
    let result = jobs;

    if (activeFilter === "active") {
      result = result.filter((job) => job.inactive !== true && job.notEligible !== true);
    } else if (activeFilter === "not-eligible") {
      result = result.filter((job) => job.notEligible === true);
    } else if (activeFilter === "inactive") {
      result = result.filter((job) => job.inactive === true);
    }

    // Keep tab behavior exact even during optimistic local updates.
    if (appliedView === "applied") {
      result = result.filter((job) => job.applied === true);
    } else if (appliedView === "not-interested") {
      result = result.filter((job) => job.notInterested === true);
    } else if (appliedView === "not-applied") {
      result = result.filter((job) => job.applied !== true && job.notInterested !== true);
    }

    // Global search
    if (normalizedGlobalSearch) {
      if (searchByUrl) {
        result = result.filter((job) =>
          (globalSearchUrlByJobId.get(job.jobId) || "").includes(normalizedGlobalSearch)
        );
      } else {
        result = result.filter((job) =>
          (globalSearchTextByJobId.get(job.jobId) || "").includes(normalizedGlobalSearch)
        );
      }
    }

    // Apply column filters
    for (const filter of debouncedFilters) {
      if (filter.column === "industry") {
        const selected = Array.isArray(filter.value)
          ? filter.value
          : filter.value
            ? [filter.value]
            : [];
        if (selected.length === 0) continue;
        result = result.filter((job) => {
          const val = job[filter.column as keyof Job];
          const values = Array.isArray(val)
            ? val.map((v) => String(v))
            : [String(val ?? "")];
          const matches = values.some((v) => selected.includes(v));
          return filter.mode === "include" ? matches : !matches;
        });
        continue;
      }

      const value = Array.isArray(filter.value) ? filter.value.join(",") : filter.value;
      if (!String(value).trim()) continue;
      result = result.filter((job) => {
        const val = job[filter.column as keyof Job];
        const text = Array.isArray(val) ? val.join(", ") : String(val ?? "");
        const matches = matchFilter(text, String(value), filter.matchType);
        return filter.mode === "include" ? matches : !matches;
      });
    }

    // Top500 filter
    if (top500Only) {
      result = result.filter((job) => job.top500);
    }

    // Sort
    if (sortColumn && sortDirection) {
      result = [...result].sort((a, b) => {
        const aVal = a[sortColumn];
        const bVal = b[sortColumn];
        let cmp = 0;
        if (sortColumn === "postedAt" || sortColumn === "fetchedAt" || sortColumn === "appliedAt") {
          const aTime = new Date(String(aVal || "")).getTime();
          const bTime = new Date(String(bVal || "")).getTime();
          cmp = (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
        } else if (typeof aVal === "number" && typeof bVal === "number") {
          cmp = aVal - bVal;
        } else if (typeof aVal === "string" && typeof bVal === "string") {
          cmp = aVal.localeCompare(bVal);
        } else if (typeof aVal === "boolean" && typeof bVal === "boolean") {
          cmp = Number(aVal) - Number(bVal);
        } else {
          cmp = String(aVal ?? "").localeCompare(String(bVal ?? ""));
        }
        return sortDirection === "desc" ? -cmp : cmp;
      });
    }

    return result;
  }, [
    jobs,
    appliedView,
    normalizedGlobalSearch,
    globalSearchTextByJobId,
    globalSearchUrlByJobId,
    searchByUrl,
    debouncedFilters,
    sortColumn,
    sortDirection,
    top500Only,
    activeFilter,
  ]);

  const jobIndexById = useMemo(() => {
    const map = new Map<string, number>();
    processedJobs.forEach((job, idx) => map.set(job.jobId, idx));
    return map;
  }, [processedJobs]);

  const inactiveCount = useMemo(() => jobs.filter((j) => j.inactive).length, [jobs]);
  const notEligibleCount = useMemo(() => jobs.filter((j) => j.notEligible).length, [jobs]);

  const groupedJobsMap = useMemo(() => {
    if (!groupByColumn) return new Map<string, Job[]>();
    const groups = new Map<string, Job[]>();
    for (const job of processedJobs) {
      const key = getGroupKey(job, groupByColumn);
      const existing = groups.get(key);
      if (existing) {
        existing.push(job);
      } else {
        groups.set(key, [job]);
      }
    }
    return groups;
  }, [processedJobs, groupByColumn]);

  // ─── Build flat table rows (with group headers) ─────────────────────────────
  const tableRows = useMemo<TableRow[]>(() => {
    if (!groupByColumn) {
      return processedJobs.map((job) => ({ type: "job" as const, job }));
    }

    const rows: TableRow[] = [];
    for (const [label, groupJobs] of groupedJobsMap.entries()) {
      rows.push({ type: "group", label, count: groupJobs.length });
      if (expandedGroups.has(label)) {
        for (const job of groupJobs) {
          rows.push({ type: "job", job });
        }
      }
    }
    return rows;
  }, [processedJobs, groupByColumn, groupedJobsMap, expandedGroups]);

  // Keep expand/collapse state stable across status updates; only reset on grouping switch.
  useEffect(() => {
    if (!groupByColumn) {
      setExpandedGroups(new Set());
      prevGroupByRef.current = "";
      prevGroupKeysRef.current = new Set();
      return;
    }

    const currentKeys = new Set<string>(groupedJobsMap.keys());
    const groupingChanged = prevGroupByRef.current !== groupByColumn;
    const previousKeys = prevGroupKeysRef.current;

    setExpandedGroups((prevExpanded) => {
      if (groupingChanged || prevExpanded.size === 0) {
        return new Set(currentKeys);
      }
      const nextExpanded = new Set<string>();
      for (const key of currentKeys) {
        if (prevExpanded.has(key) || !previousKeys.has(key)) {
          nextExpanded.add(key);
        }
      }
      return nextExpanded;
    });

    prevGroupByRef.current = groupByColumn;
    prevGroupKeysRef.current = currentKeys;
  }, [groupByColumn, groupedJobsMap]);

  const toggleGroup = useCallback((key: string) => {
    startTransition(() => {
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    });
  }, []);

  const expandAllGroups = useCallback(() => {
    startTransition(() => {
      setExpandedGroups(new Set(groupedJobsMap.keys()));
    });
  }, [groupedJobsMap]);

  const collapseAllGroups = useCallback(() => {
    startTransition(() => {
      setExpandedGroups(new Set());
    });
  }, []);

  const markGroupApplied = useCallback(
    async (groupLabel: string) => {
      const groupJobs = groupedJobsMap.get(groupLabel) || [];
      await updateJobStatusForIds(
        groupJobs.map((job) => job.jobId),
        "apply"
      );
    },
    [groupedJobsMap, updateJobStatusForIds]
  );

  const markGroupNotInterested = useCallback(
    async (groupLabel: string) => {
      const groupJobs = groupedJobsMap.get(groupLabel) || [];
      await updateJobStatusForIds(
        groupJobs.map((job) => job.jobId),
        "skip"
      );
    },
    [groupedJobsMap, updateJobStatusForIds]
  );

  // ─── Resume Modal helpers ──────────────────────────────────────────────────
  const openResumeModal = useCallback((jobUrl?: string) => {
    setResumeJobUrl(jobUrl || "");
    setResumeLatex("");
    setResumeError("");
    setResumeResult(null);
    setResumeModalOpen(true);
  }, []);

  const closeResumeModal = useCallback(() => {
    setResumeModalOpen(false);
  }, []);

  const submitResume = useCallback(async () => {
    setResumeSubmitting(true);
    setResumeError("");
    setResumeResult(null);
    try {
      const response = await fetch("/api/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobUrl: resumeJobUrl, latex: resumeLatex }),
      });

      const data = (await response.json()) as ResumeApiSuccess | ResumeApiFailure;
      if (!response.ok || !data || !("success" in data) || data.success !== true) {
        const err = data as ResumeApiFailure;
        const details = err.details ? `\n${err.details}` : "";
        throw new Error(`${err.error || "Failed to generate resume"}${details}`);
      }

      setResumeResult(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setResumeError(message);
    } finally {
      setResumeSubmitting(false);
    }
  }, [resumeJobUrl, resumeLatex]);

  // ─── Auto Apply ────────────────────────────────────────────────────────────
  const autoApply = useCallback(async (job: Job) => {
    const url = resolveJobTitleUrl(job);
    setAutoApplyStatus((prev) => ({ ...prev, [job.jobId]: "running" }));
    try {
      const res = await fetch("/api/auto-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.jobId, jobrightJobId: job.jobrightId, url }),
      });
      const data = await res.json() as { success: boolean; ats?: string; error?: string };
      if (!res.ok || !data.success) {
        setAutoApplyStatus((prev) => ({ ...prev, [job.jobId]: data.error === "unsupported_ats" ? "unsupported" : "error" }));
      } else {
        setAutoApplyStatus((prev) => ({ ...prev, [job.jobId]: "done" }));
      }
    } catch {
      setAutoApplyStatus((prev) => ({ ...prev, [job.jobId]: "error" }));
    }
  }, []);

  // ─── Cell Render ───────────────────────────────────────────────────────────
  const renderCell = useCallback(
    (job: Job, col: (typeof COLUMNS)[0]) => {
      const val = job[col.key];

      if (col.key === "applied") {
        if (job.notEligible) {
          return (
            <span
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
              title={formatNotEligibleReason(job.notEligibleReason)}
            >
              <Ban className="w-3 h-3" /> Not Eligible
            </span>
          );
        }
        return (
          <div className="flex items-center gap-1.5">
            {job.applied ? (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); clearStatus(job.jobId); }}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-900/60 transition-all"
                  title="Click to clear"
                >
                  <Check className="w-3 h-3" /> Applied
                </button>
                {job.appliedAt && (
                  <span className="text-[10px] text-neutral-400" title={formatPST(job.appliedAt)}>
                    {formatPST(job.appliedAt)}
                  </span>
                )}
              </>
            ) : job.notInterested ? (
              <button
                onClick={(e) => { e.stopPropagation(); clearStatus(job.jobId); }}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/60 transition-all"
                title="Click to clear"
              >
                <Ban className="w-3 h-3" /> Not Interested
              </button>
            ) : (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void markApplied(job.jobId);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400 hover:bg-emerald-100 hover:text-emerald-700 dark:hover:bg-emerald-900/40 dark:hover:text-emerald-300 transition-all"
                >
                  <Check className="w-3 h-3" /> Apply
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void markNotInterested(job.jobId);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400 hover:bg-red-100 hover:text-red-700 dark:hover:bg-red-900/40 dark:hover:text-red-300 transition-all"
                >
                  <Ban className="w-3 h-3" /> Skip
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openResumeModal(resolveJobTitleUrl(job));
                  }}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400 hover:bg-violet-100 hover:text-violet-700 dark:hover:bg-violet-900/40 dark:hover:text-violet-300 transition-all"
                  title="Generate resume PDF for this job"
                >
                  <FileText className="w-3 h-3" /> Resume
                </button>
                {(() => {
                  const applyState = autoApplyStatus[job.jobId];
                  const isRunning = applyState === "running";
                  const isDone = applyState === "done";
                  const isError = applyState === "error";
                  const isUnsupported = applyState === "unsupported";
                  return (
                    <button
                      onClick={(e) => { e.stopPropagation(); void autoApply(job); }}
                      disabled={isRunning}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium transition-all ${
                        isDone
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-900/60"
                          : isUnsupported
                          ? "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 hover:bg-orange-200 dark:hover:bg-orange-900/60"
                          : isError
                          ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/60"
                          : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400 hover:bg-sky-100 hover:text-sky-700 dark:hover:bg-sky-900/40 dark:hover:text-sky-300"
                      }`}
                      title={isUnsupported ? "ATS not supported yet — click to retry" : isError ? "Auto apply failed — click to retry" : isDone ? "Applied! Click to reapply" : "Auto apply via browser automation"}
                    >
                      {isRunning ? (
                        <><Loader2 className="w-3 h-3 animate-spin" /> Running...</>
                      ) : isDone ? (
                        <><Check className="w-3 h-3" /> Reapply</>
                      ) : isUnsupported ? (
                        <><Zap className="w-3 h-3" /> No ATS</>
                      ) : isError ? (
                        <><Zap className="w-3 h-3" /> Retry</>
                      ) : (
                        <><Zap className="w-3 h-3" /> Auto Apply</>
                      )}
                    </button>
                  );
                })()}
              </>
            )}
          </div>
        );
      }

      if (col.key === "title") {
        const url = resolveJobTitleUrl(job);
        return (
          <div className="flex items-center gap-1.5 min-w-0">
            {job.inactive && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300 font-medium">
                Inactive
              </span>
            )}
            {job.notEligible && (
              <span
                className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 font-medium"
                title={formatNotEligibleReason(job.notEligibleReason)}
              >
                Not Eligible
              </span>
            )}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400 hover:underline font-medium truncate min-w-0"
              title={String(val)}
              onClick={(e) => e.stopPropagation()}
            >
              <span className="truncate">{String(val) || "—"}</span>
              <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
            </a>
          </div>
        );
      }

      if (col.key === "categoryLabel") {
        const catLabel = job.categoryLabel || "Others";
        const confidence = job.categoryConfidence;
        const confidencePercent = typeof confidence === "number" ? Math.round(confidence * 100) : null;
        const isOthers = !job.category || job.category === "others" || catLabel === "Others";

        return (
          <div
            className="flex items-center gap-1.5 min-w-0"
            title={`Category: ${catLabel}${confidencePercent !== null ? ` (${confidencePercent}% confidence)` : ""}`}
          >
            <span
              className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium truncate max-w-full ${
                isOthers
                  ? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
                  : "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300 border border-indigo-200/50 dark:border-indigo-800/40"
              }`}
            >
              {catLabel}
            </span>
          </div>
        );
      }

      if (col.key === "company") {
        const company = String(val || "");
        const recruiterProfileUrl = String(job.recruiterProfileUrl || "").trim();
        const hasRecruiterProfileLink = /^https?:\/\//i.test(recruiterProfileUrl);
        return (
          <div className="flex items-center gap-2">
            {hasRecruiterProfileLink && company ? (
              <a
                href={recruiterProfileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate text-blue-600 dark:text-blue-400 hover:underline"
                title={company}
                onClick={(e) => e.stopPropagation()}
              >
                {company}
              </a>
            ) : (
              <span className="truncate" title={company}>
                {company || "—"}
              </span>
            )}
            {job.top500 && (
              <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                Top500
              </span>
            )}
          </div>
        );
      }

      if (col.key === "postedAt" || col.key === "fetchedAt") {
        const rawDate = new Date(String(val));
        const valid = Number.isFinite(rawDate.getTime());
        return (
          <span title={valid ? rawDate.toISOString() : String(val)}>
            {valid ? formatPST(String(val)) : "—"}
          </span>
        );
      }

      if (col.key === "sourceTags") {
        const label = getSourceButtonLabel(job);
        const detailText = [
          job.sourceLabel,
          job.sourceRepo,
          job.jobrightId ? `JobRight ID: ${job.jobrightId}` : "",
        ].filter(Boolean).join("\n");
        return (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSourceModalJob(job);
            }}
            className="inline-flex max-w-full items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 hover:bg-cyan-100 hover:text-cyan-700 dark:hover:bg-cyan-900/40 dark:hover:text-cyan-300 transition-colors"
            title={detailText || label}
          >
            <Info className="w-3 h-3 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        );
      }

      if (col.key === "isNewGrad") {
        return val ? (
          <span className="text-emerald-500 font-medium text-xs">Yes</span>
        ) : (
          <span className="text-neutral-400 text-xs">No</span>
        );
      }

      if (col.key === "industry" && Array.isArray(val)) {
        return (
          <div className="flex flex-wrap gap-1">
            {val.slice(0, 3).map((s, i) => (
              <span
                key={i}
                className="px-1.5 py-0.5 bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 rounded text-[10px]"
              >
                {s}
              </span>
            ))}
            {val.length > 3 && (
              <span className="text-neutral-400 text-[10px]">
                +{val.length - 3}
              </span>
            )}
          </div>
        );
      }

      if (col.key === "h1bSponsored") {
        const v = String(val || "");
        const color =
          v === "Yes"
            ? "text-emerald-500"
            : v === "No"
              ? "text-red-400"
              : "text-neutral-400";
        return (
          <span className={`text-xs font-medium ${color}`}>{v || "—"}</span>
        );
      }

      if (col.key === "workModel") {
        const v = String(val || "");
        const color = v.toLowerCase().includes("remote")
          ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300"
          : v.toLowerCase().includes("hybrid")
            ? "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300"
            : "bg-neutral-50 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400";
        return v ? (
          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${color}`}
          >
            {v}
          </span>
        ) : (
          <span className="text-neutral-400">—</span>
        );
      }
      if (col.key === "companyRank") {
        const rank = val as number;
        return (
          <span className="text-neutral-500 dark:text-neutral-400">
            {rank && rank !== 999999 ? `#${rank}` : "—"}
          </span>
        );
      }

      const text = Array.isArray(val) ? val.join(", ") : String(val ?? "");
      return (
        <span className="truncate block" title={text}>
          {text || "—"}
        </span>
      );
    },
    [markApplied, markNotInterested, clearStatus, openResumeModal, autoApply, autoApplyStatus]
  );

  // Memoize itemData for the virtualized list so VirtualRow can skip re-renders
  const virtualListData = useMemo<VirtualRowData>(
    () => ({
      tableRows,
      columnWidths,
      expandedGroups,
      jobIndexById,
      toggleGroup,
      markGroupApplied,
      markGroupNotInterested,
      renderCell,
      tableMinWidth,
    }),
    [tableRows, columnWidths, expandedGroups, jobIndexById, toggleGroup, markGroupApplied, markGroupNotInterested, renderCell, tableMinWidth]
  );

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* ── Toolbar ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        {/* URL Search Toggle + Global Search */}
        <div className="flex items-center gap-0 flex-1 min-w-50 max-w-lg">
          {/* URL toggle button — left side of search bar */}
          <button
            onClick={() => setSearchByUrl((v) => !v)}
            title={searchByUrl ? "Searching by URL — click to search all columns" : "Click to search by URL (applyLink)"}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-l-lg border text-xs font-medium transition-all shrink-0 ${searchByUrl
                ? "bg-blue-500 border-blue-500 text-white shadow-sm"
                : "bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800"
              }`}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            URL
          </button>
          {/* Search input */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
            <input
              type="text"
              placeholder={searchByUrl ? "Search by URL..." : "Search all columns..."}
              value={searchGlobal}
              onChange={(e) => handleSearchChange(e.target.value)}
              className={`w-full pl-9 pr-3 py-2 rounded-r-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all bg-white dark:bg-neutral-900 ${searchByUrl
                  ? "border-blue-400 dark:border-blue-500"
                  : "border-neutral-200 dark:border-neutral-700"
                } border-l-0`}
            />
          </div>
        </div>

        {/* View Tabs */}
        <div className="flex rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          {(["all", "applied", "not-interested", "not-applied"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setAppliedView(v)}
              className={`px-3 py-2 text-xs font-medium transition-colors ${appliedView === v
                ? "bg-blue-500 text-white"
                : "bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                }`}
            >
              {v === "all"
                ? "All Jobs"
                : v === "applied"
                  ? "Applied"
                  : v === "not-interested"
                    ? "Not Interested"
                    : "Not Applied"}
            </button>
          ))}
        </div>

        <button
          onClick={() => setTop500Only((v) => !v)}
          className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${top500Only
            ? "bg-amber-500 text-white border-amber-500"
            : "bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            }`}
          title="Show only Top500 companies"
        >
          Top500 Only
        </button>

        {/* Active / Inactive filter */}
        <div className="flex rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          {(["active", "not-eligible", "all", "inactive"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setActiveFilter(v)}
              className={`px-3 py-2 text-xs font-medium transition-colors ${activeFilter === v
                  ? v === "inactive"
                    ? "bg-orange-500 text-white"
                    : v === "not-eligible"
                      ? "bg-rose-500 text-white"
                    : "bg-blue-500 text-white"
                  : "bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                }`}
            >
              {v === "active" ? "Active" : v === "not-eligible" ? "Not Eligible" : v === "inactive" ? "Inactive" : "All Listings"}
            </button>
          ))}
        </div>

        {/* Group By */}
        <div className="flex items-center gap-1.5">
          <Layers className="w-4 h-4 text-neutral-400" />
          <select
            value={groupByColumn}
            onChange={(e) =>
              setGroupByColumn(e.target.value as keyof Job | "")
            }
            className="text-xs border border-neutral-200 dark:border-neutral-700 rounded-lg px-2 py-2 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          >
            <option value="">No Grouping</option>
            {COLUMNS.filter(
              (c) => !["applied", "postedAt"].includes(c.key)
            ).map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            onClick={expandAllGroups}
            disabled={!groupByColumn || groupedJobsMap.size === 0}
            className="px-2 py-2 text-xs rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Expand all groups"
          >
            Expand All
          </button>
          <button
            onClick={collapseAllGroups}
            disabled={!groupByColumn || groupedJobsMap.size === 0}
            className="px-2 py-2 text-xs rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Collapse all groups"
          >
            Collapse All
          </button>
        </div>

        {/* Filter Toggle */}
        <button
          onClick={() => setShowFilterPanel(!showFilterPanel)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-all ${filters.length > 0
            ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
            : "border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            }`}
        >
          <Filter className="w-3.5 h-3.5" />
          Filters {filters.length > 0 && `(${filters.length})`}
        </button>

        {/* Refresh */}
        <button
          onClick={() => void runFullSync()}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 disabled:bg-blue-400 text-white text-xs font-medium transition-all basis-full sm:basis-auto"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Reload
        </button>

        {/* Stats */}
        <div className="ml-auto flex items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
          {backgroundStreaming && streamStatusText && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200/70 dark:border-blue-800/70 animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
              {streamStatusText}
            </span>
          )}
          {!backgroundStreaming && streamCompleteNotice && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200/70 dark:border-emerald-800/70 transition-all">
              <span>✓</span> All {stats.total.toLocaleString()} jobs loaded
            </span>
          )}
          <span>
            {processedJobs.length} shown / {stats.total} total
          </span>
          {inactiveCount > 0 && (
            <span className="text-orange-500">{inactiveCount} inactive</span>
          )}
          {notEligibleCount > 0 && (
            <span className="text-rose-500">{notEligibleCount} not eligible</span>
          )}
          <span>
            Today Applied ({APPLIED_DAY_START_HOUR}AM-{APPLIED_DAY_START_HOUR}AM):{" "}
            {todayAppliedCount}
          </span>
          {stats.new > 0 && (
            <span className="text-emerald-500">+{stats.new} new</span>
          )}
        </div>
      </div>

      {/* ── Filter Panel ─────────────────────────────────────────────────────── */}
      {showFilterPanel && (
        <div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
              Column Filters
            </h3>
            <div className="flex items-center gap-2">
              {filters.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveCurrentPreset(); }}
                    placeholder="Preset name..."
                    className="text-xs border border-neutral-200 dark:border-neutral-700 rounded-lg px-2 py-1 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-blue-500/50 w-28"
                  />
                  <button
                    onClick={saveCurrentPreset}
                    disabled={!presetName.trim()}
                    className="flex items-center gap-1 px-2 py-1 rounded-md bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 text-xs hover:bg-violet-100 dark:hover:bg-violet-900/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    title="Save current filters as preset"
                  >
                    <Bookmark className="w-3 h-3" /> Save
                  </button>
                </div>
              )}
              <button
                onClick={addFilter}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-xs hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
              >
                <Plus className="w-3 h-3" /> Add Filter
              </button>
            </div>
          </div>

          {/* ── Saved Presets ─────────────────────────────────────── */}
          {savedPresets.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pb-2 border-b border-neutral-100 dark:border-neutral-800">
              <Bookmark className="w-3.5 h-3.5 text-neutral-400" />
              <span className="text-xs text-neutral-500 dark:text-neutral-400 mr-1">Presets:</span>
              {savedPresets.map((preset) => (
                <div key={preset.id} className="flex items-center gap-0.5 group">
                  {editingPresetId === preset.id ? (
                    <input
                      autoFocus
                      value={editingPresetName}
                      onChange={(e) => setEditingPresetName(e.target.value)}
                      onBlur={confirmRenamePreset}
                      onKeyDown={(e) => { if (e.key === "Enter") confirmRenamePreset(); if (e.key === "Escape") setEditingPresetId(null); }}
                      className="text-xs border border-blue-400 rounded px-2 py-0.5 bg-white dark:bg-neutral-800 focus:outline-none w-24"
                    />
                  ) : (
                    <button
                      onClick={() => loadPreset(preset)}
                      className="px-2.5 py-1 rounded-lg text-xs font-medium bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 hover:bg-violet-100 dark:hover:bg-violet-900/50 transition-colors"
                      title={`Load preset: ${preset.name} (${preset.filters.length} filter${preset.filters.length !== 1 ? "s" : ""})`}
                    >
                      {preset.name}
                    </button>
                  )}
                  <button
                    onClick={() => updatePreset(preset.id)}
                    className="p-0.5 text-neutral-300 hover:text-blue-500 dark:text-neutral-600 dark:hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-all"
                    title="Overwrite with current filters"
                  >
                    <Save className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => startRenamePreset(preset)}
                    className="p-0.5 text-neutral-300 hover:text-amber-500 dark:text-neutral-600 dark:hover:text-amber-400 opacity-0 group-hover:opacity-100 transition-all"
                    title="Rename"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => deletePreset(preset.id)}
                    className="p-0.5 text-neutral-300 hover:text-red-500 dark:text-neutral-600 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                    title="Delete preset"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {filters.length === 0 && (
            <p className="text-xs text-neutral-400">
              No filters applied. Click &quot;Add Filter&quot; to get started.
            </p>
          )}

          {filters.map((f) => (
            <div key={f.id} className="flex items-center gap-2 flex-wrap">
              <select
                value={f.column}
                onChange={(e) =>
                  updateFilter(f.id, {
                    column: e.target.value,
                    matchType:
                      e.target.value === "industry" ? "exact" : f.matchType,
                    value: e.target.value === "industry" ? [] : "",
                  })
                }
                className="text-xs border border-neutral-200 dark:border-neutral-700 rounded-lg px-2 py-1.5 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              >
                {COLUMNS.filter((c) => c.key !== "applied").map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>

              <select
                value={f.mode}
                onChange={(e) =>
                  updateFilter(f.id, {
                    mode: e.target.value as FilterMode,
                  })
                }
                className="text-xs border border-neutral-200 dark:border-neutral-700 rounded-lg px-2 py-1.5 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              >
                <option value="include">Include</option>
                <option value="exclude">Exclude</option>
              </select>

              {f.column === "industry" ? (
                <div className="flex-1 min-w-45">
                  <select
                    multiple
                    value={Array.isArray(f.value) ? f.value : f.value ? [f.value] : []}
                    onChange={(e) =>
                      updateFilter(f.id, {
                        value: Array.from(e.target.selectedOptions).map((o) => o.value),
                      })
                    }
                    className="w-full text-xs border border-neutral-200 dark:border-neutral-700 rounded-lg px-2 py-1.5 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                    size={Math.min(6, Math.max(3, industryOptions.length || 3))}
                    title="Hold Ctrl/Cmd to select multiple"
                  >
                    {industryOptions.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <>
                  <select
                    value={f.matchType}
                    onChange={(e) =>
                      updateFilter(f.id, {
                        matchType: e.target.value as MatchType,
                      })
                    }
                    className="text-xs border border-neutral-200 dark:border-neutral-700 rounded-lg px-2 py-1.5 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  >
                    <option value="contains">Contains</option>
                    <option value="exact">Exact</option>
                    <option value="regex">Regex</option>
                  </select>

                  <input
                    type="text"
                    value={typeof f.value === "string" ? f.value : ""}
                    onChange={(e) =>
                      updateFilter(f.id, { value: e.target.value })
                    }
                    placeholder={f.matchType === "exact" ? "Exact value..." : f.matchType === "regex" ? "Regex pattern..." : "Type to filter..."}
                    className="flex-1 min-w-45 text-xs border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-1.5 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  />
                </>
              )}

              <button
                onClick={() => removeFilter(f.id)}
                className="p-1 text-red-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Table ─────────────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden flex-1 min-h-0 flex flex-col">
        {/* Sticky header */}
        <div ref={headerScrollRef} className="overflow-x-auto overflow-y-hidden">
          <table className="w-full" style={{ minWidth: tableMinWidth }}>
            <thead>
              <tr className="bg-neutral-50 dark:bg-neutral-800/80 border-b border-neutral-200 dark:border-neutral-700">
                <th
                  className="relative px-3 py-3 text-left text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider select-none"
                  style={{
                    width: columnWidths[ROW_NUMBER_COLUMN_KEY] ?? ROW_NUMBER_DEFAULT_WIDTH,
                    minWidth: columnWidths[ROW_NUMBER_COLUMN_KEY] ?? ROW_NUMBER_DEFAULT_WIDTH,
                    maxWidth: columnWidths[ROW_NUMBER_COLUMN_KEY] ?? ROW_NUMBER_DEFAULT_WIDTH,
                  }}
                >
                  <div className="pr-2">No.</div>
                  <button
                    type="button"
                    aria-label="Resize row number column"
                    onMouseDown={(e) => startResize(ROW_NUMBER_COLUMN_KEY, e)}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-0 h-full w-2 cursor-col-resize select-none touch-none hover:bg-blue-500/15"
                    title="Drag to resize"
                  >
                    <span className="absolute inset-y-2 right-1 w-px bg-neutral-300 dark:bg-neutral-600" />
                  </button>
                </th>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className="relative px-3 py-3 text-left text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider cursor-pointer select-none hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
                    style={{
                      width: columnWidths[col.key] ?? col.defaultWidth,
                      minWidth: columnWidths[col.key] ?? col.defaultWidth,
                      maxWidth: columnWidths[col.key] ?? col.defaultWidth,
                    }}
                  >
                    <div className="flex items-center gap-1 pr-2">
                      {col.label}
                      {sortColumn === col.key ? (
                        sortDirection === "asc" ? (
                          <ChevronUp className="w-3.5 h-3.5 text-blue-500" />
                        ) : sortDirection === "desc" ? (
                          <ChevronDown className="w-3.5 h-3.5 text-blue-500" />
                        ) : (
                          <ChevronsUpDown className="w-3 h-3 opacity-30" />
                        )
                      ) : (
                        <ChevronsUpDown className="w-3 h-3 opacity-30" />
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label={`Resize ${col.label} column`}
                      onMouseDown={(e) => startResize(col.key, e)}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute right-0 top-0 h-full w-2 cursor-col-resize select-none touch-none hover:bg-blue-500/15"
                      title="Drag to resize"
                    >
                      <span className="absolute inset-y-2 right-1 w-px bg-neutral-300 dark:bg-neutral-600" />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
          </table>
        </div>

        {/* Virtualized scrollable body */}
        <div ref={bodyContainerRef} className="flex-1 min-h-0">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20">
              <RefreshCw className="w-6 h-6 animate-spin text-blue-500" />
              <span className="text-sm text-neutral-500">
                Loading jobs...
              </span>
            </div>
          ) : tableRows.length === 0 ? (
            <div className="flex items-center justify-center py-20 text-neutral-400 text-sm">
              No jobs found. Try adjusting your filters or refresh.
            </div>
          ) : (
            <List<VirtualRowData>
              style={{ width: "100%", height: containerHeight, overflow: "auto" }}
              rowCount={tableRows.length}
              rowHeight={VIRTUAL_ROW_HEIGHT}
              overscanCount={10}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              rowComponent={VirtualRow as any}
              rowProps={virtualListData}
              onScroll={(e) => {
                if (headerScrollRef.current) {
                  headerScrollRef.current.scrollLeft = e.currentTarget.scrollLeft;
                }
              }}
            />
          )}
        </div>
      </div>

      {/* ── Source Modal ────────────────────────────────────────────────────── */}
      {sourceModalJob && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setSourceModalJob(null); }}
        >
          <div className="relative w-full max-w-xl max-h-[85vh] overflow-y-auto mx-4 rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 rounded-t-2xl">
              <div className="min-w-0">
                <h2 className="text-lg font-bold tracking-tight truncate">{sourceModalJob.company || "Source"}</h2>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 truncate">
                  {sourceModalJob.title}
                </p>
              </div>
              <button
                onClick={() => setSourceModalJob(null)}
                className="p-1.5 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                title="Close"
              >
                <X className="w-5 h-5 text-neutral-500" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">JobRight ID</div>
                  <div className="font-medium break-all">{sourceModalJob.jobrightId || "not provided"}</div>
                </div>
                <div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">Score</div>
                  <div className="font-medium">
                    {typeof sourceModalJob.matchScore === "number" ? `${sourceModalJob.matchScore}%` : "not provided"}
                  </div>
                </div>
                <div className="col-span-2">
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">Eligibility</div>
                  <div className={`font-medium ${sourceModalJob.notEligible ? "text-rose-600 dark:text-rose-300" : ""}`}>
                    {sourceModalJob.notEligible ? formatNotEligibleReason(sourceModalJob.notEligibleReason) : "Eligible"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">H1B sponsor</div>
                  <div className="font-medium">{formatBooleanValue(sourceModalJob.isH1bSponsor)}</div>
                </div>
                <div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">Citizen only</div>
                  <div className="font-medium">{formatBooleanValue(sourceModalJob.isCitizenOnly)}</div>
                </div>
                <div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">Min salary</div>
                  <div className="font-medium">{formatMoneyValue(sourceModalJob.minSalary)}</div>
                </div>
                <div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">Max salary</div>
                  <div className="font-medium">{formatMoneyValue(sourceModalJob.maxSalary)}</div>
                </div>
              </div>

              <div className="space-y-2">
                {(sourceModalJob.sourceDetails?.length ? sourceModalJob.sourceDetails : [{
                  label: sourceModalJob.sourceLabel || "Source",
                  kind: sourceModalJob.sourceKind || "",
                  repo: sourceModalJob.sourceRepo || "",
                  url: "",
                  key: "",
                  jobrightId: sourceModalJob.jobrightId || "",
                }]).map((source, idx) => (
                  <div
                    key={`${source.key || source.label || "source"}-${idx}`}
                    className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 text-sm"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium truncate">{source.label || source.key || "Source"}</span>
                      <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400">
                        {source.kind || "unknown"}
                      </span>
                    </div>
                    {source.repo && (
                      <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400 break-all">
                        {source.repo}
                      </div>
                    )}
                    {source.url && (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        <ExternalLink className="w-3 h-3" /> Open source
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Resume Modal ───────────────────────────────────────────────────── */}
      {resumeModalOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) closeResumeModal(); }}
        >
          <div className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto mx-4 rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-2xl">
            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 rounded-t-2xl">
              <div>
                <h2 className="text-lg font-bold tracking-tight">Resume PDF Builder</h2>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                  Enter LaTeX resume content. Files are saved under a folder named with the encoded URL.
                </p>
              </div>
              <button
                onClick={closeResumeModal}
                className="p-1.5 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              >
                <X className="w-5 h-5 text-neutral-500" />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-4">
              {resumeJobUrl && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700">
                  <ExternalLink className="w-3.5 h-3.5 shrink-0 text-neutral-400" />
                  <span className="text-xs text-neutral-600 dark:text-neutral-300 truncate" title={resumeJobUrl}>{resumeJobUrl}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="resume-modal-latex" className="block text-sm font-medium">
                  Resume LaTeX
                </label>
                <textarea
                  id="resume-modal-latex"
                  placeholder={"\\documentclass{article}\n\\begin{document}\nHello Resume\n\\end{document}"}
                  value={resumeLatex}
                  onChange={(e) => setResumeLatex(e.target.value)}
                  className="w-full min-h-[320px] rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  required
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void submitResume()}
                  disabled={resumeSubmitting || !resumeJobUrl.trim() || !resumeLatex.trim()}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                >
                  {resumeSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <FileText className="w-4 h-4" />
                      Generate Resume
                    </>
                  )}
                </button>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  Requires pdflatex available in your PATH.
                </span>
              </div>

              {resumeError && (
                <div className="rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 p-3">
                  <p className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap">{resumeError}</p>
                </div>
              )}

              {resumeResult && (
                <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/20 p-4 space-y-2">
                  <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    resume.pdf + profile.json generated successfully
                  </p>
                  <p className="text-xs text-neutral-700 dark:text-neutral-300">
                    Folder: <code className="bg-neutral-100 dark:bg-neutral-800 px-1 rounded">{resumeResult.folderPath}</code>
                  </p>
                  <p className="text-xs text-neutral-700 dark:text-neutral-300">
                    PDF: <code className="bg-neutral-100 dark:bg-neutral-800 px-1 rounded">{resumeResult.files.pdf}</code> ({resumeResult.pdfBytes} bytes)
                  </p>
                  <p className="text-xs text-neutral-700 dark:text-neutral-300">
                    Profile JSON: <code className="bg-neutral-100 dark:bg-neutral-800 px-1 rounded">{resumeResult.files.profile}</code> ({resumeResult.profileBytes} bytes)
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <a
                      href={resumeResult.links.resume_download}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-xs font-medium hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
                    >
                      <FileText className="w-3.5 h-3.5" /> Download PDF
                    </a>
                    <a
                      href={resumeResult.links.resume_preview}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 text-xs font-medium hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" /> Preview PDF
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
