/**
 * workday/form-filler.mjs
 * Fill Workday prepared questions using LLM answers.
 * Handles 3 types: text, textarea, select.
 *
 * @param {import('playwright').Page} page
 * @param {Array} preparedQuestions  — output of buildWorkdayPreparedQuestions
 * @param {Map<string, any>} llmAnswerMap  — keyed by id or keyPath
 * @returns {Promise<Array>}  — fill result rows
 */
import { DOM_HELPERS_SRC, REALISTIC_CLICK_SRC } from "./helpers.mjs";

export async function fillWorkdayPreparedQuestions(page, preparedQuestions, llmAnswerMap) {
    const results = [];
    const questions = Array.isArray(preparedQuestions) ? preparedQuestions : [];

    for (const question of questions) {
        await page.waitForTimeout(250);

        const answer = getAnswerForQuestion(question, llmAnswerMap);
        const result = question?.type === "date"
            ? await fillDateQuestion(page, question, answer).catch((err) => ({
                ok: false,
                reason: err instanceof Error ? err.message : String(err),
            }))
            : await fillOneWorkdayQuestion(page, question, answer).catch((err) => ({
                ok: false,
                reason: err instanceof Error ? err.message : String(err),
            }));

        results.push({
            id: question?.id || "",
            keyPath: question?.keyPath || "",
            labelText: question?.labelText || "",
            type: question?.type || "",
            answer,
            result,
        });

        console.error(
            `[workday:form-filler] ${question?.labelText || question?.keyPath} (${question?.type}): ${result?.ok ? "✅" : "❌ " + String(result?.reason || "")}`
        );
    }

    return results;
}

function getAnswerForQuestion(question, answerMap) {
    if (!(answerMap instanceof Map)) return undefined;
    if (question?.id && answerMap.has(question.id)) return answerMap.get(question.id);
    if (question?.keyPath && answerMap.has(question.keyPath)) return answerMap.get(question.keyPath);
    return undefined;
}

async function fillOneWorkdayQuestion(page, question, answer) {
    return page.evaluate(async ({ q, ans, domSrc, clickSrc }) => {
        eval(domSrc);
        eval(clickSrc);
        function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
        function normalizeLoose(v) {
            return String(v ?? "").replace(/\u00c2\u00a0/g, " ").replace(/[^a-zA-Z0-9\\s]/g, " ").replace(/\\s+/g, " ").trim().toLowerCase();
        }

        function triggerTextInput(el, value) {
            el.focus();
            const inputDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
            const textareaDesc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
            if (el instanceof HTMLInputElement && inputDesc?.set) inputDesc.set.call(el, value);
            else if (el instanceof HTMLTextAreaElement && textareaDesc?.set) textareaDesc.set.call(el, value);
            else if ("value" in el) el.value = value;
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.blur();
        }

        // Replace %UPPERVALUE%/%LOWERVALUE% tokens in fillActions XPath paths
        function replaceTokens(template, value) {
            const raw = String(value ?? "");
            return String(template || "")
                .replace(/%UPPERVALUE%/g, raw.toUpperCase())
                .replace(/%LOWERVALUE%/g, raw.toLowerCase())
                .replace(/%UPPERUNMAPPEDVALUE%/g, raw.toUpperCase())
                .replace(/%LOWERUNMAPPEDVALUE%/g, raw.toLowerCase());
        }

        function scoreOptionMatch(optionText, answerText) {
            const opt = normalizeLoose(optionText);
            const ans = normalizeLoose(answerText);
            if (!opt || !ans) return 0;
            if (opt === ans) return 1000;
            if (opt.startsWith(ans) || ans.startsWith(opt)) return 900;
            if (opt.includes(ans) || ans.includes(opt)) return 800;
            const optTokens = new Set(opt.split(" ").filter(Boolean));
            const ansTokens = ans.split(" ").filter(Boolean);
            let overlap = 0;
            for (const t of ansTokens) if (optTokens.has(t)) overlap++;
            return overlap;
        }

        // ── Resolve elements ────────────────────────────────────────────────────
        const fieldEl = resolveElement(q?.simplify?.foundFieldElement);
        const inputEl = resolveElement(q?.simplify?.foundInputElement);
        const qType = String(q?.type || "").toLowerCase();
        const answerStr = String(ans ?? "").trim();

        if (!answerStr) return { ok: false, reason: "empty_answer" };

        // ── text / textarea ─────────────────────────────────────────────────────
        if (qType === "text" || qType === "textarea") {
            const target = (inputEl instanceof HTMLInputElement || inputEl instanceof HTMLTextAreaElement)
                ? inputEl
                : (fieldEl instanceof HTMLInputElement || fieldEl instanceof HTMLTextAreaElement)
                    ? fieldEl
                    : (fieldEl?.querySelector?.("textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio])") || null);
            if (!target) return { ok: false, reason: "text_input_not_found" };
            triggerTextInput(target, answerStr);
            return { ok: true, strategy: qType, value: answerStr };
        }

        // ── select (listbox button) ─────────────────────────────────────────────
        if (qType === "select") {
            const clickable = inputEl || fieldEl;
            if (!clickable) return { ok: false, reason: "select_button_not_found" };

            const actions = Array.isArray(q?.fillActions) && q.fillActions.length
                ? q.fillActions
                : (Array.isArray(q?.trackedInputSelector?.fillActions) ? q.trackedInputSelector.fillActions : []);

            // Process non-valueRequired actions first (click to open, keydown arrow, etc.)
            for (const action of actions) {
                if (action?.valueRequired) continue;
                if (action?.method === "click") {
                    realisticClick(clickable);
                    await sleep(action?.delay ?? 300);
                } else if (action?.event) {
                    clickable.dispatchEvent(new KeyboardEvent(action.event, {
                        bubbles: action.eventOptions?.bubbles ?? true,
                        cancelable: action.eventOptions?.cancelable ?? true,
                        keyCode: action.eventOptions?.keyCode,
                        key: action.eventOptions?.key,
                    }));
                    await sleep(action?.delay ?? 50);
                }
            }

            // Try valueRequired actions (XPath template matching with token replacement)
            const roots = [fieldEl, inputEl, document].filter(Boolean);
            for (const action of actions) {
                if (!action?.valueRequired) continue;
                const paths = Array.isArray(action?.path) ? action.path : [];
                for (const templatePath of paths) {
                    const resolvedPath = replaceTokens(templatePath, answerStr);
                    for (const root of roots) {
                        const nodes = xpathAll(resolvedPath, root);
                        if (nodes.length > 0) {
                            await sleep(action?.time ?? 500);
                            realisticClick(nodes[0]);
                            await sleep(300);
                            return {
                                ok: true,
                                strategy: "select-fill-actions",
                                clickedText: normalizeText(nodes[0].textContent || answerStr),
                            };
                        }
                    }
                }
            }

            // Fallback: score-match against any visible listbox options
            await sleep(500);
            const fallbackOptions = xpathAll(
                '//div[@visibility="opened"]//ul[@role="listbox"]//li[@role="option"][not(@aria-disabled="true")]',
                document
            );
            let bestNode = null;
            let bestScore = 0;
            for (const opt of fallbackOptions) {
                const score = scoreOptionMatch(opt.textContent || "", answerStr);
                if (score > bestScore) { bestScore = score; bestNode = opt; }
            }
            if (bestNode && bestScore > 0) {
                realisticClick(bestNode);
                return {
                    ok: true,
                    strategy: "select-fallback",
                    clickedText: normalizeText(bestNode.textContent || answerStr),
                    score: bestScore,
                };
            }

            return { ok: false, reason: "select_option_not_found", value: answerStr };
        }

        // ── checkbox (CheckboxGroup) ────────────────────────────────────────────
        if (qType === "checkbox") {
            // Parse answer: JSON array, CSV, or single string
            let valuesToSelect = [];
            try {
                const parsed = JSON.parse(answerStr);
                if (Array.isArray(parsed)) valuesToSelect = parsed.map(String).filter(Boolean);
                else if (parsed) valuesToSelect = [String(parsed)];
            } catch {
                valuesToSelect = answerStr.split(/\s*,\s*/).filter(Boolean);
            }

            if (!valuesToSelect.length) return { ok: false, reason: "empty_answer" };

            // ── Step 0: uncheck boxes that are NOT in our wanted selection ──────
            if (fieldEl) {
                const allCheckboxes = xpathAll(
                    './/fieldset[contains(@data-automation-id,"CheckboxGroup")]//input[@type="checkbox"]',
                    fieldEl
                );
                for (const cb of allCheckboxes) {
                    const isChecked = cb.checked || cb.getAttribute("aria-checked") === "true";
                    if (!isChecked) continue;
                    const id = cb.getAttribute("id");
                    const labelEl = id ? document.querySelector(`label[for="${id}"]`) : null;
                    const labelText = normalizeText((labelEl || cb).textContent || "");
                    // Skip uncheck if this box is one we want to select
                    const isWanted = valuesToSelect.some(v => scoreOptionMatch(labelText, v) > 0);
                    if (isWanted) continue;
                    realisticClick(labelEl || cb);
                    await sleep(150);
                }
            }

            const actions = Array.isArray(q?.fillActions) && q.fillActions.length
                ? q.fillActions
                : (Array.isArray(q?.trackedInputSelector?.fillActions) ? q.trackedInputSelector.fillActions : []);

            const clickedValues = [];
            const skippedValues = [];
            const roots = [fieldEl, document].filter(Boolean);

            for (const targetValue of valuesToSelect) {
                let clicked = false;

                // Try valueRequired fillActions XPaths (exact → startsWith → word-contains)
                for (const action of actions) {
                    if (!action?.valueRequired) continue;
                    const paths = Array.isArray(action?.path) ? action.path : [];
                    for (const templatePath of paths) {
                        const resolvedPath = replaceTokens(templatePath, targetValue);
                        for (const root of roots) {
                            const nodes = xpathAll(resolvedPath, root);
                            if (nodes.length > 0) {
                                // Find the associated input to check its current state
                                const node = nodes[0];
                                const inputEl = node.tagName === "INPUT" ? node
                                    : node.querySelector?.("input[type='checkbox']")
                                    || (node.htmlFor ? document.getElementById(node.htmlFor) : null);
                                const alreadyChecked = inputEl
                                    ? (inputEl.checked || inputEl.getAttribute("aria-checked") === "true")
                                    : false;
                                if (!alreadyChecked) {
                                    await sleep(300);
                                    realisticClick(node);
                                    await sleep(200);
                                }
                                clickedValues.push(normalizeText(node.textContent || targetValue));
                                clicked = true;
                                break;
                            }
                        }
                        if (clicked) break;
                    }
                    if (clicked) break;
                }

                // Fallback: match checkbox label by score
                if (!clicked && fieldEl) {
                    const checkboxes = xpathAll(
                        './/fieldset[contains(@data-automation-id,"CheckboxGroup")]//input[@type="checkbox"]',
                        fieldEl
                    );
                    let bestEl = null;
                    let bestScore = 0;
                    let bestLabel = null;

                    for (const cb of checkboxes) {
                        const id = cb.getAttribute("id");
                        const labelEl = id ? document.querySelector(`label[for="${id}"]`) : null;
                        const labelText = normalizeText((labelEl || cb).textContent || "");
                        const score = scoreOptionMatch(labelText, targetValue);
                        if (score > bestScore) { bestScore = score; bestEl = cb; bestLabel = labelEl; }
                    }

                    if (bestEl && bestScore > 0) {
                        const alreadyChecked = bestEl.checked || bestEl.getAttribute("aria-checked") === "true";
                        if (!alreadyChecked) {
                            realisticClick(bestLabel || bestEl);
                            await sleep(200);
                        }
                        clickedValues.push(normalizeText((bestLabel || bestEl).textContent || targetValue));
                        clicked = true;
                    }
                }

                if (!clicked) skippedValues.push(targetValue);
            }

            return {
                ok: clickedValues.length > 0,
                strategy: "checkbox",
                clickedValues,
                skippedValues,
            };
        }

        return { ok: false, reason: `unsupported_type:${qType}` };
    }, { q: question, ans: answer, domSrc: DOM_HELPERS_SRC, clickSrc: REALISTIC_CLICK_SRC });
}

async function fillDateQuestion(page, question, answer) {
    const answerStr = String(answer ?? "").trim();
    if (!answerStr) return { ok: false, reason: "empty_answer" };

    const PART_TO_ID = {
        month: "dateSectionMonth-input",
        day: "dateSectionDay-input",
        year: "dateSectionYear-input",
    };

    // Parse date parts from string (ISO YYYY-MM-DD, YYYY-MM, MM/DD/YYYY, MM/YYYY)
    function parseDateParts(str) {
        const iso = str.match(/(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
        if (iso) return { year: iso[1], month: iso[2].padStart(2, "0"), day: iso[3] ? iso[3].padStart(2, "0") : null };
        const mdy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (mdy) return { month: mdy[1].padStart(2, "0"), day: mdy[2].padStart(2, "0"), year: mdy[3] };
        const my = str.match(/^(\d{1,2})\/(\d{4})$/);
        if (my) return { month: my[1].padStart(2, "0"), day: null, year: my[2] };
        return null;
    }

    const parts = parseDateParts(answerStr);
    if (!parts) return { ok: false, reason: "date_parse_failed", value: answerStr };

    const containerExists = await page.evaluate(
        (sel) => !!document.querySelector(sel),
        question.dateContainerSelector
    );
    if (!containerExists) return { ok: false, reason: "date_container_not_found", selector: question.dateContainerSelector };

    const filledParts = [];
    for (const part of (question.dateInputs || [])) {
        const automationId = PART_TO_ID[part];
        const value = parts[part];
        if (!automationId || !value) continue;

        // Strip leading zeros for number inputs (Workday date spinbuttons)
        const normValue = String(parseInt(value, 10));

        const filled = await page.evaluate(({ containerSel, automationId, value }) => {
            const container = document.querySelector(containerSel);
            if (!container) return false;
            const inputEl = container.querySelector(`[data-automation-id="${automationId}"]`);
            if (!inputEl) return false;
            inputEl.focus();
            const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
            if (desc?.set) desc.set.call(inputEl, value);
            else inputEl.value = value;
            inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
            inputEl.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }, { containerSel: question.dateContainerSelector, automationId, value: normValue });

        if (filled) {
            filledParts.push(`${part}=${normValue}`);
            await page.waitForTimeout(500); // let React process the input before the next part
        }
    }

    // Blur once after all parts are filled so Workday doesn't validate an incomplete date mid-fill
    await page.evaluate((containerSel) => {
        const container = document.querySelector(containerSel);
        if (!container) return;
        const focused = container.querySelector("input:focus");
        if (focused) focused.blur();
    }, question.dateContainerSelector);

    return { ok: filledParts.length > 0, strategy: "date", filledParts, value: answerStr };
}
