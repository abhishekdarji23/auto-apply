import Job from "@/models/Job";
import { normalizeJobUrlForStorage } from "@/lib/jobUrlNormalization";

const URL_NORMALIZE_REGEX = /(greenhouse\.io|gh_jid=|token=\d+|utm_source=jobright)/i;

export async function normalizeStoredJobUrls(): Promise<number> {
  const candidates = await Job.find(
    { applyLink: { $regex: URL_NORMALIZE_REGEX } },
    { _id: 1, applyLink: 1 }
  ).lean();

  if (candidates.length === 0) return 0;

  const bulkOps: Array<{
    updateOne: {
      filter: { _id: typeof candidates[number]["_id"] };
      update: { $set: { applyLink: string } };
    };
  }> = [];
  for (const candidate of candidates) {
    const nextApply = normalizeJobUrlForStorage(String(candidate.applyLink || ""));
    if (nextApply === String(candidate.applyLink || "")) continue;
    bulkOps.push({
      updateOne: {
        filter: { _id: candidate._id },
        update: { $set: { applyLink: nextApply } },
      },
    });
  }

  if (bulkOps.length === 0) return 0;

  const result = await Job.bulkWrite(bulkOps, { ordered: false });
  return result.modifiedCount || 0;
}
