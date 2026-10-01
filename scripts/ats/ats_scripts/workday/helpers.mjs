import { JOB_POSTING, AUTH_STATE, STEP_LOOP } from "./selectors.mjs";

function normalizeText(value) {
    return String(value ?? "")
        .replace(/\r/g, "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ─── Shared browser-context helpers (strings injected into page.evaluate) ─────
// Must be re-declared inside every page.evaluate call that needs them because
// Playwright serialises each evaluate independently.

/**
 * Canonical DOM helpers injected into page.evaluate calls.
 * Contains: normalizeText, xpathAll, resolveContainer, resolveElement.
 * Import this and include it at the top of your page.evaluate body.
 */
export const DOM_HELPERS_SRC = /* js */ `
function normalizeText(v) { return String(v ?? "").replace(/\\s+/g, " ").trim(); }
function xpathAll(path, root) {
    const ctx = root?.nodeType === Node.DOCUMENT_NODE ? root : (root || document);
    const doc = ctx.nodeType === Node.DOCUMENT_NODE ? ctx : ctx.ownerDocument || document;
    const r = doc.evaluate(String(path || ""), ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const items = []; for (let i = 0; i < r.snapshotLength; i++) items.push(r.snapshotItem(i));
    return items;
}
function resolveContainer(fc, fb = document) {
    if (!fc) return fb;
    const parent = fc.parentFoundContainer ? resolveContainer(fc.parentFoundContainer, fb) : fb;
    if (!fc.containerPath || fc.containerPath === ".") return parent;
    const nodes = xpathAll(fc.containerPath, parent);
    return nodes[fc.containerIndex || 0] || parent;
}
function resolveElement(fe, fb = document) {
    if (!fe) return null;
    const base = fe.foundContainer ? resolveContainer(fe.foundContainer, fb) : fb;
    if (!fe.elementPath || fe.elementPath === ".") return base;
    const nodes = xpathAll(fe.elementPath, base);
    return nodes[fe.elementIndex || 0] || null;
}
`;

/**
 * Realistic click helper — dispatches the full focus→mousedown→mouseup→click→blur
 * sequence that a real user produces.  Injected into page.evaluate as a string.
 */
export const REALISTIC_CLICK_SRC = /* js */ `
function realisticClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : {};
    const cx = (rect.left || 0) + (rect.width || 0) / 2;
    const cy = (rect.top || 0) + (rect.height || 0) / 2;
    const mouseOpts = { ...opts, clientX: cx, clientY: cy };
    el.dispatchEvent(new FocusEvent("focus", opts));
    el.dispatchEvent(new PointerEvent("pointerdown", mouseOpts));
    el.dispatchEvent(new MouseEvent("mousedown", mouseOpts));
    el.dispatchEvent(new PointerEvent("pointerup", mouseOpts));
    el.dispatchEvent(new MouseEvent("mouseup", mouseOpts));
    typeof el.click === "function" ? el.click() : el.dispatchEvent(new MouseEvent("click", mouseOpts));
    el.dispatchEvent(new FocusEvent("blur", opts));
}
`;

/**
 * Realistic click via XPath — resolves an XPath then fires realisticClick.
 * Returns true if clicked, false if not found.
 */
export async function realisticClickByXpath(page, xpath) {
    return page.evaluate((xp) => {
        const el = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!el) return false;
        const opts = { bubbles: true, cancelable: true, view: window };
        const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : {};
        const cx = (rect.left || 0) + (rect.width || 0) / 2;
        const cy = (rect.top || 0) + (rect.height || 0) / 2;
        const mouseOpts = { ...opts, clientX: cx, clientY: cy };
        el.dispatchEvent(new FocusEvent("focus", opts));
        el.dispatchEvent(new PointerEvent("pointerdown", mouseOpts));
        el.dispatchEvent(new MouseEvent("mousedown", mouseOpts));
        el.dispatchEvent(new PointerEvent("pointerup", mouseOpts));
        el.dispatchEvent(new MouseEvent("mouseup", mouseOpts));
        typeof el.click === "function" ? el.click() : el.dispatchEvent(new MouseEvent("click", mouseOpts));
        el.dispatchEvent(new FocusEvent("blur", opts));
        return true;
    }, xpath);
}

/**
 * Realistic click on a Playwright element handle (CSS-selected) — uses page.evaluate.
 */
export async function realisticClickElement(page, cssSelector) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const opts = { bubbles: true, cancelable: true, view: window };
        const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : {};
        const cx = (rect.left || 0) + (rect.width || 0) / 2;
        const cy = (rect.top || 0) + (rect.height || 0) / 2;
        const mouseOpts = { ...opts, clientX: cx, clientY: cy };
        el.dispatchEvent(new FocusEvent("focus", opts));
        el.dispatchEvent(new PointerEvent("pointerdown", mouseOpts));
        el.dispatchEvent(new MouseEvent("mousedown", mouseOpts));
        el.dispatchEvent(new PointerEvent("pointerup", mouseOpts));
        el.dispatchEvent(new MouseEvent("mouseup", mouseOpts));
        typeof el.click === "function" ? el.click() : el.dispatchEvent(new MouseEvent("click", mouseOpts));
        el.dispatchEvent(new FocusEvent("blur", opts));
        return true;
    }, cssSelector);
}

/**
 * Run the LLM → fill pipeline (shared by handleInformation and handleApplicationQuestions).
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @returns {Promise<{preparedQuestions: Array, fillResults: Array}>}
 */
export async function runLlmAndFill(page, {
    map,
    job,
    stepName,
    includeNonRequired,
    includeDateFields = false,
    getTrackedEntryLabels: _getLabels,
    buildWorkdayPreparedQuestions: _buildQs,
    getWorkdayLlmAnswers: _getLlm,
    fillWorkdayPreparedQuestions: _fillQs,
}) {
    const labelInfos = await _getLabels(page, map);
    console.error(`[workday:${stepName}] Fields: ${labelInfos.length}`);

    const preparedQuestions = await _buildQs(page, map, { includeNonRequired, includeDateFields });
    console.error(`[workday:${stepName}] Prepared questions: ${preparedQuestions.length}`);

    let fillResults = [];
    if (preparedQuestions.length > 0) {
        const llmQuestions = preparedQuestions.map((q) => q.llmRequest).filter(Boolean);
        const llmOutput = await _getLlm({
            atsName: "workday",
            jobTitle: job?.title || job?.jobTitle || "",
            jobDescription: job?.description || "",
            questions: llmQuestions,
            jobUrl: job?.url || "",
        }, stepName);

        const llmAnswerMap = new Map();
        for (const row of llmOutput?.answers || []) {
            if (row?.id) llmAnswerMap.set(row.id, row.answer);
            if (row?.keyPath) llmAnswerMap.set(row.keyPath, row.answer);
        }

        fillResults = await _fillQs(page, preparedQuestions, llmAnswerMap);
    }

    return { preparedQuestions, fillResults };
}

/**
 * Fill a Workday type-2 multiselect (type-ahead) input.
 * Pass the Playwright ElementHandle of the inner text input element and the value to type.
 * Uses page.evaluate to click the matching menu item to bypass any intercepting overlay.
 * Handles both data-automation-id="menuItem" and data-automation-id="promptOption".
 */
export async function fillMultiselectField(page, inputEl, value) {
    const rawValue = String(value ?? "");

    function normalizeForLog(s) {
        return String(s ?? "")
            .replace(/\u00A0/g, " ")
            .replace(/Â/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    }

    await page.evaluate((el) => {
        el.focus();
        el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    }, inputEl);

    await inputEl.press("Control+A").catch(() => { });
    await inputEl.press("Meta+A").catch(() => { });
    await inputEl.press("Backspace").catch(() => { });
    await inputEl.type(rawValue, { delay: 30 });

    await page.waitForTimeout(200);

    await page.evaluate((el) => {
        el.dispatchEvent(new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13
        }));
    }, inputEl);

    await page.waitForTimeout(200);

    await page.evaluate((el) => {
        el.dispatchEvent(new KeyboardEvent("keyup", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13
        }));
    }, inputEl);

    await page.waitForTimeout(200);

    const popupXPaths = [
        `//div[@data-automation-activepopup="true" or @data-automation-id="activeListContainer"]`,
        `//div[contains(@data-automation-id, "promptOption")]`,
        `//div[@data-automation-id="menuItem"]`,
        `//div[@data-automation-id="promptTitle"]`,
        `//div[@data-automation-id="promptMessage"]`
    ];

    await page.waitForFunction((xpaths) => {
        return xpaths.some((xp) => {
            try {
                return !!document.evaluate(
                    xp,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                ).singleNodeValue;
            } catch {
                return false;
            }
        });
    }, popupXPaths, { timeout: 5000 }).catch(() => { });

    await page.waitForTimeout(500);

    const selected = await page.evaluate((val) => {
        function normalizeText(s) {
            return String(s ?? "")
                .replace(/\u00A0/g, " ")
                .replace(/Â/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
        }

        function isVisible(el) {
            return !!(el && el.offsetParent !== null);
        }

        function realClick(el) {
            const opts = { bubbles: true, cancelable: true };
            el.dispatchEvent(new MouseEvent("mousedown", opts));
            el.dispatchEvent(new MouseEvent("mouseup", opts));
            if (typeof el.click === "function") {
                el.click();
            } else {
                el.dispatchEvent(new MouseEvent("click", opts));
            }
        }

        const normalizedValue = normalizeText(val);

        const candidates = Array.from(
            document.querySelectorAll(
                '[data-automation-activepopup="true"] [data-automation-id="promptOption"], ' +
                '[data-automation-id="activeListContainer"] [data-automation-id="promptOption"], ' +
                '[data-automation-activepopup="true"] [data-automation-id="menuItem"] [data-automation-id="promptOption"], ' +
                '[data-automation-id="activeListContainer"] [data-automation-id="menuItem"] [data-automation-id="promptOption"]'
            )
        ).filter((el, index, arr) => {
            if (!isVisible(el)) return false;
            if (arr.indexOf(el) !== index) return false;

            const parent = el.parentElement;
            if (parent && parent.getAttribute("data-automation-checked") === "Checked") {
                return false;
            }

            return true;
        });

        const mapped = candidates.map((el) => {
            const rawText = el.getAttribute("data-automation-label") || el.textContent || "";
            const normalizedText = normalizeText(rawText);

            return {
                el,
                rawText: rawText.trim(),
                normalizedText,
                exact: normalizedText === normalizedValue,
                startsWith: normalizedText.startsWith(normalizedValue),
                includes: normalizedText.includes(normalizedValue)
            };
        });

        console.log("[fillMultiselectField] candidates:");
        mapped.forEach((item, i) => {
            console.log(`Option ${i + 1}:`, {
                text: item.rawText,
                normalizedText: item.normalizedText,
                normalizedValue,
                exact: item.exact,
                startsWith: item.startsWith,
                includes: item.includes,
                element: item.el
            });
        });

        const best =
            mapped.find((item) => item.exact) ||
            mapped.find((item) => item.startsWith) ||
            mapped.find((item) => item.includes) ||
            null;

        if (!best) {
            return null;
        }

        realClick(best.el);

        return {
            clicked: best.rawText,
            normalizedText: best.normalizedText,
            normalizedValue,
            exact: best.exact,
            startsWith: best.startsWith,
            includes: best.includes
        };
    }, rawValue);

    if (selected) {
        console.error(
            `[fillMultiselectField] option clicked: "${selected.clicked}" | exact=${selected.exact} startsWith=${selected.startsWith} includes=${selected.includes}`
        );
    } else {
        console.error(`[fillMultiselectField] no option found for "${rawValue}" -> skipping click`);
    }

    await page.waitForTimeout(100);

    await page.evaluate(() => {
        (document.activeElement || document.body).dispatchEvent(
            new KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                key: "Escape",
                code: "Escape",
                keyCode: 27,
                which: 27
            })
        );
    }).catch(() => { });

    const mainXPaths = [`//div[@id="mainContent"]`, `//main`];

    for (let i = 0; i < 2; i++) {
        await page.evaluate((xpaths) => {
            for (const xp of xpaths) {
                try {
                    const el = document.evaluate(
                        xp,
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                    ).singleNodeValue;

                    if (el) {
                        const opts = { bubbles: true, cancelable: true };
                        el.dispatchEvent(new MouseEvent("mousedown", opts));
                        el.dispatchEvent(new MouseEvent("mouseup", opts));
                        if (typeof el.click === "function") {
                            el.click();
                        } else {
                            el.dispatchEvent(new MouseEvent("click", opts));
                        }
                        return;
                    }
                } catch { }
            }
        }, mainXPaths).catch(() => { });

        await page.waitForTimeout(100);
    }

    await page.waitForTimeout(300);
}

export async function getJobPostingDetails(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => { });

    const titleLocator = page.locator(JOB_POSTING.HEADER).first();
    const descriptionLocator = page.locator(JOB_POSTING.DESCRIPTION).first();

    const title = normalizeText(
        await titleLocator.textContent({ timeout: 5_000 }).catch(() => "")
    );
    const description = normalizeText(
        await descriptionLocator.evaluate((element) => element.innerText || element.textContent || "").catch(() => "")
    );


    return { title, description };
}

/** Alias used by job-scraper.js — same implementation as getJobPostingDetails. */
export const scrapeJobDetails = getJobPostingDetails;

export async function isPastAuth(page) {
    const nextBtn = await page.locator(AUTH_STATE.BOTTOM_NAV_NEXT).isVisible({ timeout: 1_000 }).catch(() => false);
    const saveBtn = await page.locator(AUTH_STATE.SAVE_AND_CONTINUE).isVisible({ timeout: 1_000 }).catch(() => false);
    const formHeader = await page.locator(AUTH_STATE.FORM_HEADER).isVisible({ timeout: 1_000 }).catch(() => false);
    const urlGone = !page.url().includes("applyManually");
    console.error(`[workday:isPastAuth] nextBtn=${nextBtn}  saveBtn=${saveBtn}  formHeader=${formHeader}  urlChanged=${urlGone}`);
    return nextBtn || saveBtn || formHeader || urlGone;
}

export async function getVisibleErrors(page) {
    try {
        return await page.evaluate((sel) =>
            [...document.querySelectorAll(sel.ERROR_BLOCK)]
                .filter((el) => el.offsetParent !== null && el.textContent.trim().length > 0)
                .map((el) => el.textContent.trim().substring(0, 150))
            , STEP_LOOP);
    } catch (e) {
        if (/context.*destroyed|navigation/i.test(e.message ?? "")) return [];
        throw e;
    }
}

export async function dumpAutomationIds(page, label) {
    const elements = await page.evaluate((sel) =>
        [...document.querySelectorAll(sel.DUMP_ALL)]
            .filter((el) => el.offsetParent !== null)
            .map((el) => ({
                tag: el.tagName,
                id: el.getAttribute("data-automation-id"),
                txt: el.textContent.trim().substring(0, 50),
            }))
        , STEP_LOOP);
    console.error(`[workday:${label}] Visible automation-id elements:`, JSON.stringify(elements, null, 2));
}
