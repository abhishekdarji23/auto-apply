/**
 * Job classifier using Jev AI (TypeSafe AI) — System One model.
 * ESM version for Node.js scripts (backfill, github-jobs, etc.)
 *
 * Uses a `choice` question to pick 1 of 15 categories for a job title.
 * Confidence threshold: >= 0.80 → assigned category, else "others".
 *
 * Requires: TYPESAFE_API_KEY in environment.
 */

import { TypeSafeClient, choice } from "@typesafe-ai/sdk";

export const CATEGORIES = [
  { id: "ai_ml",                  label: "Artificial Intelligence & Machine Learning", priority: 1  },
  { id: "applied_research",       label: "AI Research & Applied Science",              priority: 2  },
  { id: "data_science_analytics", label: "Data Science & Analytics",                   priority: 3  },
  { id: "data_engineering",       label: "Data Engineering & Pipelines",               priority: 4  },
  { id: "backend_engineering",    label: "Backend Software Engineering",               priority: 5  },
  { id: "frontend_fullstack",     label: "Frontend & Full Stack Engineering",          priority: 6  },
  { id: "general_swe",            label: "General Software Engineering & Developer",   priority: 7  },
  { id: "quant_finance",          label: "Quantitative Finance & Trading",             priority: 8  },
  { id: "devops_cloud_sre",       label: "DevOps, SRE & Cloud Infrastructure",        priority: 9  },
  { id: "embedded_hardware",      label: "Embedded, Systems & Hardware Engineering",  priority: 10 },
  { id: "cybersecurity",          label: "Cybersecurity & Information Security",      priority: 11 },
  { id: "qa_sdet",                label: "QA & SDET (Software Test Engineering)",     priority: 12 },
  { id: "product_management",     label: "Product & Technical Program Management",    priority: 13 },
  { id: "business_tech_analyst",  label: "Business & Technology Analyst",             priority: 14 },
  { id: "others",                 label: "Others",                                    priority: 15 },
];

export const OTHERS_CATEGORY = CATEGORIES.find((c) => c.id === "others");

const CATEGORY_MAP = new Map(CATEGORIES.map((c) => [c.id, c]));
const CONFIDENCE_THRESHOLD = 0.80;

// Build the choice options object once — Jev AI needs { id: null } shape
const CHOICE_OPTIONS = Object.fromEntries(CATEGORIES.map((c) => [c.id, null]));

// Lazy-init singleton client
let _client = null;
function getClient() {
  if (!_client) {
    _client = new TypeSafeClient({
      apiKey: process.env.TYPESAFE_API_KEY,
    });
  }
  return _client;
}

const OTHERS_RESULT = {
  category: "others",
  categoryLabel: "Others",
  categoryConfidence: 0,
  categoryPriority: 15,
};

/**
 * Classify a job title using Jev AI.
 * Returns the category with >= 80% confidence, else "others".
 *
 * @param {string} title
 * @param {{ roleType?: string, jobFunction?: string }} [context]
 * @returns {Promise<{ category: string, categoryLabel: string, categoryConfidence: number, categoryPriority: number }>}
 */
export async function classifyJobTitle(title, context = {}) {
  const cleanTitle = (title || "").trim();
  if (!cleanTitle) return OTHERS_RESULT;

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.warn("[jobClassifier] TYPESAFE_API_KEY not set — returning 'others'");
    return OTHERS_RESULT;
  }

  try {
    const state = { jobTitle: cleanTitle };
    if (context?.roleType) state.roleType = context.roleType;
    if (context?.jobFunction) state.jobFunction = context.jobFunction;

    const client = getClient();
    const response = await client.systemOne({
      state,
      questions: {
        category: choice(
          "Which category best describes this job title? Pick the most specific match.",
          CHOICE_OPTIONS
        ),
      },
    });

    const picked = response.answers.category.choice;
    const confidence = response.answers.category.probabilities?.[picked] ?? 0;

    if (confidence >= CONFIDENCE_THRESHOLD) {
      const cat = CATEGORY_MAP.get(picked);
      return {
        category: cat.id,
        categoryLabel: cat.label,
        categoryConfidence: confidence,
        categoryPriority: cat.priority,
      };
    }

    // Below 80% confidence → "others"
    return {
      ...OTHERS_RESULT,
      categoryConfidence: confidence,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[jobClassifier] Jev AI error for title="${cleanTitle}": ${msg}`);
    return OTHERS_RESULT;
  }
}
