function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function buildAtsCoverLetterMessages({
    atsName,
    jobTitle,
    jobDescription,
    resumeText,
    candidateProfile,
}) {
    const systemPrompt = [
        "You are an expert career writing assistant and job application assistant.",
        "Your task is to write a tailored, professional cover letter using only the provided resume, candidate profile, and job description.",
        "Return only the final cover letter text in plain text.",
        "Do not use markdown, code fences, bullet points, headings, labels, or commentary.",
        "Do not invent or assume facts that are not supported by the provided materials.",
        "Do not fabricate experience, projects, metrics, employers, education, certifications, awards, publications, leadership, domain expertise, or tools.",
        "Do not claim years of experience unless clearly supported by the resume or profile.",
        "Do not mention skills or technologies unless supported by the resume, profile, or job description alignment.",
        "Do not use placeholders like [Company Name] or [Hiring Manager].",
        "If a hiring manager name is unavailable, use 'Dear Hiring Team,' as the greeting.",
        "If the company name is unavailable, refer naturally to 'your team' or 'your company'.",
        "Keep the letter professional, specific, believable, and tailored to the role.",
        "Avoid generic filler, excessive praise, and cliches.",
        "Avoid robotic language and avoid repeating the resume line by line.",
        "Do not copy long phrases from the job description.",
        "Focus on 2 to 4 of the strongest matches between the candidate background and the role.",
        "If direct experience is limited, emphasize transferable experience honestly without overstating fit.",
        "Use measurable outcomes only if they are supported by the resume or profile.",
        "The cover letter should generally be between 250 and 400 words unless the provided constraints say otherwise.",
        "Write in concise, polished paragraphs with a clear opening, body, and closing.",
        "Opening: mention interest in the specific role and why the candidate is a strong fit.",
        "Body: connect relevant experience, projects, skills, coursework, research, or impact to the job requirements.",
        "Closing: reaffirm interest, express enthusiasm to contribute, and end professionally.",
        "Before writing, silently identify the most important role requirements and the strongest supporting evidence from the resume/profile, then write the letter around those matches.",
        "Do not use em dashes. Replace them with a period or comma as needed.",
        "The writing must feel human, natural, and personally written.",
        "Avoid AI-sounding phrasing, corporate fluff, and templated language.",
        "Avoid overly polished, robotic, or generic wording.",
        "Vary sentence structure naturally and keep the tone believable.",
        "Output only the final ready-to-send cover letter text."
    ].join(" ");

    const userPrompt = `
Generate a tailored cover letter for the following application.

Rules:
- Use only the provided resume, candidate profile, and job description.
- Do not invent experience, projects, achievements, metrics, employers, education, certifications, awards, publications, leadership, domain expertise, or tools.
- Do not claim years of experience unless directly supported.
- Do not use placeholders like [Company Name] or [Hiring Manager].
- If no hiring manager name is available, use "Dear Hiring Team,".
- Keep the tone professional, natural, concise, and credible.
- The writing must sound human-written and not AI-generated.
- Avoid AI-sounding phrasing, generic filler, excessive praise, and cliches.
- Do not use em dashes. Use periods or commas instead.
- Do not restate the resume line by line.
- Do not copy long phrases from the job description.
- Focus on the strongest 2 to 4 matches between the candidate and the role.
- If direct experience is limited, emphasize transferable experience honestly.
- Use measurable outcomes only if supported by the provided materials.
- Structure the letter with a clear opening, body, and closing.
- Keep the final letter between 250 and 400 words.
- Output only the final cover letter text.
- Do not use em dashes(—). Replace them with a period or comma as needed.

ATS:
${cleanText(atsName || "unknown")}

Job title:
${cleanText(jobTitle || "")}

Job description:
${cleanText(jobDescription || "")}

Candidate profile:
${candidateProfile && typeof candidateProfile === "object"
            ? JSON.stringify(candidateProfile, null, 2)
            : "null"}

Resume:
${cleanText(resumeText || "")}
`.trim();

    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
    ];
}