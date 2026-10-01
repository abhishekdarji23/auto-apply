import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Job from "@/models/Job";
import { detectATS } from "@/lib/ats-map";
import { CATEGORIES } from "@/lib/jobClassifier";

export const runtime = "nodejs";

type AtsFilterType = "all" | "greenhouse" | "workday" | "other";

function getAtsCategory(url: string): "greenhouse" | "workday" | "other" {
  const atsId = detectATS(url)?.id || "";
  if (atsId === "greenhouse") return "greenhouse";
  if (atsId === "workday") return "workday";
  return "other";
}

function formatDateKey(dateInput?: string | Date | null): string {
  if (!dateInput) return "Unknown";
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return "Unknown";
  // Format as YYYY-MM-DD
  return d.toISOString().split("T")[0];
}

export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const { searchParams } = new URL(request.url);
    const daysParam = searchParams.get("days") || "30";
    const atsFilter = (searchParams.get("ats") || "all").toLowerCase() as AtsFilterType;
    const categoryFilter = searchParams.get("category") || "all";

    const days = parseInt(daysParam, 10);
    const hasDaysLimit = !isNaN(days) && days > 0;

    let startDate: Date | null = null;
    if (hasDaysLimit) {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      startDate.setHours(0, 0, 0, 0);
    }

    // Projection for light memory footprint
    const rawJobs = await Job.find(
      { inactive: { $ne: true } },
      {
        _id: 0,
        jobId: 1,
        applyLink: 1,
        postedAt: 1,
        fetchedAt: 1,
        category: 1,
        categoryLabel: 1,
        categoryPriority: 1,
      }
    ).lean();

    // Map categories for reference
    const categoryMetaMap = new Map(
      CATEGORIES.map((c) => [c.id, { label: c.label, priority: c.priority }])
    );

    const dailyMap = new Map<
      string,
      {
        date: string;
        total: number;
        greenhouse: number;
        workday: number;
        other: number;
        byCategory: Record<string, number>;
      }
    >();

    const categoryStatsMap = new Map<
      string,
      {
        category: string;
        categoryLabel: string;
        categoryPriority: number;
        count: number;
        greenhouseCount: number;
        workdayCount: number;
        otherCount: number;
      }
    >();

    let totalJobs = 0;
    let greenhouseJobs = 0;
    let workdayJobs = 0;
    let otherJobs = 0;

    for (const job of rawJobs) {
      const dateVal = job.postedAt || job.fetchedAt;
      if (!dateVal) continue;

      const jobDate = new Date(dateVal);
      if (isNaN(jobDate.getTime())) continue;

      // Filter by date range if specified
      if (startDate && jobDate < startDate) {
        continue;
      }

      const url = String(job.applyLink || "").trim();
      const atsType = getAtsCategory(url);

      // Apply ATS filter if requested
      if (atsFilter !== "all" && atsType !== atsFilter) {
        continue;
      }

      const catId = job.category || "others";
      const catLabel = job.categoryLabel || "Others";
      const catPriority =
        typeof job.categoryPriority === "number" && Number.isFinite(job.categoryPriority)
          ? job.categoryPriority
          : 15;

      // Apply Category filter if requested
      if (categoryFilter !== "all" && catId !== categoryFilter && catLabel !== categoryFilter) {
        continue;
      }

      const dateKey = formatDateKey(jobDate);

      // Update Daily Aggregation
      let dayItem = dailyMap.get(dateKey);
      if (!dayItem) {
        dayItem = {
          date: dateKey,
          total: 0,
          greenhouse: 0,
          workday: 0,
          other: 0,
          byCategory: {},
        };
        dailyMap.set(dateKey, dayItem);
      }

      dayItem.total += 1;
      dayItem[atsType] += 1;
      dayItem.byCategory[catLabel] = (dayItem.byCategory[catLabel] || 0) + 1;

      // Update Overall Totals
      totalJobs += 1;
      if (atsType === "greenhouse") greenhouseJobs += 1;
      else if (atsType === "workday") workdayJobs += 1;
      else otherJobs += 1;

      // Update Category Stats
      let catStat = categoryStatsMap.get(catId);
      if (!catStat) {
        catStat = {
          category: catId,
          categoryLabel: catLabel,
          categoryPriority: catPriority,
          count: 0,
          greenhouseCount: 0,
          workdayCount: 0,
          otherCount: 0,
        };
        categoryStatsMap.set(catId, catStat);
      }
      catStat.count += 1;
      if (atsType === "greenhouse") catStat.greenhouseCount += 1;
      else if (atsType === "workday") catStat.workdayCount += 1;
      else catStat.otherCount += 1;
    }

    // Sort daily data chronologically (oldest to newest for graph)
    const dailyData = Array.from(dailyMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    // Format Category Breakdown (sorted by priority)
    const categoryBreakdown = Array.from(categoryStatsMap.values())
      .map((c) => ({
        ...c,
        percentage: totalJobs > 0 ? Math.round((c.count / totalJobs) * 1000) / 10 : 0,
      }))
      .sort((a, b) => a.categoryPriority - b.categoryPriority);

    return NextResponse.json({
      success: true,
      filters: {
        days,
        ats: atsFilter,
        category: categoryFilter,
      },
      summary: {
        totalJobs,
        greenhouseJobs,
        workdayJobs,
        otherJobs,
        greenhousePercent: totalJobs > 0 ? Math.round((greenhouseJobs / totalJobs) * 1000) / 10 : 0,
        workdayPercent: totalJobs > 0 ? Math.round((workdayJobs / totalJobs) * 1000) / 10 : 0,
        otherPercent: totalJobs > 0 ? Math.round((otherJobs / totalJobs) * 1000) / 10 : 0,
        totalDays: dailyData.length,
        avgJobsPerDay: dailyData.length > 0 ? Math.round(totalJobs / dailyData.length) : 0,
      },
      dailyData,
      categoryBreakdown,
      categoriesList: CATEGORIES,
    });
  } catch (error) {
    console.error("Error in /api/analytics/job-fetch:", error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
