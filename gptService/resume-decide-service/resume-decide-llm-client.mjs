import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDataPath, loadEnvFile, loadUserEnv } from "../../scripts/lib/user-config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

// ── Environment Loading ───────────────────────────────────────────────────────

function ensureEnvLoaded() {
    // 1. Load project-wide user env first (for fallbacks)
    loadUserEnv(projectRoot);

    // 2. Load dedicated local env files inside gptService/resume-decide-service/ (takes highest priority)
    loadEnvFile(path.join(__dirname, ".env"), { override: true });
    loadEnvFile(path.join(__dirname, ".env.local"), { override: true });
}

ensureEnvLoaded();

// ── Audit Logging (kept entirely inside this folder) ──────────────────────────

const PROMPT_DUMP_FILE = path.join(__dirname, "latest-prompt.md");
const CALL_DUMP_FILE = path.join(__dirname, "latest-call.md");

function recordPromptDump({ provider, model, messages, keyInfo }) {
    try {
        const body = [
            "# Latest Resume Decider LLM Prompt",
            "",
            `- Timestamp: ${new Date().toISOString()}`,
            `- Provider: ${provider}`,
            `- Model: ${model}`,
            `- Key: ${keyInfo || "N/A"}`,
            "",
            "## Messages",
            "",
            ...messages.map((m, idx) => `### Message ${idx + 1} (${m.role})\n\n${m.content}\n`),
        ].join("\n");
        fs.writeFileSync(PROMPT_DUMP_FILE, body, "utf8");
    } catch {
        // non-fatal
    }
}

function recordCallDump({ provider, model, messages, responseText, elapsedSec, keyInfo }) {
    try {
        const body = [
            "# Latest Resume Decider LLM Call",
            "",
            `- Timestamp: ${new Date().toISOString()}`,
            `- Provider: ${provider}`,
            `- Model: ${model}`,
            `- Key: ${keyInfo || "N/A"}`,
            `- Elapsed: ${elapsedSec.toFixed(2)}s`,
            "",
            "## Request",
            "",
            ...messages.map((m, idx) => `### Message ${idx + 1} (${m.role})\n\n${m.content}\n`),
            "",
            "## Raw Response",
            "",
            "```json",
            responseText || "",
            "```",
        ].join("\n");
        fs.writeFileSync(CALL_DUMP_FILE, body, "utf8");
    } catch {
        // non-fatal
    }
}

// ── Key Scanner & Rotation ────────────────────────────────────────────────────

function scanNumberedKeys(prefix) {
    const regex = new RegExp(`^${prefix}_(\\d+)$`, "i");
    const entries = [];

    for (const [key, value] of Object.entries(process.env)) {
        const match = key.match(regex);
        if (match && value && String(value).trim()) {
            const num = parseInt(match[1], 10);
            entries.push({ num, keyName: key, apiKey: String(value).trim() });
        }
    }

    entries.sort((a, b) => a.num - b.num);
    return entries;
}

let geminiKeyIndex = 0;
let openaiKeyIndex = 0;

export function getResumeDecideConfig() {
    ensureEnvLoaded();

    const provider = String(
        process.env.RESUME_DECIDE_LLM_PROVIDER
        || process.env.RESUME_DECIDER_LLM_PROVIDER
        || "gemini"
    ).trim().toLowerCase();

    if (provider === "openai") {
        const model = String(
            process.env.RESUME_DECIDE_MODEL
            || process.env.RESUME_DECIDE_OPENAI_MODEL
            || process.env.OPENAI_MODEL
            || "gpt-4o-mini"
        ).trim();

        let keys = scanNumberedKeys("RESUME_DECIDE_OPENAI_API_KEY");
        if (keys.length === 0) {
            keys = scanNumberedKeys("OPENAI_API_KEY");
        }
        if (keys.length === 0) {
            const single = process.env.RESUME_DECIDE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
            if (single && String(single).trim()) {
                keys = [{ num: 1, keyName: "OPENAI_API_KEY", apiKey: String(single).trim() }];
            }
        }

        return { provider: "openai", model, keys };
    }

    // Default: Gemini
    const model = String(
        process.env.RESUME_DECIDE_MODEL
        || process.env.RESUME_DECIDE_GEMINI_MODEL
        || process.env.GEMINI_MODEL
        || "gemini-2.5-flash"
    ).trim();

    // Priority 1: dedicated keys from local or env
    let keys = scanNumberedKeys("RESUME_DECIDE_GEMINI_API_KEY");
    if (keys.length === 0) {
        keys = scanNumberedKeys("RESUME_DECIDER_GEMINI_API_KEY");
    }

    // Priority 2: Fall back to shared GEMINI_API_KEY_1..N
    if (keys.length === 0) {
        keys = scanNumberedKeys("GEMINI_API_KEY");
    }

    // Priority 3: Fall back to single key
    if (keys.length === 0) {
        const single = process.env.RESUME_DECIDE_GEMINI_API_KEY
            || process.env.GEMINI_API_KEY
            || process.env.GEMINI_API_TOKEN;
        if (single && String(single).trim()) {
            keys = [{ num: 1, keyName: "GEMINI_API_KEY", apiKey: String(single).trim() }];
        }
    }

    return { provider: "gemini", model, keys };
}

// ── Gemini Caller ─────────────────────────────────────────────────────────────

async function callGeminiDecider({ config, messages, temperature = 0.1, maxTokens = 2048 }) {
    if (!Array.isArray(config.keys) || config.keys.length === 0) {
        throw new Error("No Gemini API keys found for Resume Decider. Configure RESUME_DECIDE_GEMINI_API_KEY_1 or GEMINI_API_KEY_1.");
    }

    const totalKeys = config.keys.length;
    let attempts = 0;
    let lastError = null;

    while (attempts < totalKeys) {
        const currentIdx = geminiKeyIndex % totalKeys;
        geminiKeyIndex = (geminiKeyIndex + 1) % totalKeys;
        const currentKeyObj = config.keys[currentIdx];
        attempts++;

        const keyInfo = `key ${currentKeyObj.num}/${totalKeys} (${currentKeyObj.keyName})`;

        let systemInstructionText = "";
        const geminiContents = [];

        for (const msg of messages) {
            if (msg.role === "system") {
                systemInstructionText += (systemInstructionText ? "\n\n" : "") + msg.content;
            } else {
                geminiContents.push({
                    role: msg.role === "assistant" ? "model" : "user",
                    parts: [{ text: msg.content }],
                });
            }
        }

        const requestBody = {
            contents: geminiContents,
            generationConfig: {
                temperature,
                maxOutputTokens: 8192,
                responseMimeType: "application/json",
            },
        };

        if (systemInstructionText) {
            requestBody.systemInstruction = {
                parts: [{ text: systemInstructionText }],
            };
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(currentKeyObj.apiKey)}`;

        recordPromptDump({
            provider: "gemini",
            model: config.model,
            messages,
            keyInfo,
        });

        const start = Date.now();
        let res;
        try {
            res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
                signal: AbortSignal.timeout(30_000),
            });
        } catch (fetchErr) {
            lastError = fetchErr;
            console.error(`[resume-decide] Gemini network error with ${keyInfo}: ${fetchErr.message}. Trying next key...`);
            continue;
        }

        const rawText = await res.text().catch(() => "");
        const elapsedSec = (Date.now() - start) / 1000;

        if (res.status === 429 || res.status === 403 || res.status >= 500) {
            console.warn(`[resume-decide] Gemini returned HTTP ${res.status} with ${keyInfo}. Trying next key...`);
            lastError = new Error(`Gemini HTTP ${res.status}: ${rawText.slice(0, 200)}`);
            continue;
        }

        if (!res.ok) {
            throw new Error(`Gemini error (${res.status}): ${rawText.slice(0, 300)}`);
        }

        recordCallDump({
            provider: "gemini",
            model: config.model,
            messages,
            responseText: rawText,
            elapsedSec,
            keyInfo,
        });

        let data = {};
        try {
            data = JSON.parse(rawText);
        } catch {
            throw new Error(`Gemini returned invalid JSON: ${rawText.slice(0, 200)}`);
        }

        const candidate = data?.candidates?.[0];
        const contentText = candidate?.content?.parts?.[0]?.text;
        if (!contentText) {
            throw new Error(`Gemini returned empty content: ${rawText.slice(0, 200)}`);
        }

        return {
            content: contentText.trim(),
            keyInfo,
            elapsedSec,
            provider: "gemini",
        };
    }

    throw new Error(`All ${totalKeys} Gemini resume decider key(s) failed or were rate-limited. Last error: ${lastError?.message}`);
}

// ── OpenAI Caller (Pluggable for future use) ──────────────────────────────────

async function callOpenAiDecider({ config, messages, temperature = 0.1, maxTokens = 2048 }) {
    if (!Array.isArray(config.keys) || config.keys.length === 0) {
        throw new Error("No OpenAI API keys found for Resume Decider. Set RESUME_DECIDE_OPENAI_API_KEY or OPENAI_API_KEY.");
    }

    const totalKeys = config.keys.length;
    let attempts = 0;
    let lastError = null;

    while (attempts < totalKeys) {
        const currentIdx = openaiKeyIndex % totalKeys;
        openaiKeyIndex = (openaiKeyIndex + 1) % totalKeys;
        const currentKeyObj = config.keys[currentIdx];
        attempts++;

        const keyInfo = `key ${currentKeyObj.num}/${totalKeys} (${currentKeyObj.keyName})`;

        const requestBody = {
            model: config.model,
            messages,
            temperature,
            max_tokens: maxTokens,
            response_format: { type: "json_object" },
        };

        recordPromptDump({
            provider: "openai",
            model: config.model,
            messages,
            keyInfo,
        });

        const start = Date.now();
        let res;
        try {
            res = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${currentKeyObj.apiKey}`,
                },
                body: JSON.stringify(requestBody),
                signal: AbortSignal.timeout(30_000),
            });
        } catch (fetchErr) {
            lastError = fetchErr;
            console.error(`[resume-decide] OpenAI network error with ${keyInfo}: ${fetchErr.message}. Trying next key...`);
            continue;
        }

        const rawText = await res.text().catch(() => "");
        const elapsedSec = (Date.now() - start) / 1000;

        if (res.status === 429 || res.status >= 500) {
            console.warn(`[resume-decide] OpenAI returned HTTP ${res.status} with ${keyInfo}. Trying next key...`);
            lastError = new Error(`OpenAI HTTP ${res.status}: ${rawText.slice(0, 200)}`);
            continue;
        }

        if (!res.ok) {
            throw new Error(`OpenAI error (${res.status}): ${rawText.slice(0, 300)}`);
        }

        recordCallDump({
            provider: "openai",
            model: config.model,
            messages,
            responseText: rawText,
            elapsedSec,
            keyInfo,
        });

        let data = {};
        try {
            data = JSON.parse(rawText);
        } catch {
            throw new Error(`OpenAI returned invalid JSON: ${rawText.slice(0, 200)}`);
        }

        const contentText = data?.choices?.[0]?.message?.content;
        if (!contentText) {
            throw new Error(`OpenAI returned empty content: ${rawText.slice(0, 200)}`);
        }

        return {
            content: contentText.trim(),
            keyInfo,
            elapsedSec,
            provider: "openai",
        };
    }

    throw new Error(`All ${totalKeys} OpenAI resume decider key(s) failed. Last error: ${lastError?.message}`);
}

// ── JSON Helper ───────────────────────────────────────────────────────────────

function parseLlmJson(raw) {
    if (!raw) return null;
    let text = String(raw).trim();

    // Strip markdown code fences
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    // 1. Direct parse
    try {
        return JSON.parse(text);
    } catch { }

    // 2. Substring between outermost { and }
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last > first) {
        try {
            return JSON.parse(text.slice(first, last + 1));
        } catch { }
    }

    // 3. Repair if cut off mid-string (e.g. truncated reason string)
    try {
        const repaired = text.trim().replace(/,\s*$/, "") + '"\n}';
        return JSON.parse(repaired);
    } catch { }

    // 4. Regex fallback to extract chosen resume ID directly from raw text
    const match = text.match(/"chosenResumeId"\s*:\s*"([^"]+)"/i)
        || text.match(/"chosenResume"\s*:\s*"([^"]+)"/i)
        || text.match(/(resume\d+)/i);
    if (match) {
        return {
            chosenResumeId: match[1],
            confidence: "medium",
            reason: "Extracted from partial LLM response",
        };
    }

    throw new Error(`Could not parse JSON from: ${text.slice(0, 150)}...`);
}

// ── Custom Prompt Loader (from data/<user>/resume-decide-prompt.txt) ─────────

export function loadCustomPromptTemplate(root = projectRoot) {
    const candidates = [
        getDataPath(root, "resume-decide-prompt.txt"),
        getDataPath(root, "resume-select-prompt.txt"),
        path.join(root, "data", "resume-decide-prompt.txt"),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            try {
                const content = fs.readFileSync(p, "utf8").trim();
                if (content) return { content, path: p };
            } catch {}
        }
    }
    return null;
}

// ── Main Decision Function ────────────────────────────────────────────────────

/**
 * Evaluates a Job Description against candidate resumes and selects the best matching variant.
 * Dispatches to the configured provider (Gemini, OpenAI, etc.).
 *
 * @param {Object} params
 * @param {string} params.jobTitle
 * @param {string} params.company
 * @param {string} params.jobDescription
 * @param {Array<{id: string, desc: string, texPath: string}>} params.candidateResumes
 */
export async function chooseBestResume({
    jobTitle,
    company,
    jobDescription,
    candidateResumes,
}) {
    if (!Array.isArray(candidateResumes) || candidateResumes.length === 0) {
        throw new Error("chooseBestResume: candidateResumes array must not be empty");
    }

    if (candidateResumes.length === 1) {
        return {
            chosenId: candidateResumes[0].id,
            confidence: "high",
            reason: "Single candidate resume available",
            keyInfo: null,
            elapsedSec: 0,
        };
    }

    const config = getResumeDecideConfig();

    const candidateListText = candidateResumes
        .map((r, idx) => `[Option ${idx + 1}] ID: "${r.id}"\nDescription & Target Roles:\n${r.desc || "(No description provided)"}`)
        .join("\n\n---\n\n");

const DEFAULT_PROMPT_TEMPLATE = `You are an expert technical recruiter and resume strategist.
Evaluate the following Job Details against the candidate resume profiles and select the SINGLE BEST MATCHING resume.

### Job Information:
- Company: {{company}}
- Job Title: {{jobTitle}}
- Job Description & Requirements:
{{jobDescription}}

### Available Resumes:
{{candidateResumes}}

### Decision Rules:
1. Compare the core technical requirements, languages, frameworks, and domain of the job to the focus of each resume.
2. Choose exactly one resume ID from the available options: {{options}}.
3. Provide a clear, concise justification explaining why this resume is the strongest match.

### Output Format:
Return valid JSON in this exact structure:
{
  "chosenResumeId": "resume1",
  "confidence": "high",
  "reason": "1-2 sentence explanation of why this resume is the strongest match."
}`;

    const templateInfo = loadCustomPromptTemplate(projectRoot);
    const template = templateInfo ? templateInfo.content : DEFAULT_PROMPT_TEMPLATE;

    const prompt = template
        .replaceAll("{{company}}", company || "Unknown")
        .replaceAll("{{jobTitle}}", jobTitle || "Unknown")
        .replaceAll("{{jobDescription}}", jobDescription ? String(jobDescription).slice(0, 8000) : "No description available.")
        .replaceAll("{{candidateResumes}}", candidateListText)
        .replaceAll("{{options}}", candidateResumes.map((r) => `"${r.id}"`).join(", "));

    const messages = [
        { role: "system", content: "You are an expert technical talent evaluator. Always output valid JSON." },
        { role: "user", content: prompt },
    ];

    const start = Date.now();
    let result;
    if (config.provider === "openai") {
        result = await callOpenAiDecider({ config, messages });
    } else {
        result = await callGeminiDecider({ config, messages });
    }

    const elapsedSec = (Date.now() - start) / 1000;
    let parsed = null;
    try {
        parsed = parseLlmJson(result.content);
    } catch (err) {
        throw new Error(`Failed to parse LLM resume decision: ${err.message}. Raw: ${result.content}`);
    }

    const chosenId = String(parsed?.chosenResumeId || parsed?.chosenResume || parsed?.id || "").trim();
    const matched = candidateResumes.find((r) => r.id.toLowerCase() === chosenId.toLowerCase());
    const finalId = matched ? matched.id : candidateResumes[0].id;

    return {
        chosenId: finalId,
        confidence: parsed?.confidence || "medium",
        reason: parsed?.reason || "Selected by LLM evaluation",
        keyInfo: result.keyInfo,
        provider: result.provider,
        elapsedSec,
    };
}

// ── Diagnostics / CLI test runner ─────────────────────────────────────────────

export async function testResumeDecideKeys() {
    const config = getResumeDecideConfig();
    console.log(`[resume-decide] Provider: ${config.provider}`);
    console.log(`[resume-decide] Model   : ${config.model}`);
    console.log(`[resume-decide] Discovered ${config.keys.length} key(s):`);
    for (const k of config.keys) {
        console.log(`  • ${k.keyName} (#${k.num}): ${k.apiKey.slice(0, 8)}...`);
    }

    if (config.keys.length === 0) {
        console.error("No keys found!");
        return;
    }

    console.log("\nTesting keys...");
    for (let i = 0; i < config.keys.length; i++) {
        const k = config.keys[i];
        const start = Date.now();
        try {
            const singleConfig = { ...config, keys: [k] };
            let testRes;
            if (config.provider === "openai") {
                testRes = await callOpenAiDecider({
                    config: singleConfig,
                    messages: [{ role: "user", content: 'Return JSON: {"status":"OK"}' }],
                });
            } else {
                testRes = await callGeminiDecider({
                    config: singleConfig,
                    messages: [{ role: "user", content: 'Return JSON: {"status":"OK"}' }],
                });
            }
            const sec = ((Date.now() - start) / 1000).toFixed(2);
            console.log(`  ✓ ${k.keyName} (#${k.num}): responded in ${sec}s -> ${testRes.content}`);
        } catch (err) {
            console.error(`  ✗ ${k.keyName} (#${k.num}): FAILED (${err.message})`);
        }
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    testResumeDecideKeys().catch(console.error);
}
