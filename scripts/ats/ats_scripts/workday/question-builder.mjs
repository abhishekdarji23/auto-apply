import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sortMapEntriesByDomOrder } from "../../utils/helpers.mjs";
import { DOM_HELPERS_SRC, REALISTIC_CLICK_SRC } from "./helpers.mjs";

// DOM helpers are now imported from ./helpers.mjs as DOM_HELPERS_SRC and REALISTIC_CLICK_SRC

/**
 * Resolve each tracked entry's label from the live DOM (so we get the real
 * text including the trailing "*" that marks required fields).
 *
 * Returns an array of:
 *   { keyPath, rawLabelText, labelText (without *), isRequired }
 *
 * @param {import('playwright').Page} page
 * @param {object|null} simplifyFoundInputMap
 * @returns {Promise<Array<{keyPath:string,rawLabelText:string,labelText:string,isRequired:boolean}>>}
 */
export async function getTrackedEntryLabels(page, simplifyFoundInputMap) {
    if (!page || !simplifyFoundInputMap) return [];

    const sortedTrackedEntries = await sortMapEntriesByDomOrder(page, simplifyFoundInputMap, {
        keyPrefix: "trackedInput:",
    });

    return page.evaluate(({ trackedEntries, domSrc }) => {
        eval(domSrc);

        // Fallback label paths to try on the field element when foundLabelElement is absent
        const LABEL_PATHS = [
            "./label",
            "./fieldset/legend",
            "./fieldset/label",
            './/div[@data-automation-id="richText"]/p',
        ];

        const result = [];
        for (const [key, value] of trackedEntries) {
            // Prefer resolved foundLabelElement → full text incl. "*"
            const labelEl = resolveElement(value?.foundLabelElement);
            const fieldEl = resolveElement(value?.foundFieldElement);

            let rawText = "";
            if (labelEl) {
                rawText = normalizeText(labelEl.textContent || "");
            } else if (fieldEl) {
                for (const p of LABEL_PATHS) {
                    const nodes = xpathAll(p, fieldEl);
                    if (nodes.length > 0) {
                        rawText = normalizeText(nodes[0].textContent || "");
                        if (rawText) break;
                    }
                }
            }
            // Last resort: stored labelText (may lack "*")
            if (!rawText) rawText = normalizeText(value?.labelText || "");

            const isRequired = /\*\s*$/.test(rawText) || rawText.includes(" *");
            const labelText = rawText.replace(/\s*\*\s*$/, "").trim();

            result.push({
                keyPath: String(value?.keyPath || key),
                rawLabelText: rawText,
                labelText,
                isRequired,
            });
        }
        return result;
    }, { trackedEntries: sortedTrackedEntries, domSrc: DOM_HELPERS_SRC });
}

/**
 * Build the prepared questions list for the current Workday page.
 *
 * Type detection (Workday has 3 types):
 *   "select"   — input is a <button aria-haspopup="listbox"> (Type 2 from fieldPath)
 *   "textarea" — input is a <textarea>                        (Type 1 sub-type)
 *   "text"     — input is a plain <input>                     (Type 1 sub-type)
 *
 * @param {import('playwright').Page} page
 * @param {object|null} simplifyFoundInputMap
 * @param {{ includeNonRequired?: boolean }} [opts]
 *   includeNonRequired=false (default) → only required fields (*-labelled)
 *   includeNonRequired=true            → all tracked fields
 * @returns {Promise<Array<object>>}
 */
export async function buildWorkdayPreparedQuestions(page, simplifyFoundInputMap, { includeNonRequired = false, includeDateFields = false } = {}) {
    if (!page || !simplifyFoundInputMap) return [];

    const sortedTrackedEntries = await sortMapEntriesByDomOrder(page, simplifyFoundInputMap, {
        keyPrefix: "trackedInput:",
    });
    if (!sortedTrackedEntries.length) return [];

    const result = await page.evaluate(async ({ trackedEntries, addNonRequired, domSrc, clickSrc }) => {
        eval(domSrc);
        eval(clickSrc);

        function dedupeOptions(arr) {
            const seen = new Set();
            return arr
                .map((s) => normalizeText(s))
                .filter((s) => { if (!s || seen.has(s.toLowerCase())) return false; seen.add(s.toLowerCase()); return true; });
        }

        // ── Label resolution ───────────────────────────────────────────────────
        const LABEL_FALLBACK_PATHS = [
            "./label",
            "./fieldset/legend",
            "./fieldset/label",
            './/div[@data-automation-id="richText"]/p',
        ];

        function resolveLabel(value, fieldEl) {
            const labelEl = resolveElement(value?.foundLabelElement);
            if (labelEl) return normalizeText(labelEl.textContent || "");
            if (fieldEl) {
                for (const p of LABEL_FALLBACK_PATHS) {
                    const nodes = xpathAll(p, fieldEl);
                    if (nodes.length > 0) {
                        const text = normalizeText(nodes[0].textContent || "");
                        if (text) return text;
                    }
                }
            }
            return normalizeText(value?.labelText || "");
        }

        // ── Type detection ─────────────────────────────────────────────────────
        function isCheckboxGroup(value) {
            const optPaths = Array.isArray(value?.trackedInputSelector?.optionsPath)
                ? value.trackedInputSelector.optionsPath
                : [];
            return optPaths.some((p) => p.includes('type="checkbox"') || p.includes("CheckboxGroup"));
        }

        function detectType(inputEl) {
            if (!inputEl) return "text";
            if (inputEl instanceof HTMLButtonElement && inputEl.getAttribute("aria-haspopup") === "listbox") return "select";
            if (inputEl instanceof HTMLTextAreaElement) return "textarea";
            return "text";
        }

        // ── Checkbox options collection ────────────────────────────────────────
        function collectCheckboxOptions(fieldEl, value) {
            const selector = value?.trackedInputSelector || {};
            const optionsPaths = Array.isArray(selector.optionsPath) ? selector.optionsPath : [];
            const optionsTextPaths = Array.isArray(selector.optionsTextPath) ? selector.optionsTextPath : [];

            const checkboxInputs = optionsPaths.flatMap((p) => xpathAll(p, fieldEl));

            return checkboxInputs.map((cb) => {
                // 1. label[for="id"] — most reliable
                const id = cb.getAttribute("id");
                if (id) {
                    const byFor = cb.ownerDocument.querySelector(`label[for="${id}"]`);
                    if (byFor) {
                        const t = normalizeText(byFor.textContent || "");
                        if (t) return t;
                    }
                }
                // 2. optionsTextPath XPaths relative to the checkbox input
                for (const tp of optionsTextPaths) {
                    try {
                        const nodes = xpathAll(tp, cb);
                        const t = nodes.map((n) => normalizeText(n.textContent || "")).filter(Boolean).join(" | ");
                        if (t) return t;
                    } catch { /* xpath like current() only works in XSLT, skip */ }
                }
                return normalizeText(cb.textContent || "");
            }).filter(Boolean);
        }

        // ── Select options collection ──────────────────────────────────────────
        async function collectSelectOptions(fieldEl, inputEl, optionsPaths) {
            if (!inputEl) return [];

            // Open the dropdown
            realisticClick(inputEl);
            await new Promise((r) => setTimeout(r, 600));

            const rawOptions = [];

            // Use optionsPath from trackedInputSelector (relative to fieldEl, includes ancestor:: axis)
            for (const path of optionsPaths) {
                const contextNode = fieldEl || document;
                const nodes = xpathAll(path, contextNode);
                for (const node of nodes) {
                    const text = normalizeText(node.textContent || "");
                    if (text) rawOptions.push(text);
                }
            }

            // Fallback: global listbox scan in case the path yielded nothing
            if (!rawOptions.length) {
                const fallback = xpathAll(
                    '//div[@visibility="opened"]//ul[@role="listbox"]//li[@role="option"][not(@aria-disabled="true")]',
                    document
                );
                for (const node of fallback) {
                    const text = normalizeText(node.textContent || "");
                    if (text && !text.toLowerCase().includes("select one")) rawOptions.push(text);
                }
            }

            // Close the dropdown
            inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
            await new Promise((r) => setTimeout(r, 300));

            return dedupeOptions(rawOptions);
        }

        // ── Main loop ──────────────────────────────────────────────────────────
        const output = [];

        for (const [key, value] of trackedEntries) {
            const fieldEl = resolveElement(value?.foundFieldElement);
            const inputEl = resolveElement(value?.foundInputElement);

            // Resolve real label text from DOM (includes trailing * for required)
            const rawLabelText = resolveLabel(value, fieldEl);
            const isRequired = /\*\s*$/.test(rawLabelText) || / \*/.test(rawLabelText);
            const labelText = rawLabelText.replace(/\s*\*\s*$/, "").trim();

            // Skip non-required fields when caller only wants required ones
            if (!addNonRequired && !isRequired) continue;

            // Checkbox detection before inputEl-based type detection
            const type = isCheckboxGroup(value) ? "checkbox" : detectType(inputEl);

            // Collect options for select — click to open, read list, close
            let options = [];
            if (type === "select") {
                const selector = value?.trackedInputSelector || {};
                const optionsPaths = Array.isArray(selector?.optionsPath) ? selector.optionsPath : [];
                options = await collectSelectOptions(fieldEl, inputEl, optionsPaths);
            } else if (type === "checkbox") {
                const cbOptions = collectCheckboxOptions(fieldEl, value);
                options = dedupeOptions(cbOptions);
            }

            const questionId = `Que${output.length + 1}`;
            const trackedInputSelector = value?.trackedInputSelector || null;

            output.push({
                id: questionId,
                keyPath: String(value?.keyPath || key),
                labelText,
                question: labelText,
                type,
                options,
                isRequired,
                trackedInputSelector,
                fillActions: Array.isArray(trackedInputSelector?.fillActions) ? trackedInputSelector.fillActions : [],
                simplify: {
                    keyPath: String(value?.keyPath || key),
                    labelText,
                    trackedInputSelector,
                    foundFieldElement: value?.foundFieldElement || null,
                    foundInputElement: value?.foundInputElement || null,
                    foundLabelElement: value?.foundLabelElement || null,
                    foundOptionsElements: Array.isArray(value?.foundOptionsElements) ? value.foundOptionsElements : [],
                },
                llmRequest: {
                    id: questionId,
                    keyPath: String(value?.keyPath || key),
                    question: type === "checkbox"
                        ? `${labelText} — Select ALL that apply. Return a JSON array of exact option strings, e.g. ["Option A","Option B"]. If none apply return [].`
                        : labelText,
                    type,
                    options,
                },
            });
        }

        return output;
    }, { trackedEntries: sortedTrackedEntries, addNonRequired: includeNonRequired, domSrc: DOM_HELPERS_SRC, clickSrc: REALISTIC_CLICK_SRC });

    // ── Date fields (application questions only) ──────────────────────────────
    if (includeDateFields) {
        const dateQuestions = await page.evaluate(({ domSrc, startIndex }) => {
            eval(domSrc);

            const FIELD_XPATH = ".//div[contains(@data-automation-id, 'formField') and descendant::*[@data-automation-id='dateInputWrapper'] and not(ancestor::div[@data-automation-id='signInContent'])]";
            const LABEL_PATHS = ["./fieldset/legend", "./fieldset/label", "./label", ".//div[@data-automation-id='richText']/p"];
            const INPUT_DEFS = [
                { part: "month", automationId: "dateSectionMonth-input" },
                { part: "day", automationId: "dateSectionDay-input" },
                { part: "year", automationId: "dateSectionYear-input" },
            ];

            const containers = xpathAll(FIELD_XPATH, document);
            const out = [];

            for (const container of containers) {
                let labelText = "";
                for (const lp of LABEL_PATHS) {
                    const nodes = xpathAll(lp, container);
                    if (nodes.length > 0) {
                        labelText = normalizeText(nodes[0].textContent || "");
                        if (labelText) break;
                    }
                }
                if (!labelText) continue;

                const presentInputs = INPUT_DEFS
                    .filter(({ automationId }) => !!container.querySelector(`[data-automation-id="${automationId}"]`))
                    .map(({ part }) => part);
                if (presentInputs.length === 0) continue;

                const containerAutomationId = container.getAttribute("data-automation-id") || "";
                const isRequired = /\*\s*$/.test(labelText) || / \*/.test(labelText);
                const cleanLabel = labelText.replace(/\s*\*\s*$/, "").trim();
                const inputDesc = presentInputs.join("/"); // e.g. "month/year"

                const questionId = `Que${startIndex + out.length + 1}`;
                const keyPath = `date.${cleanLabel.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()}`;

                out.push({
                    id: questionId,
                    keyPath,
                    labelText: cleanLabel,
                    question: cleanLabel,
                    type: "date",
                    options: [],
                    isRequired,
                    dateInputs: presentInputs,
                    dateContainerSelector: `[data-automation-id="${containerAutomationId}"]`,
                    trackedInputSelector: null,
                    fillActions: [],
                    simplify: null,
                    llmRequest: {
                        id: questionId,
                        keyPath,
                        question: `${cleanLabel} — provide the date as YYYY-MM-DD format (only these parts are present: ${inputDesc})`,
                        type: "text",
                        options: [],
                    },
                });
            }

            return out;
        }, { domSrc: DOM_HELPERS_SRC, startIndex: result.length });

        console.error(`[workday:question-builder] Date fields found: ${dateQuestions.length}`);
        result.push(...dateQuestions);
    }

    console.error(`[workday:question-builder] Built ${result.length} questions (includeNonRequired=${includeNonRequired})`);
    result.forEach((q, i) => {
        console.error(`[workday:question-builder] Q${i + 1}: type=${q.type} required=${q.isRequired} options=${q.options.length} keyPath=${q.keyPath}`);
    });

    const outDir = path.join(process.cwd(), "scripts", "ats", "debug");
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "workday-prepared-questions.latest.json");
    writeFileSync(outFile, JSON.stringify(result, null, 2), "utf8");
    console.error(`[workday:question-builder] Saved prepared questions: ${outFile}`);

    return result;
}


