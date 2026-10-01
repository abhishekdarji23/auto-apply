import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAtsLlmAnswers } from "../../AI/ats-llm-client.mjs";

/**
 * Call the LLM for a Workday application step and persist all artifacts.
 * Mirrors the greenhouse llm.mjs pattern exactly.
 *
 * @param {object} params  — same shape as getAtsLlmAnswers
 * @param {string} [stepName] — e.g. "information", "experience" (used in filenames)
 * @returns {Promise<{answers: Array, rawContent: string|null, parsed?: Array, messages?: Array}>}
 */
export async function getWorkdayLlmAnswers(params, stepName = "step") {
    const llmResult = await getAtsLlmAnswers({ ...params, jobUrl: params.jobUrl || "" });

    const outDir = path.join(process.cwd(), "scripts", "ats", "debug");
    mkdirSync(outDir, { recursive: true });

    const responseFile = path.join(outDir, "workday-llm-response.latest.json");

    writeFileSync(responseFile, JSON.stringify({
        generatedAt: new Date().toISOString(),
        atsName: String(params?.atsName || "workday"),
        jobTitle: String(params?.jobTitle || ""),
        stepName: String(stepName || "step").replace(/[^a-z0-9_-]/gi, "-").toLowerCase(),
        questionsCount: Array.isArray(params?.questions) ? params.questions.length : 0,
        answersCount: Array.isArray(llmResult?.answers) ? llmResult.answers.length : 0,
        answers: llmResult?.answers || [],
        messages: Array.isArray(llmResult?.messages) ? llmResult.messages : [],
        parsed: llmResult?.parsed || [],
        rawContent: llmResult?.rawContent || null,
    }, null, 2), "utf8");

    console.error(`[workday:llm] Saved LLM response: ${responseFile}`);

    return llmResult;
}

