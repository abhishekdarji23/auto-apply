/**
 * ats-llm-prompt.mjs
 * Generic prompt builder for all ATS automation flows.
 */

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeCandidateProfile(candidateProfile) {
    if (!candidateProfile || typeof candidateProfile !== "object") {
        return null;
    }
    return candidateProfile;
}

function toQuestionPayload(question, index) {
    const options = Array.isArray(question?.options)
        ? question.options.filter((opt) => cleanText(opt))
        : [];
    const type = cleanText(question?.type);
    const isMultiSelect = type.toLowerCase() === "checkbox";

    return {
        id: cleanText(question?.id || `Que${index + 1}`),
        index: index + 1,
        keyPath: cleanText(question?.keyPath),
        question: cleanText(question?.question || question?.labelText),
        type,
        inputKind: isMultiSelect ? "multi_select_checklist" : (options.length ? "single_select" : "free_text"),
        answerFormat: isMultiSelect ? "string[] exact option names" : "string",
        options,
    };
}

export function buildAtsLlmMessages({
    atsName,
    jobTitle,
    jobDescription,
    resumeText,
    candidateProfile,
    questions,
}) {
    const normalizedQuestions = Array.isArray(questions)
        ? questions.map(toQuestionPayload).filter((q) => q.keyPath && q.question)
        : [];
    const normalizedCandidateProfile = normalizeCandidateProfile(candidateProfile);

    const answerFormat = {
        answers: [
            {
                id: "Que1",
                keyPath: "string",
                question: "string",
                type: "checkbox|select|text|textarea|unknown",
                answer: "string | string[]",
                confidence: "high|medium|low",
                reason: "short string",
            },
        ],
    };

    const systemPrompt = [
        "You are an assistant that answers job application form questions for ATS automation.",
        "You MUST return valid JSON only (no markdown, no code fences, no extra text).",
        "Use the candidate profile as the primary source of truth for personal, eligibility, education, and work-authorization facts.",
        "Use the resume and job description to tailor open-text answers and choose the best matching listed options.",
        "Use the exact id and keyPath values provided.",
        "Use the exact keyPath values provided.",
        "For type=choice or type=select: answer must be exactly one option string from options.",
        "For type=checkbox: this is a multi-select checklist; answer must be an array of one or more exact option strings from options, even when only one option is selected.",
        "For type=text or type=textarea: answer must be a concise natural-language string.",
        "For type=text or type=textarea: never return an empty string; if unknown or not provided, return exactly 'N/A'.",
        "Never invent options that are not listed.",
    ].join(" ");

    const userPrompt = {
        task: "Generate best-fit application answers for the role.",
        ats: cleanText(atsName || "unknown"),
        job: {
            title: cleanText(jobTitle),
            description: cleanText(jobDescription),
        },
        candidate_profile: normalizedCandidateProfile,
        resume_context: cleanText(resumeText),
        questions: normalizedQuestions,
        required_output_format: answerFormat,
    };

    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPrompt) },
    ];
}
