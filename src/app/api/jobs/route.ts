import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Job from "@/models/Job";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000000;
const ALLOWED_SORT_FIELDS = new Set([
  "postedAt",
  "title",
  "company",
  "recruiterName",
  "location",
  "applied",
  "manualApplied",
  "autoApplied",
  "appliedAt",
  "manualAppliedAt",
  "autoAppliedAt",
  "h1bSponsored",
  "companyRank",
  "sourceKind",
  "sourceRepo",
  "sourceLabel",
  "minSalary",
  "maxSalary",
]);

export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const searchParams = request.nextUrl.searchParams;
    const pageRaw = parseInt(searchParams.get("page") || "1");
    const limitRaw = parseInt(searchParams.get("limit") || String(DEFAULT_LIMIT));
    const skipRaw = searchParams.get("skip");
    const requestedSortField = searchParams.get("sortField") || "postedAt";
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;
    const skip =
      skipRaw !== null && Number.isFinite(parseInt(skipRaw))
        ? Math.max(0, parseInt(skipRaw))
        : (page - 1) * limit;
    const sortFieldRaw = ALLOWED_SORT_FIELDS.has(requestedSortField)
      ? requestedSortField
      : "postedAt";
    const sortField =
      sortFieldRaw === "applied"
        ? "manualApplied"
        : sortFieldRaw === "appliedAt"
          ? "manualAppliedAt"
          : sortFieldRaw;
    const sortOrder = searchParams.get("sortOrder") || "desc";
    const appliedFilter = searchParams.get("applied"); // "true", "false", or null for all
    const notInterestedFilter = searchParams.get("notInterested"); // "true" or null
    const inactiveFilter = searchParams.get("inactive"); // "true", "false", or null for all
    const notEligibleFilter = searchParams.get("notEligible"); // "true", "false", or null for all
    const withTotalParam = searchParams.get("withTotal");
    const withTotal = withTotalParam !== "0" && withTotalParam !== "false";

    // Build filter query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter: Record<string, any> = {};

    if (notInterestedFilter === "true") {
      filter.notInterested = true;
    } else if (appliedFilter === "true") {
      filter.manualApplied = true;
    } else if (appliedFilter === "false") {
      // Not-applied means "never acted on": neither applied nor skipped.
      filter.manualApplied = { $ne: true };
      filter.notInterested = { $ne: true };
    }

    const statusGroup = searchParams.get("statusGroup");
    if (statusGroup === "active") {
      filter.inactive = { $ne: true };
      filter.notEligible = { $ne: true };
    } else if (statusGroup === "inactive_or_not_eligible") {
      filter.$or = [{ inactive: true }, { notEligible: true }];
    } else {
      if (inactiveFilter === "true") {
        filter.inactive = true;
      } else if (inactiveFilter === "false") {
        filter.inactive = { $ne: true };
      }

      if (notEligibleFilter === "true") {
        filter.notEligible = true;
      } else if (notEligibleFilter === "false") {
        filter.notEligible = { $ne: true };
      }
    }

    const sort: Record<string, 1 | -1> = {
      [sortField]: sortOrder === "asc" ? 1 : -1,
    };

    const includeDetails = searchParams.get("includeDetails") === "true" || searchParams.get("includeDetails") === "1";

    // Return only fields currently used by the table UI (exclude heavy arrays unless requested).
    const projection: Record<string, 1 | 0> = {
      _id: 0,
      jobId: 1,
      title: 1,
      company: 1,
      location: 1,
      postedAt: 1,
      applied: 1,
      appliedAt: 1,
      autoApplied: 1,
      autoAppliedAt: 1,
      manualApplied: 1,
      manualAppliedAt: 1,
      notInterested: 1,
      h1bSponsored: 1,
      industry: 1,
      top500: 1,
      companyRank: 1,
      matchScore: 1,
      jobrightId: 1,
      sourceTags: 1,
      sourceKind: 1,
      sourceRepo: 1,
      sourceLabel: 1,
      isH1bSponsor: 1,
      isCitizenOnly: 1,
      minSalary: 1,
      maxSalary: 1,
      notEligible: 1,
      notEligibleReason: 1,
      eligibilityStatus: 1,
      applyLink: 1,
      recruiterName: 1,
      recruiterProfileUrl: 1,
      detailsFetchedAt: 1,
      detailsFetchStatus: 1,
      inactive: 1,
      category: 1,
      categoryLabel: 1,
      categoryPriority: 1,
      categoryConfidence: 1,
    };

    if (includeDetails) {
      projection.sourceDetails = 1;
      projection.jobrightAliases = 1;
    }

    const jobsQuery = Job.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select(projection)
      .lean();

    const [rawJobs, total, overallTotal] = await Promise.all([
      jobsQuery,
      withTotal ? Job.countDocuments(filter) : Promise.resolve(-1),
      withTotal ? Job.estimatedDocumentCount() : Promise.resolve(-1),
    ]);

    const jobs = rawJobs.map((job) => ({
      ...job,
      applied: Boolean(job.manualApplied),
      appliedAt: job.manualAppliedAt ?? null,
    }));
    const totalCount = total >= 0 ? total : jobs.length;

    return NextResponse.json({
      jobs,
      total: totalCount,
      overallTotal: overallTotal >= 0 ? overallTotal : totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit),
    });
  } catch (error) {
    console.error("Get jobs error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
