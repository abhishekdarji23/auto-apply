"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";

type AtsRecord = {
  _id: string;
  atsId: string;
  atsName: string;
  enabled: boolean;
  updatedAt: string;
};

export default function AutomationsPage() {
  const [automations, setAutomations] = useState<AtsRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggleLoading, setToggleLoading] = useState<string | null>(null);

  // ── Load automations ────────────────────────────────────────────────────────
  async function fetchAutomations() {
    setLoading(true);
    try {
      const res = await fetch("/api/automations");
      const data = (await res.json()) as { automations: AtsRecord[] };
      setAutomations(data.automations ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchAutomations(); }, []);

  // ── Toggle enabled ──────────────────────────────────────────────────────────
  async function handleToggle(atsId: string, current: boolean) {
    setToggleLoading(atsId);
    try {
      await fetch(`/api/automations/${atsId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !current }),
      });
      setAutomations((prev) =>
        prev.map((a) => (a.atsId === atsId ? { ...a, enabled: !current } : a))
      );
    } finally {
      setToggleLoading(null);
    }
  }

  return (
    <main className="h-screen overflow-y-auto bg-neutral-50 dark:bg-neutral-950">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">ATS Automations</h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
              Toggle auto-apply on or off per ATS. Resumes are managed per-job via the Resume Builder.
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

        {/* ATS table */}
        {loading ? (
          <div className="flex items-center gap-2 text-neutral-400 text-sm py-10">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
          </div>
        ) : (
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900">
                  <th className="text-left px-4 py-3 font-medium text-neutral-600 dark:text-neutral-400">ATS</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600 dark:text-neutral-400">Enabled</th>
                </tr>
              </thead>
              <tbody>
                {automations.map((ats, i) => (
                  <tr
                    key={ats.atsId}
                    className={`${i !== automations.length - 1 ? "border-b border-neutral-200 dark:border-neutral-800" : ""} bg-white dark:bg-neutral-950 hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors`}
                  >
                    {/* ATS name */}
                    <td className="px-4 py-3 font-medium">{ats.atsName}</td>

                    {/* Toggle */}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleToggle(ats.atsId, ats.enabled)}
                        disabled={toggleLoading === ats.atsId}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                          ats.enabled
                            ? "bg-blue-500"
                            : "bg-neutral-300 dark:bg-neutral-700"
                        } ${toggleLoading === ats.atsId ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                        aria-label={`Toggle ${ats.atsName} automation`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                            ats.enabled ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
