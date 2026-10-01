import axios from "axios";
import { jsonrepair } from "jsonrepair";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAtsLlmMessages } from "./ats-llm-prompt.mjs";
import { buildAtsCoverLetterMessages } from "./ats-coverletter-prompt.mjs";
import { getDataPath, loadUserEnv } from "../../lib/user-config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const projectRoot = resolve(__dirname, "..", "..", "..");

// Ensure user environment files (.env.local, .env.<user>.local) are loaded
loadUserEnv(projectRoot);

// Endpoint definitions
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 16384;
const TEMPERATURE = Number(process.env.TEMPERATURE) || 0.1;

const defaultResumePath = getDataPath(projectRoot, "resume.txt");
const defaultCandidateProfilePath = getDataPath(projectRoot, "candidate-profile.json");
const latestLlmCallPath = resolve(__dirname, "latest-llm-call.md");
const latestLlmPromptPath = resolve(__dirname, "latest-llm-prompt.md");
const JOBTRACK_API_ORIGIN = String(process.env.JOBTRACK_API_ORIGIN || (process.env.PORT ? `http://localhost:${process.env.PORT}` : "http://localhost:3000")).replace(/\/+$/, "");

function cleanKey(raw) {
    if (!raw) return "";
    let k = String(raw).trim();
    if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
        k = k.slice(1, -1).trim();
    }
    return k;
}

function maskApiKey(key) {
    const str = String(key || "").trim();
    if (!str) return "none";
    if (str.length <= 8) return `...${str.slice(-2)}`;
    return `...${str.slice(-6)}`;
}

/**
 * Returns all configured Gemini API keys from environment variables.
 * Supports:
 * - GEMINI_API_KEYS (comma, semicolon, or newline separated list)
 * - GEMINI_API_KEY (comma, semicolon, or newline separated list)
 * - GEMINI_API_KEY_1, GEMINI_API_KEY_2, GEMINI_API_KEY_3...
 * - Any other GEMINI_API_KEY_* variable
 * Deduplicates while preserving order.
 */
export function getAllGeminiApiKeys() {
    const collected = [];

    // 1. Numbered environment variables: GEMINI_API_KEY_1, GEMINI_API_KEY_2, ... up to any N
    const numberedEntries = [];
    for (const [envKey, envVal] of Object.entries(process.env)) {
        const match = envKey.match(/^GEMINI_API_KEY_(\d+)$/i);
        if (match) {
            const num = parseInt(match[1], 10);
            const val = cleanKey(envVal);
            if (val) {
                numberedEntries.push({ num, val });
            }
        }
    }
    numberedEntries.sort((a, b) => a.num - b.num);
    for (const item of numberedEntries) {
        collected.push(item.val);
    }

    // 2. Single or comma/newline-separated GEMINI_API_KEY
    if (process.env.GEMINI_API_KEY) {
        for (const part of process.env.GEMINI_API_KEY.split(/[,;\n\r]+/)) {
            const cleaned = cleanKey(part);
            if (cleaned) collected.push(cleaned);
        }
    }

    // 3. GEMINI_API_KEYS (comma / semicolon / newline separated)
    if (process.env.GEMINI_API_KEYS) {
        for (const part of process.env.GEMINI_API_KEYS.split(/[,;\n\r]+/)) {
            const cleaned = cleanKey(part);
            if (cleaned) collected.push(cleaned);
        }
    }

    // 4. Any other GEMINI_API_KEY_* pattern (e.g. GEMINI_API_KEY_BACKUP)
    for (const [envKey, envVal] of Object.entries(process.env)) {
        if (/^GEMINI_API_KEY_[A-Z0-9_]+$/i.test(envKey) && !/^GEMINI_API_KEY_\d+$/i.test(envKey)) {
            const val = cleanKey(envVal);
            if (val) collected.push(val);
        }
    }

    // Deduplicate while preserving order
    const seen = new Set();
    const uniqueKeys = [];
    for (const k of collected) {
        if (!seen.has(k)) {
            seen.add(k);
            uniqueKeys.push(k);
        }
    }
    return uniqueKeys;
}

// Global round-robin index counter for Gemini keys
let roundRobinIndex = 0;

/**
 * Returns the next Gemini API key in round-robin sequence (1 -> 2 -> 3 -> ... -> N -> 1).
 */
export function getNextGeminiKeyInfo(keysList = null) {
    const keys = Array.isArray(keysList) && keysList.length > 0 ? keysList : getAllGeminiApiKeys();
    if (keys.length === 0) {
        throw new Error(
            "No Gemini API keys found. Please set GEMINI_API_KEY (or comma-separated keys, or GEMINI_API_KEY_1, GEMINI_API_KEY_2...) in your .env file."
        );
    }

    const index = roundRobinIndex % keys.length;
    const apiKey = keys[index];
    roundRobinIndex = (roundRobinIndex + 1) % keys.length;

    return {
        apiKey,
        keyIndex: index + 1,
        totalKeys: keys.length,
        maskedKey: maskApiKey(apiKey),
    };
}

/**
 * Returns configuration for Gemini.
 * Model and API keys MUST be defined in environment variables (.env.local / .env.<user>.local).
 */
export function getProviderConfig() {
    const model = String(process.env.GEMINI_MODEL || "").trim();
    if (!model) {
        throw new Error("GEMINI_MODEL is not set in environment (set GEMINI_MODEL=gemini-3.5-flash-lite in your .env file)");
    }

    const keys = getAllGeminiApiKeys();
    if (keys.length === 0) {
        throw new Error("No Gemini API keys found. Set GEMINI_API_KEY_1, GEMINI_API_KEY_2... in your .env file");
    }

    return {
        provider: "gemini",
        model,
        keys,
        totalKeys: keys.length,
        endpoint: `${GEMINI_BASE_URL}/${model}:generateContent`,
    };
}

export const getGeminiConfig = getProviderConfig;

function stripCodeFences(text) {
    const input = String(text ?? "").trim();
    if (!input.startsWith("```")) return input;
    return input.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function extractJsonValue(text) {
    const cleaned = stripCodeFences(text);
    const firstBrace = cleaned.indexOf("{");
    const firstBracket = cleaned.indexOf("[");

    if (firstBrace < 0 && firstBracket < 0) {
        throw new Error("LLM response did not contain JSON payload");
    }

    if (firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace)) {
        const lastBracket = cleaned.lastIndexOf("]");
        if (lastBracket <= firstBracket) {
            throw new Error("LLM response did not contain complete JSON array");
        }
        return cleaned.slice(firstBracket, lastBracket + 1);
    }

    const lastBrace = cleaned.lastIndexOf("}");
    if (lastBrace <= firstBrace) {
        throw new Error("LLM response did not contain complete JSON object");
    }
    return cleaned.slice(firstBrace, lastBrace + 1);
}

function parseLlmJson(text) {
    const rawJson = extractJsonValue(text);
    try {
        return JSON.parse(rawJson);
    } catch {
        return JSON.parse(jsonrepair(rawJson));
    }
}

function getAnswerRows(parsed) {
    if (Array.isArray(parsed)) {
        return parsed;
    }
    if (Array.isArray(parsed?.answers)) {
        return parsed.answers;
    }
    return [];
}

function normalizeKeyPath(value) {
    return String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
}

function fencedBlock(content, language = "") {
    return `\`\`\`\`${language ? language : "text"}\n${String(content ?? "")}\n\`\`\`\``;
}

function stringifyJson(value) {
    try {
        return JSON.stringify(value, null, 2);
    } catch (error) {
        return JSON.stringify({
            serializationError: error instanceof Error ? error.message : String(error),
        }, null, 2);
    }
}

async function writeLatestLlmCallMarkdown({
    provider,
    model,
    endpoint,
    keyInfo,
    atsName,
    jobTitle,
    messages,
    questions,
    finalAnswers,
    elapsedSec,
    error,
}) {
    const questionsSent = Array.isArray(messages)
        ? (() => {
            try {
                const userMessage = messages.find((message) => message?.role === "user");
                const parsedUser = userMessage?.content ? JSON.parse(userMessage.content) : null;
                return Array.isArray(parsedUser?.questions) ? parsedUser.questions.length : 0;
            } catch {
                return 0;
            }
        })()
        : 0;

    const status = error ? "failed" : "ok";
    const elapsedDisplay = typeof elapsedSec === "number" ? `${elapsedSec.toFixed(2)}s` : "n/a";
    const keyDisplay = keyInfo ? `Key ${keyInfo.keyIndex}/${keyInfo.totalKeys} (${keyInfo.maskedKey})` : "n/a";

    const lines = [
        "# Latest LLM Call",
        "",
        `- Generated at: ${new Date().toISOString()}`,
        `- Provider: ${String(provider || "")}`,
        `- Model: ${String(model || "")}`,
        `- Key used: ${keyDisplay}`,
        `- Endpoint: ${String(endpoint || "")}`,
        `- Status: ${status} (${elapsedDisplay})`,
        `- ATS: ${String(atsName || "")}`,
        `- Job title: ${String(jobTitle || "")}`,
        `- Questions sent: ${questionsSent}`,
        "",
        "## Question Wise Answers",
        "",
    ];

    const answerByKey = new Map((finalAnswers || []).map((a) => [a.keyPath, a.answer]));
    const questionList = Array.isArray(questions) ? questions : [];

    for (let i = 0; i < questionList.length; i += 1) {
        const q = questionList[i];
        const label = String(q?.question || q?.labelText || q?.keyPath || `Question ${i + 1}`);
        const qType = String(q?.type || "unknown");
        lines.push(`### Q${i + 1} (${qType})`);
        lines.push(label);
        lines.push("");

        const chosen = answerByKey.get(q.keyPath);
        const chosenDisplay = Array.isArray(chosen) ? chosen.join(" | ") : String(chosen || "");
        lines.push(`- Answer: ${chosenDisplay || "(empty)"}`);
        lines.push("");
    }

    if (error) {
        lines.push("## Error");
        lines.push("");
        lines.push(fencedBlock(String(error), "text"));
        lines.push("");
    }

    const markdown = lines.join("\n");
    await writeFile(latestLlmCallPath, markdown, "utf8");
}

async function writeLatestLlmPromptMarkdown({
    provider,
    model,
    atsName,
    jobTitle,
    messages,
}) {
    let promptQuestions = [];
    try {
        const userMessage = (messages || []).find((message) => message?.role === "user");
        const parsedUser = userMessage?.content ? JSON.parse(userMessage.content) : null;
        promptQuestions = Array.isArray(parsedUser?.questions) ? parsedUser.questions : [];
    } catch {
        promptQuestions = [];
    }

    const lines = [
        "# Latest LLM Prompt",
        "",
        `- Generated at: ${new Date().toISOString()}`,
        `- Provider: ${String(provider || "")}`,
        `- Model: ${String(model || "")}`,
        `- ATS: ${String(atsName || "")}`,
        `- Job title: ${String(jobTitle || "")}`,
        `- Questions count: ${promptQuestions.length}`,
        "",
        "## Question List",
        "",
        ...promptQuestions.map((q, idx) => {
            const qText = String(q?.question || q?.labelText || q?.keyPath || "");
            const qType = String(q?.type || "unknown");
            return `${idx + 1}. (${qType}) ${qText}`;
        }),
        "",
        "## Exact Messages Sent To LLM",
        "",
        fencedBlock(stringifyJson(messages || []), "json"),
        "",
    ];

    await writeFile(latestLlmPromptPath, lines.join("\n"), "utf8");
}

function normalizeOption(question, rawAnswer) {
    const options = Array.isArray(question?.options) ? question.options : [];
    const one = String(rawAnswer ?? "").trim();
    if (!one) return "";
    if (options.includes(one)) return one;

    const oneLower = one.toLowerCase();
    const exactCaseInsensitive = options.find((opt) => String(opt || "").toLowerCase() === oneLower);
    if (exactCaseInsensitive) return exactCaseInsensitive;

    const includesMatch = options.find((opt) => {
        const optText = String(opt || "").toLowerCase();
        return optText.includes(oneLower) || oneLower.includes(optText);
    });

    return includesMatch || "";
}

function normalizeCheckboxOptions(question, rawAnswer) {
    const arr = Array.isArray(rawAnswer) ? rawAnswer : (rawAnswer ? [rawAnswer] : []);
    const matched = arr
        .map((v) => normalizeOption(question, v))
        .filter(Boolean);
    return Array.from(new Set(matched));
}

function normalizeAnswerForQuestion(question, rawAnswer) {
    const qType = String(question?.type || "").toLowerCase();

    if (qType === "checkbox") {
        return normalizeCheckboxOptions(question, rawAnswer);
    }

    if (qType === "choice" || qType === "select") {
        return normalizeOption(question, rawAnswer);
    }

    return String(rawAnswer ?? "").trim();
}

async function fetchResumeTextFromDrive(jobUrl) {
    const normalizedJobUrl = String(jobUrl || "").trim();
    if (!normalizedJobUrl) {
        return "";
    }

    const endpoint = `${JOBTRACK_API_ORIGIN}/api/resume/txt?jobUrl=${encodeURIComponent(normalizedJobUrl)}`;
    try {
        const res = await fetch(endpoint, {
            method: "GET",
            cache: "no-store",
        });
        if (!res.ok) return "";
        const text = await res.text();
        return String(text || "").trim();
    } catch {
        return "";
    }
}

async function readResumeContext(explicitResumeText, jobUrl) {
    if (String(explicitResumeText || "").trim()) {
        return String(explicitResumeText);
    }
    if (jobUrl) {
        const fromDrive = await fetchResumeTextFromDrive(String(jobUrl));
        if (fromDrive) {
            console.error("[llm] Using per-URL resume.txt from Drive");
            return fromDrive;
        }
    }
    try {
        return await readFile(defaultResumePath, "utf8");
    } catch {
        return "";
    }
}

async function readCandidateProfileContext(explicitCandidateProfile) {
    if (explicitCandidateProfile && typeof explicitCandidateProfile === "object") {
        return explicitCandidateProfile;
    }
    if (String(explicitCandidateProfile || "").trim()) {
        try {
            return JSON.parse(String(explicitCandidateProfile));
        } catch {
            return { raw_candidate_profile: String(explicitCandidateProfile) };
        }
    }
    try {
        const content = await readFile(defaultCandidateProfilePath, "utf8");
        return JSON.parse(content);
    } catch {
        return null;
    }
}

function isCoverLetterQuestion(question) {
    const keyPath = String(question?.keyPath || "").toLowerCase();
    const text = String(question?.question || question?.labelText || "").toLowerCase();
    const id = String(question?.id || "").toLowerCase();
    return keyPath.includes("coverletter")
        || keyPath.includes("cover_letter")
        || text.includes("cover letter")
        || id.includes("coverletter");
}

/**
 * Calls Gemini using round-robin key selection.
 * Under normal execution, each call advances to the next key (1 -> 2 -> 3 -> 4 -> 1 ...).
 * If a key hits rate limit (429 / RESOURCE_EXHAUSTED / quota exceeded), it will try the next
 * available round-robin key up to totalKeys times before throwing.
 */
async function callGeminiLlm({
    config,
    messages,
    isJson = true,
    maxTokens = MAX_TOKENS,
    temperature = TEMPERATURE,
}) {
    const systemMsg = (messages || []).find((m) => m.role === "system");
    const userMsg = (messages || []).find((m) => m.role === "user");

    const payload = {
        ...(systemMsg?.content ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
        contents: [
            { role: "user", parts: [{ text: userMsg?.content || "" }] },
        ],
        generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
            ...(isJson ? { responseMimeType: "application/json" } : {}),
        },
    };

    const keys = Array.isArray(config?.keys) && config.keys.length > 0 ? config.keys : getAllGeminiApiKeys();
    const totalKeys = keys.length;
    let lastError = null;

    for (let attempt = 0; attempt < totalKeys; attempt += 1) {
        const keyInfo = getNextGeminiKeyInfo(keys);
        const headers = {
            "Content-Type": "application/json",
            "X-goog-api-key": keyInfo.apiKey,
        };

        try {
            const response = await axios.post(config.endpoint, payload, {
                headers,
                responseType: "json",
            });

            const content = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!content) {
                throw new Error("Gemini response missing text content");
            }

            return {
                content: String(content).trim(),
                rawApiResponse: response?.data ?? null,
                payload,
                keyInfo,
            };
        } catch (err) {
            lastError = err;
            const status = err?.response?.status;
            const errMsg = String(err?.response?.data?.error?.message || err?.message || err);
            const isRateLimit = status === 429 || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.toLowerCase().includes("quota");

            if (isRateLimit && attempt < totalKeys - 1) {
                console.warn(
                    `[Gemini:${config.model}] Key ${keyInfo.keyIndex}/${keyInfo.totalKeys} (${keyInfo.maskedKey}) rate limited (${status || errMsg}). Trying next key in round-robin (attempt ${attempt + 2}/${totalKeys})...`
                );
                continue;
            }

            throw err;
        }
    }

    throw lastError || new Error("Failed to call Gemini across all provided keys");
}

const callProviderLlm = callGeminiLlm;

async function generateCoverLetterText({
    config,
    atsName,
    jobTitle,
    jobDescription,
    resumeContext,
    candidateProfileContext,
}) {
    const messages = buildAtsCoverLetterMessages({
        atsName,
        jobTitle,
        jobDescription,
        resumeText: resumeContext,
        candidateProfile: candidateProfileContext,
    });

    const result = await callGeminiLlm({
        config,
        messages,
        isJson: false,
        maxTokens: MAX_TOKENS,
        temperature: 0.2,
    });

    return {
        text: String(result.content || "").trim(),
        keyInfo: result.keyInfo,
    };
}

function buildAnswerIndex(parsed) {
    const rows = getAnswerRows(parsed);
    const byId = new Map();
    const byKeyPath = new Map();
    const byNormalizedKeyPath = new Map();

    for (const row of rows) {
        const id = String(row?.id ?? "").trim();
        if (id) byId.set(id, row?.answer);

        const keyPath = String(row?.keyPath ?? "").trim();
        if (!keyPath) continue;
        byKeyPath.set(keyPath, row?.answer);
        byNormalizedKeyPath.set(normalizeKeyPath(keyPath), row?.answer);
    }

    return {
        rows,
        byId,
        byKeyPath,
        byNormalizedKeyPath,
    };
}

function getRawAnswerFromIndex(question, index) {
    if (!index) return undefined;
    const qId = String(question?.id ?? "").trim();
    if (qId && index.byId?.has(qId)) {
        return index.byId.get(qId);
    }
    return index.byKeyPath.has(question.keyPath)
        ? index.byKeyPath.get(question.keyPath)
        : index.byNormalizedKeyPath.get(normalizeKeyPath(question.keyPath));
}

export async function getAtsLlmAnswers({
    atsName,
    jobTitle,
    jobDescription,
    questions,
    resumeText,
    candidateProfile,
    coverLetter,
    jobUrl,
}) {
    const config = getProviderConfig();

    const resumeContext = await readResumeContext(resumeText, jobUrl);
    const candidateProfileContext = await readCandidateProfileContext(candidateProfile);
    const messages = buildAtsLlmMessages({
        atsName,
        jobTitle,
        jobDescription,
        resumeText: resumeContext,
        candidateProfile: candidateProfileContext,
        questions,
    });

    await writeLatestLlmPromptMarkdown({
        provider: config.provider,
        model: config.model,
        atsName,
        jobTitle,
        messages,
    });

    const llmStart = Date.now();
    let content = "";
    let rawApiResponse = null;
    let error = "";
    let usedKeyInfo = null;

    try {
        const callResult = await callGeminiLlm({
            config,
            messages,
            isJson: true,
            maxTokens: MAX_TOKENS,
            temperature: TEMPERATURE,
        });
        content = callResult.content;
        rawApiResponse = callResult.rawApiResponse;
        usedKeyInfo = callResult.keyInfo;
        const elapsedSec = (Date.now() - llmStart) / 1000;
        console.log(
            `[LLM:${config.provider}:${config.model}] Key ${usedKeyInfo?.keyIndex}/${usedKeyInfo?.totalKeys} (${usedKeyInfo?.maskedKey}) Response time: ${elapsedSec.toFixed(2)}s`
        );
    } catch (err) {
        const elapsedSec = (Date.now() - llmStart) / 1000;
        error = err instanceof Error ? err.stack || err.message : String(err);
        await writeLatestLlmCallMarkdown({
            provider: config.provider,
            model: config.model,
            endpoint: config.endpoint,
            keyInfo: usedKeyInfo,
            atsName,
            jobTitle,
            messages,
            questions,
            finalAnswers: [],
            elapsedSec,
            error,
        });
        throw err;
    }

    const elapsedSec = (Date.now() - llmStart) / 1000;
    const parsed = parseLlmJson(content);
    const index = buildAnswerIndex(parsed);

    const answers = [];
    for (const question of questions || []) {
        const raw = getRawAnswerFromIndex(question, index);
        const finalAnswer = normalizeAnswerForQuestion(question, raw);
        answers.push({
            id: question.id,
            keyPath: question.keyPath,
            question: question.question || question.labelText || "",
            type: question.type,
            answer: finalAnswer,
        });
    }

    if (coverLetter) {
        try {
            const coverResult = await generateCoverLetterText({
                config,
                atsName,
                jobTitle,
                jobDescription,
                resumeContext,
                candidateProfileContext,
            });

            if (coverResult?.text) {
                console.log(
                    `[LLM CoverLetter:${config.provider}:${config.model}] Key ${coverResult.keyInfo?.keyIndex}/${coverResult.keyInfo?.totalKeys} (${coverResult.keyInfo?.maskedKey})`
                );
                for (const answerRow of answers) {
                    const matchingQuestion = (questions || []).find((q) => q?.id === answerRow.id || q?.keyPath === answerRow.keyPath);
                    if (isCoverLetterQuestion(matchingQuestion || answerRow)) {
                        answerRow.answer = coverResult.text;
                    }
                }
            }
        } catch (err) {
            console.error(`[LLM CoverLetter:${config.provider}:${config.model}] Error generating cover letter:`, err?.message || err);
        }
    }

    await writeLatestLlmCallMarkdown({
        provider: config.provider,
        model: config.model,
        endpoint: config.endpoint,
        keyInfo: usedKeyInfo,
        atsName,
        jobTitle,
        messages,
        questions,
        finalAnswers: answers,
        elapsedSec,
        error: "",
    });

    return {
        provider: config.provider,
        model: config.model,
        keyInfo: usedKeyInfo,
        messages,
        rawContent: content,
        rawApiResponse,
        parsed,
        answers,
    };
}

