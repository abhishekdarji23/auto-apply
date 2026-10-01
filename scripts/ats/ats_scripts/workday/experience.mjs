// workday/experience.mjs — Education field fill for the Experience step.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkdayLlmAnswers } from "./llm.mjs";
import { fillMultiselectField } from "./helpers.mjs";
import { getDataPath } from "../../../lib/user-config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "../../../..");
const candidateProfilePath = getDataPath(projectRoot, "candidate-profile.json");

// ─── Config ───────────────────────────────────────────────────────────────────
const NUM_SKILLS = 1; // change to 5, 15, etc.

// ─── DOM selectors ────────────────────────────────────────────────────────────
const DEGREE_FIELD = '[data-automation-id="formField-degree"]';
const SCHOOL_FIELD = '[data-automation-id="formField-school"]';
const FOS_FIELD = '[data-automation-id="formField-fieldOfStudy"]';
const LISTBOX_BTN = 'button[aria-haspopup="listbox"]';
const MULTISELECT_CONTAINER = '[data-automation-id="multiSelectContainer"]';
const MULTISELECT_INPUT = 'input:not([type="hidden"])';
const LISTBOX_OPTIONS_XPATH =
    '//div[@visibility="opened"]//ul[@role="listbox"]//li[@role="option"][not(@aria-disabled="true")]';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadCandidateProfile() {
    try {
        return JSON.parse(readFileSync(candidateProfilePath, "utf8"));
    } catch {
        return {};
    }
}

/** Extract API base URL and company name from current Workday page URL. */
function parseWorkdayApiBase(pageUrl) {
    try {
        const url = new URL(pageUrl);
        const base = `${url.protocol}//${url.host}`;
        const companyName = url.host.split(".")[0].replace(/-/g, "_");
        return { base, companyName };
    } catch {
        return null;
    }
}

/** Fetch school search results from Workday API.  Returns descriptor strings + "Other". */
async function fetchSchoolOptions(base, companyName, schoolQuery) {
    const url = `${base}/wday/calypso/cxs/jobapplication/${companyName}/schools?search=${encodeURIComponent(schoolQuery)}`;
    console.error(`[workday:experience] fetchSchoolOptions → ${url}`);
    try {
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) return { url, ok: false, raw: [], descriptors: ["Other"] };
        const data = await res.json();
        const descriptors = Array.isArray(data) ? data.map((d) => d.descriptor).filter(Boolean) : [];
        return { url, ok: true, raw: data, descriptors: [...descriptors, "Other"] };
    } catch (e) {
        console.error(`[workday:experience] fetchSchoolOptions error: ${e.message}`);
        return { url, ok: false, error: e.message, raw: [], descriptors: ["Other"] };
    }
}

/** Fetch fields of study via two API calls (one per major keyword), deduped. */
async function fetchFieldsOfStudy(base, companyName, term1 = "software", term2 = "computer") {
    const baseUrl = `${base}/wday/calypso/cxs/jobapplication/${companyName}/values/educations/fieldsOfStudy`;
    const urlSoftware = `${baseUrl}?search=${encodeURIComponent(term1)}`;
    const urlComputer = `${baseUrl}?search=${encodeURIComponent(term2)}`;
    console.error(`[workday:experience] fetchFieldsOfStudy → ${urlSoftware}`);
    console.error(`[workday:experience] fetchFieldsOfStudy → ${urlComputer}`);
    try {
        const [resSoftware, resComputer] = await Promise.all([
            fetch(urlSoftware, { headers: { Accept: "application/json" } }),
            fetch(urlComputer, { headers: { Accept: "application/json" } }),
        ]);
        const dataSoftware = resSoftware.ok ? await resSoftware.json() : [];
        const dataComputer = resComputer.ok ? await resComputer.json() : [];
        const seen = new Set();
        const combined = [...(Array.isArray(dataSoftware) ? dataSoftware : []), ...(Array.isArray(dataComputer) ? dataComputer : [])]
            .filter((d) => d?.descriptor && !seen.has(d.descriptor) && seen.add(d.descriptor));
        const filtered = combined.map((d) => d.descriptor);
        return {
            urlSoftware,
            urlComputer,
            ok: resSoftware.ok || resComputer.ok,
            rawSoftware: dataSoftware,
            rawComputer: dataComputer,
            filtered,
        };
    } catch (e) {
        console.error(`[workday:experience] fetchFieldsOfStudy error: ${e.message}`);
        return { urlSoftware, urlComputer, ok: false, error: e.message, rawSoftware: [], rawComputer: [], filtered: [] };
    }
}

/**
 * Click the Nth formField-degree listbox to read its option list, then close it.
 * Returns an array of option display strings.
 */
async function readDegreeOptions(page) {
    const containers = await page.$$(DEGREE_FIELD);
    const container = containers[0];
    if (!container) return [];

    const btn = await container.$(LISTBOX_BTN).catch(() => null);
    if (!btn) return [];

    // Open via JS dispatch — no Playwright pointer simulation so footer/overlay can't intercept
    await page.evaluate((el) => {
        el.focus();
        el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        if (typeof el.click === "function") el.click();
    }, btn);
    await page.waitForTimeout(500);

    const options = await page.evaluate((xp) => {
        const result = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const opts = [];
        for (let i = 0; i < result.snapshotLength; i++) {
            opts.push(result.snapshotItem(i).textContent?.trim());
        }
        return opts.filter(Boolean);
    }, LISTBOX_OPTIONS_XPATH);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    return options;
}

/**
 * Fill a type-1 listbox dropdown: click button → click the best-matching option.
 */
async function fillListboxContainerByIndex(page, fieldSelector, containerIndex, value) {
    const containers = await page.$$(fieldSelector);
    const container = containers[containerIndex];
    if (!container) {
        console.error(`[workday:experience] fillListbox: container[${containerIndex}] not found for ${fieldSelector}`);
        return false;
    }

    const btn = await container.$(LISTBOX_BTN).catch(() => null);
    if (!btn) {
        console.error(`[workday:experience] fillListbox: no listbox button in ${fieldSelector}[${containerIndex}]`);
        return false;
    }

    // Open via JS dispatch — no Playwright pointer simulation so footer/overlay can't intercept
    await page.evaluate((el) => {
        el.focus();
        el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        if (typeof el.click === "function") el.click();
    }, btn);
    await page.waitForTimeout(500);

    const clicked = await page.evaluate(({ xp, val }) => {
        const result = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < result.snapshotLength; i++) {
            const el = result.snapshotItem(i);
            if ((el.textContent ?? "").toLowerCase().includes(val.toLowerCase())) {
                el.click();
                return el.textContent.trim();
            }
        }
        return null;
    }, { xp: LISTBOX_OPTIONS_XPATH, val: value });

    if (!clicked) await page.keyboard.press("Escape").catch(() => { });
    await page.waitForTimeout(150);
    console.error(`[workday:experience] fillListbox ${fieldSelector}[${containerIndex}] "${value}" → ${clicked ?? "not found"}`);
    return Boolean(clicked);
}

/**
 * Fill a type-2 multiselect field inside the Nth formField container.
 * Finds the multiSelectContainer > input and delegates to fillMultiselectField.
 */
async function fillMultiselectContainerByIndex(page, fieldSelector, containerIndex, value) {
    const containers = await page.$$(fieldSelector);
    const container = containers[containerIndex];
    if (!container) {
        console.error(`[workday:experience] fillMultiselect: container[${containerIndex}] not found for ${fieldSelector}`);
        return false;
    }

    const msEl = await container.$(MULTISELECT_CONTAINER).catch(() => null);
    if (!msEl) {
        console.error(`[workday:experience] fillMultiselect: no multiSelectContainer in ${fieldSelector}[${containerIndex}]`);
        return false;
    }

    const inputEl = await msEl.$(MULTISELECT_INPUT).catch(() => null);
    if (!inputEl) {
        console.error(`[workday:experience] fillMultiselect: no input in ${fieldSelector}[${containerIndex}]`);
        return false;
    }

    await fillMultiselectField(page, inputEl, value);
    console.error(`[workday:experience] fillMultiselect ${fieldSelector}[${containerIndex}] → "${value}"`);
    return true;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Fill education fields on the Experience step:
 *  - School        : Education 2 only (index 1) — multiselect, options from API search
 *  - Degree        : Education 1 + 2 (index 0, 1) — listbox dropdown, options from DOM
 *  - Field of Study: Education 1 + 2 (index 0, 1) — multiselect, options from API (filtered)
 *
 * @param {import('playwright').Page} page
 * @param {object} [job]
 */
export async function fillEducationFields(page, job = {}) {
    // ── 1. Parse API base from page URL ───────────────────────────────────────
    const parsed = parseWorkdayApiBase(page.url());
    if (!parsed) {
        console.error("[workday:experience] Could not parse Workday API base — skipping education fill");
        return;
    }
    const { base, companyName } = parsed;
    console.error(`[workday:experience] API base="${base}"  company="${companyName}"`);

    // ── 2. Load candidate profile ─────────────────────────────────────────────
    const profile = loadCandidateProfile();
    const edu = profile?.candidate_profile?.education ?? {};
    const schoolQuery = (edu.searchQuery).trim();
    const edu1Major = (edu.edu1_major).trim();
    const edu2Major = (edu.edu2_major).trim();
    console.error(`[workday:experience] Candidate profile loaded: schoolQuery="${schoolQuery}"  edu1Major="${edu1Major}"  edu2Major="${edu2Major}"`);

    // ── 3. Fetch API data + read degree options in parallel ───────────────────
    // Use the first word of each major as the field-of-study search keyword
    const fosKeyword1 = edu1Major.split(/\s+/)[0].toLowerCase();
    const fosKeyword2 = edu2Major.split(/\s+/)[0].toLowerCase();
    const [schoolResult, fosResult, degreeOptions] = await Promise.all([
        fetchSchoolOptions(base, companyName, schoolQuery),
        fetchFieldsOfStudy(base, companyName, fosKeyword1, fosKeyword2),
        readDegreeOptions(page),
    ]);
    const schoolOptions = schoolResult.descriptors;
    const fieldsOfStudy = fosResult.filtered;
    console.error(
        `[workday:experience] schoolOptions=${schoolOptions.length}  ` +
        `fieldsOfStudy=${fieldsOfStudy.length}  degreeOptions=${degreeOptions.length}`
    );

    // ── Debug: save API data to file ──────────────────────────────────────────
    const debugData = {
        generatedAt: new Date().toISOString(),
        pageUrl: page.url(),
        apiBase: base,
        companyName,
        school: {
            url: schoolResult.url,
            ok: schoolResult.ok,
            rawCount: Array.isArray(schoolResult.raw) ? schoolResult.raw.length : 0,
            raw: schoolResult.raw,
            descriptors: schoolOptions,
        },
        fieldsOfStudy: {
            urlSoftware: fosResult.urlSoftware,
            urlComputer: fosResult.urlComputer,
            ok: fosResult.ok,
            rawSoftwareCount: Array.isArray(fosResult.rawSoftware) ? fosResult.rawSoftware.length : 0,
            rawComputerCount: Array.isArray(fosResult.rawComputer) ? fosResult.rawComputer.length : 0,
            rawSoftware: fosResult.rawSoftware,
            rawComputer: fosResult.rawComputer,
            filteredCount: fieldsOfStudy.length,
            filtered: fieldsOfStudy,
        },
        degree: {
            options: degreeOptions,
        },
        llmAnswers: null, // filled in after LLM call
    };
    const debugDir = resolve(__dirname, "../../debug");
    const debugPath = resolve(debugDir, "education-debug.latest.json");
    const saveDebug = () => {
        try {
            mkdirSync(debugDir, { recursive: true });
            writeFileSync(debugPath, JSON.stringify(debugData, null, 2), "utf8");
        } catch (e) {
            console.error(`[workday:experience] debug save error: ${e.message}`);
        }
    };
    saveDebug();
    console.error(`[workday:experience] Debug saved → ${debugPath}`);

    // ── 4. Build LLM questions ────────────────────────────────────────────────
    const questions = [
        {
            id: "edu2_school",
            keyPath: "experience.education.2.school",
            question: `For Education Entry 2 (second entry), select the school name closest to "${schoolQuery}". Return exactly one option from the list, or "Other" if none are a close match.`,
            type: "select",
            options: schoolOptions,
        },
        ...(degreeOptions.length > 0 ? [
            {
                id: "edu1_degree",
                keyPath: "experience.education.1.degree",
                question: "For Education Entry 1 (first entry — highest/most recent degree), select the degree level that best matches the candidate.",
                type: "select",
                options: degreeOptions,
            },
            {
                id: "edu2_degree",
                keyPath: "experience.education.2.degree",
                question: "For Education Entry 2 (second entry — earlier/lower degree), select the degree level that best matches the candidate.",
                type: "select",
                options: degreeOptions,
            },
        ] : []),
        ...(fieldsOfStudy.length > 0 ? [
            {
                id: "edu1_fieldOfStudy",
                keyPath: "experience.education.1.fieldOfStudy",
                question: `For Education Entry 1 (first entry), select the field of study that best matches the candidate's major in ${edu1Major}. Choose the single closest match.`,
                type: "select",
                options: fieldsOfStudy,
            },
            {
                id: "edu2_fieldOfStudy",
                keyPath: "experience.education.2.fieldOfStudy",
                question: `For Education Entry 2 (second entry), select the field of study that best matches the candidate's major in ${edu2Major}. Choose the single closest match.`,
                type: "select",
                options: fieldsOfStudy,
            },
        ] : []),
        // Skills — merged into education LLM call to save a round-trip
        {
            id: "skills_list",
            keyPath: "experience.skills",
            question:
                `Based on the candidate's resume and the job description, list the top ${NUM_SKILLS} most relevant ` +
                "technical skills (programming languages, tools, frameworks, libraries, platforms). " +
                "Only include short keyword-style terms that would appear in a job portal skill search (e.g. \"Python\", \"React\", \"AWS\"). " +
                `Return ONLY a JSON array of exactly ${NUM_SKILLS} strings. Example: ["Python", "React", "AWS", "Node.js", "SQL"]`,
            type: "text",
        },
    ];

    if (questions.length === 0) {
        console.error("[workday:experience] No education questions — skipping LLM call");
        return;
    }

    // ── 5. Call LLM ───────────────────────────────────────────────────────────
    console.error(`[workday:experience] Sending ${questions.length} education questions to LLM...`);
    const llmOutput = await getWorkdayLlmAnswers({
        atsName: "workday",
        jobTitle: job?.title || job?.jobTitle || "",
        jobDescription: job?.description || "",
        questions,
        jobUrl: job?.url || "",
    }, "experience-education");

    const answerMap = new Map();
    for (const row of llmOutput?.answers ?? []) {
        if (row?.id) answerMap.set(row.id, row.answer);
        if (row?.keyPath) answerMap.set(row.keyPath, row.answer);
    }
    console.error(`[workday:experience] LLM returned ${answerMap.size} answers`);

    // Update debug file with LLM answers
    debugData.llmAnswers = Object.fromEntries(answerMap);
    saveDebug();

    // ── 6. Fill fields ────────────────────────────────────────────────────────

    // School — Education 2 only (index 1, skip index 0)
    const schoolAns = answerMap.get("edu2_school") ?? answerMap.get("experience.education.2.school");
    if (schoolAns) {
        await fillMultiselectContainerByIndex(page, SCHOOL_FIELD, 1, String(schoolAns));
    } else {
        console.error("[workday:experience] No LLM answer for school — skipping");
    }

    // Degree — both educations
    const deg1 = answerMap.get("edu1_degree") ?? answerMap.get("experience.education.1.degree");
    const deg2 = answerMap.get("edu2_degree") ?? answerMap.get("experience.education.2.degree");
    if (deg1) await fillListboxContainerByIndex(page, DEGREE_FIELD, 0, String(deg1));
    if (deg2) await fillListboxContainerByIndex(page, DEGREE_FIELD, 1, String(deg2));

    // Field of Study — both educations
    const fos1 = answerMap.get("edu1_fieldOfStudy") ?? answerMap.get("experience.education.1.fieldOfStudy");
    const fos2 = answerMap.get("edu2_fieldOfStudy") ?? answerMap.get("experience.education.2.fieldOfStudy");
    if (fos1) await fillMultiselectContainerByIndex(page, FOS_FIELD, 0, String(fos1));
    if (fos2) await fillMultiselectContainerByIndex(page, FOS_FIELD, 1, String(fos2));

    // Skills — extracted from merged LLM answer, passed to avoid second LLM call
    const skillsRaw = answerMap.get("skills_list") ?? answerMap.get("experience.skills");
    let preloadedSkills = null;
    if (skillsRaw) {
        try {
            const parsed = JSON.parse(skillsRaw);
            if (Array.isArray(parsed)) preloadedSkills = parsed.map(String).filter(Boolean).slice(0, NUM_SKILLS);
            else if (parsed) preloadedSkills = [String(parsed)];
        } catch {
            preloadedSkills = String(skillsRaw).split(/\s*,\s*/).filter(Boolean).slice(0, NUM_SKILLS);
        }
    }
    await fillSkillsField(page, job, preloadedSkills);

    console.error("[workday:experience] Education fields fill complete");
}

// ─── Skills fill ──────────────────────────────────────────────────────────────

const SKILLS_INPUT_XPATH = '//div[@data-automation-id="formField-skills"]//input[@placeholder="Search"]';

/**
 * Fill the Skills multiselect on the Experience step.
 * Asks the LLM for up to 10 relevant technical skills based on resume + job desc,
 * then fills each one-by-one using fillMultiselectField.
 *
 * @param {import('playwright').Page} page
 * @param {object} [job]
 */
export async function fillSkillsField(page, job = {}, preloadedSkills = null) {
    // ── 1. Check skills input exists ──────────────────────────────────────────
    const inputEl = await page.$(`xpath=${SKILLS_INPUT_XPATH}`).catch(() => null);
    if (!inputEl) {
        console.error("[workday:experience] Skills input not found — skipping skills fill");
        return;
    }

    // ── 2. Resolve skills list ────────────────────────────────────────────────
    let skills = [];
    if (preloadedSkills !== null) {
        // Skills already fetched in the merged education LLM call — skip extra round-trip
        skills = Array.isArray(preloadedSkills) ? preloadedSkills.map(String).filter(Boolean).slice(0, NUM_SKILLS) : [];
        if (!skills.length) {
            console.error("[workday:experience] Preloaded skills empty — skipping");
            return;
        }
        console.error(`[workday:experience] Skills preloaded (${skills.length}): ${skills.join(", ")}`);
    } else {
        console.error(`[workday:experience] Requesting top ${NUM_SKILLS} skills from LLM...`);
        const questions = [
            {
                id: "skills_list",
                keyPath: "experience.skills",
                question:
                    `Based on the candidate's resume and the job description, list the top ${NUM_SKILLS} most relevant ` +
                    "technical skills (programming languages, tools, frameworks, libraries, platforms). " +
                    "Only include short keyword-style terms that would appear in a job portal skill search (e.g. \"Python\", \"React\", \"AWS\"). " +
                    `Return ONLY a JSON array of exactly ${NUM_SKILLS} strings. Example: ["Python", "React", "AWS", "Node.js", "SQL"]`,
                type: "text",
            },
        ];

        const llmOutput = await getWorkdayLlmAnswers(
            {
                atsName: "workday",
                jobTitle: job?.title || job?.jobTitle || "",
                jobDescription: job?.description || "",
                questions,
                jobUrl: job?.url || "",
            },
            "experience-skills"
        );

        const rawAnswer = llmOutput?.answers?.find((a) => a?.id === "skills_list" || a?.keyPath === "experience.skills")?.answer ?? "";

        try {
            const parsed = JSON.parse(rawAnswer);
            if (Array.isArray(parsed)) {
                skills = parsed.map(String).filter(Boolean).slice(0, NUM_SKILLS);
            } else if (parsed) {
                skills = [String(parsed)];
            }
        } catch {
            skills = String(rawAnswer).split(/\s*,\s*/).filter(Boolean).slice(0, NUM_SKILLS);
        }

        if (!skills.length) {
            console.error("[workday:experience] LLM returned no skills — skipping");
            return;
        }

        console.error(`[workday:experience] Skills to fill (${skills.length}): ${skills.join(", ")}`);
    }

    // ── 3. Fill each skill one-by-one ─────────────────────────────────────────
    for (const skill of skills) {
        // Re-query the input each time — DOM may refresh after each selection
        const input = await page.$(`xpath=${SKILLS_INPUT_XPATH}`).catch(() => null);
        if (!input) {
            console.error("[workday:experience] Skills input disappeared — stopping");
            break;
        }
        console.error(`[workday:experience] Filling skill: "${skill}"`);
        await fillMultiselectField(page, input, skill);
        await page.waitForTimeout(400);
    }

    // ── 4. Remove any duplicates ───────────────────────────────────────────────
    const removed = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[data-automation-id="formField-skills"] li')];
        const seen = new Set();
        const duplicates = [];
        for (const li of items) {
            const text = li.textContent.trim().replace(/\s+/g, " ");
            if (!text) continue;
            if (seen.has(text.toLowerCase())) {
                duplicates.push({ li, text });
            } else {
                seen.add(text.toLowerCase());
            }
        }
        duplicates.forEach(({ li }) => {
            const deleteBtn = li.querySelector('[data-automation-id="DELETE_charm"]');
            if (deleteBtn) deleteBtn.click();
        });
        return duplicates.map((d) => d.text);
    });

    if (removed.length > 0) {
        console.error(`[workday:experience] Removed ${removed.length} duplicate skill(s): ${removed.join(", ")}`);
    }

    console.error("[workday:experience] Skills fill complete");
}
