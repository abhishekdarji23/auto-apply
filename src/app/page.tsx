import { ThemeToggle } from "@/components/ThemeToggle";
import JobTable from "@/components/JobTable";
import { Briefcase } from "lucide-react";
import Link from "next/link";

export default function Home() {
  return (
    <main className="h-screen overflow-hidden flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-white/80 dark:bg-neutral-950/80 border-b border-neutral-200 dark:border-neutral-800">
        <div className="w-full px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-linear-to-br from-blue-500 to-violet-600 flex items-center justify-center">
              <Briefcase className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">JobTrack</h1>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400 -mt-0.5">
                SWE Internship Tracker
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/job-fetch"
              className="px-3 py-1.5 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 text-xs font-medium hover:bg-indigo-100 dark:hover:bg-indigo-900/60 transition-colors"
            >
              Job-Fetch Analytics
            </Link>
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
              href="/resume"
              className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              Resume Builder
            </Link>
            <Link
              href="/automations"
              className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              Automations
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="w-full px-4 sm:px-6 py-4 flex-1 min-h-0 overflow-hidden">
        <JobTable />
      </div>
    </main>
  );
}
