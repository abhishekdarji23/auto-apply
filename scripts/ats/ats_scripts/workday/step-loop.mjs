// workday/step-loop.mjs — Workday multi-step application loop.
import { STEP_LOOP, EXTENSION_FILL, INFORMATION_AUTO_FILLS, EXPERIENCE } from "./selectors.mjs";
import { waitForExtensionFill } from "../../utils/extension-fill.mjs";
import { parseJsonOrNull } from "../../utils/helpers.mjs";
import { getTrackedEntryLabels, buildWorkdayPreparedQuestions } from "./question-builder.mjs";
import { getWorkdayLlmAnswers } from "./llm.mjs";
import { fillWorkdayPreparedQuestions } from "./form-filler.mjs";
import { realisticClickByXpath, realisticClickElement, runLlmAndFill, fillMultiselectField, REALISTIC_CLICK_SRC } from "./helpers.mjs";
import { fillEducationFields } from "./experience.mjs";

// ─── sessionStorage helper ──────────────────────────────────────────────────

// Read the freshest simplifyFoundInputMap from sessionStorage.
// Call this inside handlers whenever the map may have changed.
async function getSimplifyFoundInputMap(page) {
    const raw = await page.evaluate(
        (key) => sessionStorage.getItem(key),
        EXTENSION_FILL.FOUND_INPUT_MAP_KEY
    ).catch(() => null);
    return parseJsonOrNull(raw);
}

// ─── Progress bar helpers ─────────────────────────────────────────────────────

// Read label + index/total from the currently active progress bar step.
async function getActiveStep(page) {
    return page.evaluate((sel) => {
        const active = document.querySelector(sel.PROGRESS_BAR_ACTIVE_STEP);
        if (!active) return null;
        const liveText = active.querySelector('[aria-live="polite"]')?.textContent?.trim() ?? "";
        const match = liveText.match(/(\d+)\s+of\s+(\d+)/);
        const index = match ? parseInt(match[1], 10) : 0;
        const total = match ? parseInt(match[2], 10) : 0;
        const labels = Array.from(active.querySelectorAll("label"));
        const label = labels.find(l => !l.getAttribute("aria-live"))?.textContent?.trim() ?? "";
        return { label, index, total };
    }, STEP_LOOP).catch(() => null);
}

// Map a step label → handler key.
function classifyStep(label) {
    const l = label.toLowerCase();
    if (l.includes("information")) return "information";
    if (l.includes("experience")) return "experience";
    if (l.includes("application question")) return "applicationQuestions";
    if (l.includes("voluntary")) return "voluntary";
    if (l.includes("self identify") || l.includes("self-identify")) return "selfIdentify";
    if (l.includes("review")) return "review";
    return "unknown";
}

// ─── Button helpers ───────────────────────────────────────────────────────────

function xpathClick(page, xpath) {
    return page.evaluate((xp) => {
        const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!el) return false;
        const opts = { bubbles: true, cancelable: true };
        el.dispatchEvent(new FocusEvent("focus", opts));
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        typeof el.click === "function" ? el.click() : el.dispatchEvent(new MouseEvent("click", opts));
        el.dispatchEvent(new FocusEvent("blur", opts));
        return true;
    }, xpath);
}

// Click Continue/Next (all steps except review).
async function clickContinueButton(page) {
    const clicked = await xpathClick(page, STEP_LOOP.CONTINUE_BUTTON_XPATH);
    console.error(`[workday:loop] clickContinueButton → clicked=${clicked}`);
    if (!clicked) console.error("[workday:loop] ⚠️  Continue/Next button not found via XPath.");
}

// Click Submit/Send (review page only).
async function clickSubmitButton(page) {
    const clicked = await xpathClick(page, STEP_LOOP.SUBMIT_BUTTON_XPATH);
    console.error(`[workday:loop] clickSubmitButton → clicked=${clicked}`);
    if (!clicked) console.error("[workday:loop] ⚠️  Submit/Send button not found via XPath.");
}

// Realistic-click the progress bar to close any open dropdowns/popups left by the extension.
async function dismissOpenDropdowns(page) {
    const hit = await realisticClickElement(page, STEP_LOOP.PROGRESS_BAR_ACTIVE_STEP);
    console.error(`[workday:loop] dismissOpenDropdowns → hit=${hit}`);
}

// After clicking next, poll until the active step index changes OR errors appear.
// Returns true if advanced, false if stuck.
async function waitForProgressAdvance(page, prevIndex) {
    console.error(`[workday:loop] Waiting for progress to advance past step ${prevIndex}...`);
    for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(500);
        const step = await getActiveStep(page);
        if (step && step.index !== prevIndex) {
            console.error(`[workday:loop] ✅ Advanced to step ${step.index}/${step.total}: "${step.label}"`);
            return true;
        }
    }
    console.error("[workday:loop] ⚠️  Progress bar did not advance after 10s — may be stuck.");
    return false;
}

// ─── Submission confirmation check ──────────────────────────────────────────
export async function checkWorkdaySubmissionSuccess(page, timeoutMs = 6000) {
    const successPaths = STEP_LOOP.SUBMITTED_SUCCESS_PATHS;

    const evaluate = (paths) => page.evaluate((paths) => {
        for (const path of paths) {
            const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const node = result.singleNodeValue;
            if (node) return { confirmed: true, method: "xpath", text: String(node.textContent || "").trim() };
        }
        if (/complete|applied|thankYou|thank-you|submitted/i.test(location.href)) {
            return { confirmed: true, method: "url", text: location.href };
        }
        return { confirmed: false, method: "", text: "" };
    }, paths);

    try {
        await page.waitForFunction((paths) => {
            for (const path of paths) {
                const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                if (result.singleNodeValue) return true;
            }
            return /complete|applied|thankYou|thank-you|submitted/i.test(location.href);
        }, successPaths, { timeout: timeoutMs });
    } catch {
        // timed out — fall through to synchronous check
    }

    return evaluate(successPaths);
}

// ─── Error page helper ────────────────────────────────────────────────────────
export async function reloadIfErrorPage(page) {
    const isErrorPage = await page.evaluate((sel) =>
        document.body?.innerText?.includes(sel.ERROR_PAGE_TEXT)
        , STEP_LOOP).catch(() => false);
    if (isErrorPage) {
        console.error("[workday:loop] ⚠️  'Something went wrong' detected — reloading...");
        await page.reload({ waitUntil: "networkidle", timeout: 20_000 }).catch(() => { });
        await page.waitForTimeout(1_500);
        console.error(`[workday:loop] Reloaded — URL: ${page.url()}`);
    }
}

// ─── Per-step handlers ────────────────────────────────────────────────────────
// Each handler: 1) waitForExtensionFill  2) TODO page-specific logic  3) click button

async function handleInformation(page, _initialMap, job) {
    console.error("[workday:information] Waiting for extension fill...");
    await waitForExtensionFill(page, "workday");
    await dismissOpenDropdowns(page);

    // Re-read fresh after extension fill completes
    let map = await getSimplifyFoundInputMap(page);

    // ── Auto-fill 1: candidateIsPreviousWorker → No ───────────────────────────
    const prevCfg = INFORMATION_AUTO_FILLS.PREV_WORKER;
    const prevContainer = await page.$(prevCfg.CONTAINER).catch(() => null);
    if (prevContainer) {
        const noRadio = await prevContainer.$(prevCfg.NO_RADIO).catch(() => null);
        if (noRadio) {
            const already = await noRadio.evaluate((el) => el.checked);
            if (!already) {
                await page.evaluate((el) => {
                    el.focus();
                    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
                    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
                    if (typeof el.click === "function") el.click();
                    el.dispatchEvent(new Event("change", { bubbles: true }));
                }, noRadio);
                console.error("[workday:information] ✔ Set candidateIsPreviousWorker = No");
            } else {
                console.error("[workday:information] candidateIsPreviousWorker already = No");
            }
        }
    } else {
        console.error("[workday:information] candidateIsPreviousWorker not found — skipping");
    }

    // ── Auto-fill 2: formField-source → LinkedIn ──────────────────────────────
    const srcCfg = INFORMATION_AUTO_FILLS.SOURCE;
    const sourceContainer = await page.$(srcCfg.CONTAINER).catch(() => null);
    if (sourceContainer) {
        const listboxBtn = await sourceContainer.$(srcCfg.LISTBOX_BUTTON).catch(() => null);
        const msContainer = await sourceContainer.$(srcCfg.MULTISELECT_CONTAINER).catch(() => null);

        if (listboxBtn) {
            // Type 1: single-select dropdown
            console.error("[workday:information] Filling source (listbox) → " + srcCfg.VALUE);
            // Open via JS dispatch — no Playwright pointer simulation so footer/overlay can't intercept
            await page.evaluate((el) => {
                el.focus();
                el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
                el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
                el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
                if (typeof el.click === "function") el.click();
            }, listboxBtn);
            await page.waitForTimeout(600);
            const clicked = await page.evaluate(({ xpath, val }) => {
                const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                for (let i = 0; i < result.snapshotLength; i++) {
                    const el = result.snapshotItem(i);
                    if ((el.textContent ?? "").toLowerCase().includes(val.toLowerCase())) {
                        el.click();
                        return true;
                    }
                }
                return false;
            }, { xpath: srcCfg.LISTBOX_OPTIONS_XPATH, val: srcCfg.VALUE });
            console.error(`[workday:information] source listbox → clicked=${clicked}`);

        } else if (msContainer) {
            // Type 2: type-ahead multiselect
            console.error("[workday:information] Filling source (multiselect) → " + srcCfg.VALUE);
            const input = await msContainer.$(srcCfg.MULTISELECT_INPUT).catch(() => null);
            if (input) {
                await fillMultiselectField(page, input, srcCfg.VALUE);
                console.error(`[workday:information] source multiselect -> entered ${srcCfg.VALUE}`);
            }
        } else {
            console.error("[workday:information] source field: type unknown — skipping");
        }
    } else {
        console.error("[workday:information] formField-source not found — skipping");
    }

    // ── Build questions (required only) + LLM + fill ─────────────────────────────
    await page.waitForTimeout(800);
    map = await getSimplifyFoundInputMap(page);

    await runLlmAndFill(page, {
        map, job, stepName: "information", includeNonRequired: false,
        getTrackedEntryLabels, buildWorkdayPreparedQuestions,
        getWorkdayLlmAnswers, fillWorkdayPreparedQuestions,
    });

    console.error("[workday:information] Clicking Continue...");
    await clickContinueButton(page);
}

async function handleExperience(page, simplifyFoundInputMap, job) {
    console.error("[workday:experience] Waiting for extension fill...");
    await waitForExtensionFill(page, "workday");
    await dismissOpenDropdowns(page);

    // ── Fill education fields + skills (merged LLM call) ──────────────────
    await fillEducationFields(page, job);

    // ── Delete any pre-filled Language entries (realistic click) ───────────
    const deleted = await page.evaluate(({ sel, clickSrc }) => {
        eval(clickSrc);
        const container = document.querySelector(sel.LANGUAGES_SECTION);
        if (!container) return false;
        const deleteBtn = Array.from(container.querySelectorAll("button")).find(
            (btn) => btn.textContent.replace(/\s+/g, " ").trim() === sel.DELETE_BUTTON_TEXT
        );
        if (!deleteBtn) return false;
        realisticClick(deleteBtn);
        return true;
    }, { sel: EXPERIENCE, clickSrc: REALISTIC_CLICK_SRC });
    console.error(`[workday:experience] Languages delete button ${deleted ? "→ clicked" : "not found — skipping"}`);

    console.error("[workday:experience] Clicking Continue...");
    await clickContinueButton(page);
}

async function handleApplicationQuestions(page, _initialMap, job) {
    console.error("[workday:appQuestions] Waiting for extension fill...");
    await waitForExtensionFill(page, "workday");
    await dismissOpenDropdowns(page);
    await page.waitForTimeout(800);

    const MAX_ROUNDS = 8;
    let lastQuestionCount = -1;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
        const map = await getSimplifyFoundInputMap(page);

        const preparedQuestions = await buildWorkdayPreparedQuestions(page, map, {
            includeNonRequired: true,
            includeDateFields: true,
        });
        const currentCount = preparedQuestions.length;
        console.error(`[workday:appQuestions] Round ${round}: ${currentCount} questions (prev=${lastQuestionCount})`);

        if (currentCount === 0) {
            console.error("[workday:appQuestions] No questions found — done.");
            break;
        }

        // Run LLM + fill for ALL currently-visible questions
        if (currentCount > 0) {
            const llmQuestions = preparedQuestions.map((q) => q.llmRequest).filter(Boolean);
            const llmOutput = await getWorkdayLlmAnswers({
                atsName: "workday",
                jobTitle: job?.title || job?.jobTitle || "",
                jobDescription: job?.description || "",
                questions: llmQuestions,
                jobUrl: job?.url || "",
            }, "applicationQuestions");

            const llmAnswerMap = new Map();
            for (const row of llmOutput?.answers || []) {
                if (row?.id) llmAnswerMap.set(row.id, row.answer);
                if (row?.keyPath) llmAnswerMap.set(row.keyPath, row.answer);
            }

            await fillWorkdayPreparedQuestions(page, preparedQuestions, llmAnswerMap);
        }

        // Wait for potential dynamic fields to appear after fill
        await page.waitForTimeout(1000);
        await dismissOpenDropdowns(page);

        // Re-build to check if count changed (dynamic reveals)
        const mapAfter = await getSimplifyFoundInputMap(page);
        const questionsAfter = await buildWorkdayPreparedQuestions(page, mapAfter, {
            includeNonRequired: true,
            includeDateFields: true,
        });
        const countAfter = questionsAfter.length;
        console.error(`[workday:appQuestions] Round ${round} post-fill: ${countAfter} questions`);

        if (countAfter === currentCount) {
            // Question count stabilized — no new fields appeared
            console.error(`[workday:appQuestions] Stable at ${countAfter} questions after round ${round} — done.`);
            break;
        }

        // New questions appeared — loop again with fresh set
        console.error(`[workday:appQuestions] Question count changed ${currentCount} → ${countAfter} — looping.`);
        lastQuestionCount = currentCount;

        if (round === MAX_ROUNDS) {
            console.error(`[workday:appQuestions] Max rounds (${MAX_ROUNDS}) reached — proceeding.`);
        }
    }

    console.error("[workday:appQuestions] Clicking Continue...");
    await clickContinueButton(page);
}

async function checkTermsAndConditions(page, tag) {
    const checked = await page.evaluate((clickSrc) => {
        eval(clickSrc);
        const container = document.querySelector('[data-automation-id="formField-acceptTermsAndAgreements"]');
        if (!container) return null;
        const cb = container.querySelector('input[type="checkbox"]');
        if (!cb) return null;
        if (!cb.checked) realisticClick(cb);
        return cb.checked;
    }, REALISTIC_CLICK_SRC);
    if (checked === null) {
        console.error(`[workday:${tag}] Terms checkbox not found — skipping`);
    } else {
        console.error(`[workday:${tag}] Terms checkbox ${checked ? "already checked" : "→ clicked"}`);
    }
}

async function handleVoluntary(page, simplifyFoundInputMap, job) {
    console.error("[workday:voluntary] Waiting for extension fill...");
    await waitForExtensionFill(page, "workday");
    await dismissOpenDropdowns(page);
    await checkTermsAndConditions(page, "voluntary");

    // ── Build required questions + LLM + fill ──────────────────────────────
    await page.waitForTimeout(800);
    const map = await getSimplifyFoundInputMap(page);
    await runLlmAndFill(page, {
        map, job, stepName: "voluntary", includeNonRequired: false,
        getTrackedEntryLabels, buildWorkdayPreparedQuestions,
        getWorkdayLlmAnswers, fillWorkdayPreparedQuestions,
    });

    console.error("[workday:voluntary] Clicking Continue...");
    await clickContinueButton(page);
}

async function handleSelfIdentify(page, simplifyFoundInputMap, job) {
    console.error("[workday:selfIdentify] Waiting for extension fill...");
    await waitForExtensionFill(page, "workday");
    await dismissOpenDropdowns(page);
    await checkTermsAndConditions(page, "selfIdentify");

    // ── Build required questions + LLM + fill ──────────────────────────────
    await page.waitForTimeout(800);
    const map = await getSimplifyFoundInputMap(page);
    await runLlmAndFill(page, {
        map, job, stepName: "selfIdentify", includeNonRequired: false,
        getTrackedEntryLabels, buildWorkdayPreparedQuestions,
        getWorkdayLlmAnswers, fillWorkdayPreparedQuestions,
    });

    console.error("[workday:selfIdentify] Clicking Continue...");
    await clickContinueButton(page);
}

async function handleReview(page) {
    console.error("[workday:review] Waiting for extension fill...");
    await waitForExtensionFill(page, "workday");
    await dismissOpenDropdowns(page);
    // TODO: Review page logic (scroll, verify, etc.)
    console.error("[workday:review] Clicking Submit...");
    await clickSubmitButton(page);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

export async function runStepLoop(page, job) {
    const MAX_STEPS = 20;

    for (let i = 0; i < MAX_STEPS; i++) {
        await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => { });
        await reloadIfErrorPage(page);
        await page.waitForTimeout(800);

        const step = await getActiveStep(page);
        if (!step) {
            console.error("[workday:loop] No progress bar found — assuming done.");
            break;
        }

        const kind = classifyStep(step.label);
        console.error(`[workday:loop] Step ${step.index}/${step.total}: "${step.label}" → ${kind}`);

        // Read the extension's found-input map (handlers may call getSimplifyFoundInputMap again if needed)
        const simplifyFoundInputMap = await getSimplifyFoundInputMap(page);

        switch (kind) {
            case "information":
                await handleInformation(page, simplifyFoundInputMap, job);
                break;
            case "experience":
                await handleExperience(page, simplifyFoundInputMap, job);
                break;
            case "applicationQuestions":
                await handleApplicationQuestions(page, simplifyFoundInputMap, job);
                break;
            case "voluntary":
                await handleVoluntary(page, simplifyFoundInputMap, job);
                break;
            case "selfIdentify":
                await handleSelfIdentify(page, simplifyFoundInputMap, job);
                break;
            case "review":
                await handleReview(page);
                console.error("[workday:loop] ✅ Review submitted — exiting loop.");
                return;
            default:
                console.error(`[workday:loop] Unknown step "${step.label}" — clicking Next to advance.`);
                await clickContinueButton(page);
        }

        // Verify the progress bar advanced; stop if errors are blocking
        const advanced = await waitForProgressAdvance(page, step.index);
        if (!advanced) {
            console.error(`[workday:loop] ❌ Stuck on "${step.label}" — stopping loop.`);
            return;
        }
    }

    console.error("[workday:loop] Step loop finished.");
}
