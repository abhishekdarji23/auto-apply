import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAtsLlmAnswers } from "../../AI/ats-llm-client.mjs";

/**
 * @param {object} params
 * @returns {Promise<{answers: Array, rawContent: string|null, parsed?: Array, messages?: Array}>}
 */
export async function getGreenhouseLlmAnswers(params) {
    const llmResult = await getAtsLlmAnswers(params);

    const outDir = path.join(process.cwd(), "scripts", "ats", "debug");
    mkdirSync(outDir, { recursive: true });

    const latestCallFile = path.join(outDir, "greenhouse-latest-llm-call.json");
    const latestPromptFile = path.join(outDir, "greenhouse-latest-llm-prompt.json");
    const latestFullResponseFile = path.join(outDir, "greenhouse-latest-llm-full-response.json");

    const llmCallPayload = {
        generatedAt: new Date().toISOString(),
        atsName: String(params?.atsName || "greenhouse"),
        jobTitle: String(params?.jobTitle || ""),
        questionsCount: Array.isArray(params?.questions) ? params.questions.length : 0,
        questionIds: Array.isArray(params?.questions) ? params.questions.map((q) => q?.id).filter(Boolean) : [],
        answersCount: Array.isArray(llmResult?.answers) ? llmResult.answers.length : 0,
        answers: llmResult?.answers || [],
    };

    const llmPromptPayload = {
        generatedAt: new Date().toISOString(),
        atsName: String(params?.atsName || "greenhouse"),
        jobTitle: String(params?.jobTitle || ""),
        messages: Array.isArray(llmResult?.messages) ? llmResult.messages : [],
    };

    const llmFullPayload = {
        generatedAt: new Date().toISOString(),
        atsName: String(params?.atsName || "greenhouse"),
        jobTitle: String(params?.jobTitle || ""),
        messages: Array.isArray(llmResult?.messages) ? llmResult.messages : [],
        answers: llmResult?.answers || [],
        parsed: llmResult?.parsed || [],
        rawContent: llmResult?.rawContent || null,
    };

    writeFileSync(latestCallFile, JSON.stringify(llmCallPayload, null, 2), "utf8");
    writeFileSync(latestPromptFile, JSON.stringify(llmPromptPayload, null, 2), "utf8");
    writeFileSync(latestFullResponseFile, JSON.stringify(llmFullPayload, null, 2), "utf8");

    console.error(`[greenhouse:llm] Saved latest call: ${latestCallFile}`);
    console.error(`[greenhouse:llm] Saved latest prompt: ${latestPromptFile}`);
    console.error(`[greenhouse:llm] Saved full response: ${latestFullResponseFile}`);

    return llmResult;
}
