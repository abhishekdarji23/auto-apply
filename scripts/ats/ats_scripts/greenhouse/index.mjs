/**
 * greenhouse/index.mjs — ATS automation for Greenhouse.
 * Greenhouse-specific page logic only; shared utils live in ../../utils/.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import { parseJsonOrNull } from "../../utils/helpers.mjs";
import { waitForExtensionFill } from "../../utils/extension-fill.mjs";
import { buildGreenhousePreparedQuestions } from "./question-builder.mjs";
import { getGreenhouseLlmAnswers } from "./llm.mjs";
import { fillGreenhousePreparedQuestions } from "./form-filler.mjs";
import { EXTENSION_FILL, GREENHOUSE_INDEX, JOB_INFO } from "./selectors.mjs";
import { getDataPath } from "../../../lib/user-config.mjs";
import { shouldCloseAtsPageOnFailure } from "../../utils/env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const SCRAPER_VERBOSE_LOGS = process.env.SCRAPER_VERBOSE_LOGS !== "false";
const projectRoot = path.resolve(__dirname, "../../../..");

function loadCurrentEmails() {
    try {
        return _require(getDataPath(projectRoot, "current-emails.json"));
    } catch {
        return {};
    }
}

async function detectOtpVerificationPage(page) {
    return page.evaluate((sel) => {
        const emailVerificationWrapper = document.querySelector(sel.OTP_WRAPPER);
        const securityInputs = document.querySelectorAll(sel.OTP_INPUTS);
        const hasOtpPage = Boolean(emailVerificationWrapper && securityInputs.length > 0);
        return { hasOtpPage, inputCount: securityInputs.length };
    }, GREENHOUSE_INDEX);
}

async function fetchOtpFromGmail(page) {
    const sel = GREENHOUSE_INDEX;
    let gmailPage = null;
    try {
        gmailPage = await page.context().newPage();
        await gmailPage.bringToFront().catch(() => { });
        await gmailPage.waitForTimeout(3000);

        const gmailUrl = loadCurrentEmails().gmailUrl || "https://mail.google.com/mail/u/7/#inbox";
        await gmailPage.goto(gmailUrl, {
            waitUntil: "domcontentloaded",
            timeout: 3000,
        }).catch(() => { });
        await gmailPage.waitForTimeout(2000);

        await gmailPage.waitForSelector(sel.GMAIL_INBOX_TABLE, {
            timeout: 3000,
        }).catch(() => { });

        const debug = await gmailPage.evaluate((selectors) => ({
            title: document.title,
            bodyText: document.body?.innerText?.slice(0, 500),
            rowCount: document.querySelectorAll(selectors.GMAIL_ROW_COUNTER).length,
            h1Count: document.querySelectorAll(selectors.GMAIL_H1_COUNTER).length,
        }), sel);
        // console.error(debug);

        await gmailPage.evaluate((selectors) => {
            const firstRow = document.querySelectorAll(selectors.GMAIL_INBOX_TABLE)[selectors.GMAIL_FIRST_MAIL_ROW_INDEX]?.querySelector(selectors.GMAIL_FIRST_MAIL_ROW);
            if (firstRow) firstRow.click();
        }, sel);

        await gmailPage.waitForTimeout(2000);

        const otp = await gmailPage.evaluate((selectors) => {
            const h1Elements = document.querySelectorAll(selectors.GMAIL_OTP_TAG);
            let lastOtp = null;
            for (const h1 of h1Elements) {
                const text = (h1.textContent || "").trim();
                if (text.length === 8 && /^[a-zA-Z0-9]{8}$/.test(text)) {
                    lastOtp = text;
                }
            }
            return lastOtp;
        }, sel);
        console.error(`[greenhouse:otp] Extracted OTP from Gmail: ${otp}`);
        if (otp) {
            await gmailPage.evaluate(async (selectors) => {
                const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                const fire = (el, type, x, y) => {
                    el.dispatchEvent(new MouseEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                        clientX: x,
                        clientY: y,
                    }));
                };

                const btn = document.querySelector(selectors.GMAIL_DELETE_BUTTON);
                if (!btn) return;

                const inner = btn.querySelector(selectors.GMAIL_DELETE_INNER) || btn;
                btn.scrollIntoView({ block: "center", inline: "center" });
                await wait(300);

                const rect = btn.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;

                fire(btn, "mouseover", x, y);
                fire(btn, "mouseenter", x, y);
                fire(btn, "mousemove", x, y);

                fire(inner, "mouseover", x, y);
                fire(inner, "mouseenter", x, y);
                fire(inner, "mousemove", x, y);

                await wait(500);

                fire(inner, "mousedown", x, y);
                await wait(80);
                fire(inner, "mouseup", x, y);
                fire(inner, "click", x, y);
            }, sel).catch(() => { });
            await gmailPage.waitForTimeout(500);
        }

        await gmailPage.close().catch(() => { });
        await page.bringToFront().catch(() => { });
        return otp;
    } catch (err) {
        console.error(`[greenhouse:otp] Gmail fetch error: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    } finally {
        if (gmailPage && !gmailPage.isClosed()) {
            await gmailPage.close().catch(() => { });
        }
        await page.bringToFront().catch(() => { });
    }
}

async function fillOtpFields(page, otp) {
    if (!otp || typeof otp !== "string") {
        console.error(`[greenhouse:otp] Invalid OTP: ${otp}`);
        return false;
    }

    const otpChars = otp.split("");

    const fillSuccess = await page.evaluate(async ({ chars, selectorMap }) => {
        const inputs = Array.from(document.querySelectorAll(selectorMap.OTP_INPUTS));

        if (inputs.length !== chars.length) {
            console.error(`[greenhouse:otp] Input count mismatch: ${inputs.length} vs ${chars.length}`);
            return false;
        }

        const nativeInputValueSetter =
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

        function fireKeyboardEvent(el, type, key) {
            el.dispatchEvent(new KeyboardEvent(type, {
                key,
                code: key.startsWith("Digit") ? key : `Digit${key}`,
                bubbles: true,
                cancelable: true
            }));
        }

        function fireInputEvent(el, value) {
            el.dispatchEvent(new InputEvent("input", {
                data: value,
                inputType: "insertText",
                bubbles: true,
                cancelable: true
            }));
        }

        function sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        for (let i = 0; i < inputs.length; i++) {
            const input = inputs[i];
            const char = chars[i];

            input.focus();

            fireKeyboardEvent(input, "keydown", char);

            if (nativeInputValueSetter) {
                nativeInputValueSetter.call(input, char);
            } else {
                input.value = char;
            }

            fireInputEvent(input, char);
            input.dispatchEvent(new Event("change", { bubbles: true }));
            fireKeyboardEvent(input, "keyup", char);

            await sleep(50);
        }

        inputs[inputs.length - 1]?.blur();
        return true;
    }, { chars: otpChars, selectorMap: GREENHOUSE_INDEX });

    if (fillSuccess) {
        await page.waitForTimeout(800);
    }

    return fillSuccess;
}

async function resubmitAfterOtp(page) {
    const submitResult = await clickGreenhouseSubmit(page);
    if (!submitResult?.clicked) {
        console.error(`[greenhouse:otp] Resubmit button not found after OTP`);
        return false;
    }

    await page.waitForTimeout(1000);
    const confirmationResult = await checkGreenhouseSubmissionSuccess(page);
    return Boolean(confirmationResult?.confirmed);
}

async function saveTrackingFromGreenhouse({ job, success, error }) {
    const origin = process.env.JOBTRACK_API_ORIGIN || (process.env.PORT ? `http://localhost:${process.env.PORT}` : "http://localhost:3000");
    const payload = {
        jobId: job?.jobId || "",
        jobUrl: job?.url || "",
        atsId: "greenhouse",
        success: Boolean(success),
        error: error ? String(error) : "",
        defaultResume: Boolean(job?.defaultResume),
    };

    try {
        const res = await fetch(`${origin}/api/auto-apply-tracker/save`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            console.error(`[greenhouse] tracking save failed: ${res.status} ${txt}`);
            return false;
        }
        return true;
    } catch (saveErr) {
        console.error(`[greenhouse] tracking save error: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`);
        return false;
    }
}

async function clickGreenhouseSubmit(page) {
    return page.evaluate((submitPaths) => {
        function xpathFirst(path, root = document) {
            const result = document.evaluate(
                String(path || ""),
                root,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
            );
            return result.singleNodeValue || null;
        }

        function clickElement(el) {
            if (!el) return;
            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            if (typeof el.click === "function") el.click();
        }

        for (const path of submitPaths || []) {
            const node = xpathFirst(path);
            if (!node) continue;
            node.scrollIntoView?.({ block: "center", inline: "center" });
            clickElement(node);
            return {
                clicked: true,
                path,
                text: String(node.textContent || node.value || "").trim(),
            };
        }

        return {
            clicked: false,
            path: "",
            text: "",
        };
    }, GREENHOUSE_INDEX.SUBMIT_BUTTON_PATHS);
}

async function checkGreenhouseSubmissionSuccess(page, timeoutMs = 3000) {
    try {
        await page.waitForFunction((successPaths) => {
            for (const path of successPaths || []) {
                const result = document.evaluate(
                    String(path || ""),
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                );
                if (result.singleNodeValue) return true;
            }
            return false;
        }, GREENHOUSE_INDEX.SUBMITTED_SUCCESS_PATHS, { timeout: timeoutMs });
    } catch {
        return {
            confirmed: false,
            path: "",
            text: "",
        };
    }

    return page.evaluate((successPaths) => {
        for (const path of successPaths || []) {
            const result = document.evaluate(
                String(path || ""),
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
            );
            const node = result.singleNodeValue;
            if (!node) continue;
            return {
                confirmed: true,
                path,
                text: String(node.textContent || "").trim(),
            };
        }

        return {
            confirmed: false,
            path: "",
            text: "",
        };
    }, GREENHOUSE_INDEX.SUBMITTED_SUCCESS_PATHS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Jobright fallback — calls the main app's /api/job-description endpoint and
// returns { title, description } or null on any failure.
// ─────────────────────────────────────────────────────────────────────────────
const JOBTRACK_ORIGIN = process.env.JOBTRACK_API_ORIGIN || (process.env.PORT ? `http://localhost:${process.env.PORT}` : "http://localhost:3000");

async function fetchJobrightDetails(jobrightJobId) {
    try {
        const url = `${JOBTRACK_ORIGIN}/api/job-description?jobId=${encodeURIComponent(jobrightJobId)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return null;
        const j = await res.json();
        return j?.title ? { title: j.title, description: j.description || "" } : null;
    } catch {
        return null;
    }
}

function getJobrightFallbackId(job) {
    const explicit = String(job?.jobrightJobId || "").trim();
    if (explicit) return explicit;

    const legacyJobId = String(job?.jobId || "").trim();
    return /^[a-f0-9]{24}$/i.test(legacyJobId) ? legacyJobId : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// scrapeJobDetails(page, jobrightJobId?)
//
// Extracts job title + description from the currently-loaded Greenhouse page.
// If page scraping is incomplete and jobrightJobId is provided, falls back to
// fetching from the Jobright detail API.
//
// Called by job-scraper.js (pre-gen flow) and by apply() (automation flow).
// ─────────────────────────────────────────────────────────────────────────────
export async function scrapeJobDetails(page, jobrightJobId = null) {
    const { title: rawTitle, description: rawDesc } = await page.evaluate((sel) => ({
        title: document.querySelector(sel.TITLE)?.innerText?.trim() ?? "",
        description: document.querySelector(sel.DESCRIPTION)?.innerText?.trim() ?? "",
    }), JOB_INFO);

    let title = rawTitle;
    let description = rawDesc;

    if ((!title || !description) && jobrightJobId) {
        if (SCRAPER_VERBOSE_LOGS) {
            console.error(`[greenhouse:scrapeJobDetails] Page scraping incomplete — trying Jobright fallback (jobId=${jobrightJobId})`);
        }
        const fallback = await fetchJobrightDetails(jobrightJobId);
        if (fallback) {
            title = title || fallback.title;
            description = description || fallback.description;
        }
    }

    return { title, description };
}

export default async function apply(page, job, context) {
    void context;

    const t0 = Date.now();
    const fmtSec = (start) => `${((Date.now() - start) / 1000).toFixed(2)}s`;
    const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;

    try {
        console.error(`[greenhouse] URL: ${page.url()}`);

        const notFoundPage = await page.evaluate((notFoundText) => {
            const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
            return bodyText.includes(notFoundText);
        }, JOB_INFO.NOT_FOUND_TEXT);

        if (notFoundPage) {
            const message = "greenhouse_page_not_found";
            console.error(`[greenhouse] ❌ Error: ${message}`);
            const trackingSaved = await saveTrackingFromGreenhouse({
                job,
                success: false,
                error: message,
            });
            if (shouldCloseAtsPageOnFailure()) await page.close().catch(() => { });
            return { success: false, error: message, trackingSaved };
        }

        // 1. Scrape job info from page
        const t1 = Date.now();
        const { title, description } = await scrapeJobDetails(page, getJobrightFallbackId(job));
        console.error(`[greenhouse:timing] Page scrape: ${fmtSec(t1)} (${elapsed()} total)`);

        // 2. Wait for Simplify extension to fill what it can
        const t2 = Date.now();
        await waitForExtensionFill(page, "greenhouse");
        console.error(`[greenhouse:timing] Extension fill wait: ${fmtSec(t2)} (${elapsed()} total)`);

        // 3. Capture extension maps from sessionStorage
        const { autofillFieldmapRaw, simplifyFoundInputMapRaw } = await page.evaluate((keys) => ({
            autofillFieldmapRaw: sessionStorage.getItem(keys.FIELDMAP_KEY),
            simplifyFoundInputMapRaw: sessionStorage.getItem(keys.FOUND_INPUT_MAP_KEY),
        }), EXTENSION_FILL);

        const autofillFieldmap = parseJsonOrNull(autofillFieldmapRaw);
        const simplifyFoundInputMap = parseJsonOrNull(simplifyFoundInputMapRaw);

        console.error(
            `[greenhouse] Maps: autofill-fieldmap=${autofillFieldmap ? "present" : "missing"}, simplify_foundInputMap=${simplifyFoundInputMap ? "present" : "missing"}`
        );

        //     // 4. Greenhouse-specific question stage (WIP: per-ATS modules)
        const t3 = Date.now();
        const preparedQuestions = await buildGreenhousePreparedQuestions(page, simplifyFoundInputMap);
        console.error(`[greenhouse:timing] Questions (greenhouse module): ${preparedQuestions.length} (${elapsed()} total)`);

        const t4 = Date.now();
        const llmQuestions = preparedQuestions.map((q) => q.llmRequest).filter(Boolean);
        const coverLetterRequired = preparedQuestions.some((q) => Boolean(q?.coverLetter?.required));
        const llmOutput = await getGreenhouseLlmAnswers({
            atsName: "greenhouse",
            jobTitle: title || job?.title || "",
            jobDescription: description,
            questions: llmQuestions,
            coverLetter: coverLetterRequired,
            jobUrl: job?.url || "",
        });
        console.error(`[greenhouse:timing] LLM call: ${fmtSec(t4)} (${elapsed()} total)`);

        const llmAnswerMap = new Map();
        for (const row of llmOutput?.answers || []) {
            if (row?.id) llmAnswerMap.set(row.id, row.answer);
            if (row?.keyPath) llmAnswerMap.set(row.keyPath, row.answer);
        }

        const t5 = Date.now();
        const fillResults = await fillGreenhousePreparedQuestions(page, preparedQuestions, llmAnswerMap);
        console.error(`[greenhouse:timing] Fill: ${fmtSec(t5)} (${elapsed()} total)`);

        const t6 = Date.now();
        const submitResult = await clickGreenhouseSubmit(page);
        if (!submitResult?.clicked) {
            const message = "submit_button_not_found";
            console.error(`[greenhouse] ❌ Submit failed: ${message}`);
            const trackingSaved = await saveTrackingFromGreenhouse({
                job,
                success: false,
                error: message,
            });
            return {
                success: false,
                error: message,
                trackingSaved,
                trackedQuestionsPrepared: preparedQuestions.length,
                preparedQuestions,
                llmQuestions,
                llmAnswers: llmOutput?.answers || [],
                llmRaw: llmOutput?.rawContent || null,
                llmParsed: llmOutput?.parsed || [],
                fillResults,
                submitResult,
                confirmationResult: { confirmed: false, path: "", text: "" },
            };
        }

        await page.waitForTimeout(1000);
        const confirmationResult = await checkGreenhouseSubmissionSuccess(page);
        console.error(`[greenhouse:timing] Submit + confirm check: ${fmtSec(t6)} (${elapsed()} total)`);

        let finalConfirmationResult = confirmationResult;

        // Check for OTP verification page if initial confirmation failed
        if (!confirmationResult?.confirmed) {
            const otpPageCheck = await detectOtpVerificationPage(page);
            if (otpPageCheck?.hasOtpPage) {
                console.error(`[greenhouse:otp] OTP verification page detected (${otpPageCheck.inputCount} fields)`);

                const otp = await fetchOtpFromGmail(page);
                if (otp) {
                    console.error(`[greenhouse:otp] OTP fetched from Gmail: ${otp}`);
                    await page.bringToFront().catch(() => { });
                    await page.waitForTimeout(250);
                    const fillSuccess = await fillOtpFields(page, otp);
                    if (fillSuccess) {
                        console.error(`[greenhouse:otp] OTP fields filled, resubmitting...`);
                        const resubmitSuccess = await resubmitAfterOtp(page);
                        if (resubmitSuccess) {
                            console.error(`[greenhouse:otp] ✅ Resubmit successful after OTP`);
                            finalConfirmationResult = { confirmed: true, path: "otp-verified", text: "Application submitted after OTP verification" };
                        }
                    } else {
                        console.error(`[greenhouse:otp] Failed to fill OTP fields`);
                    }
                } else {
                    console.error(`[greenhouse:otp] Failed to fetch OTP from Gmail`);
                }
            }
        }

        console.error(`[greenhouse:timing] Post-map + LLM + fill stage: ${fmtSec(t3)} (${elapsed()} total)`);
        console.error(`[greenhouse:timing] ✅ TOTAL: ${fmtSec(t0)}`);

        const confirmed = Boolean(finalConfirmationResult?.confirmed);
        const trackingError = confirmed ? "" : "submission_not_confirmed";
        const trackingSaved = await saveTrackingFromGreenhouse({
            job,
            success: confirmed,
            error: trackingError,
        });

        if (confirmed) {
            await page.close().catch(() => { });
        } else {
            if (shouldCloseAtsPageOnFailure()) await page.close().catch(() => { });
        }

        return {
            success: confirmed,
            staged: true,
            submitted: Boolean(submitResult?.clicked),
            confirmed,
            trackingSaved,
            error: trackingError || "",
            trackedQuestionsPrepared: preparedQuestions.length,
            preparedQuestions,
            llmQuestions,
            llmAnswers: llmOutput?.answers || [],
            llmRaw: llmOutput?.rawContent || null,
            llmParsed: llmOutput?.parsed || [],
            fillResults,
            submitResult,
            confirmationResult: finalConfirmationResult,
        };

    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[greenhouse] ❌ Error: ${message}`);
        const trackingSaved = await saveTrackingFromGreenhouse({
            job,
            success: false,
            error: message,
        });
        if (shouldCloseAtsPageOnFailure()) await page.close().catch(() => { });
        return { success: false, error: message, trackingSaved };
    }
}
