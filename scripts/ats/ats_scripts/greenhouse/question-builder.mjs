import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sortMapEntriesByDomOrder } from "../../utils/helpers.mjs";
import { QUESTION_BUILDER } from "./selectors.mjs";

/**
 * @param {import('playwright').Page} page
 * @param {*} simplifyFoundInputMap
 * @returns {Promise<Array<object>>}
 */
export async function buildGreenhousePreparedQuestions(page, simplifyFoundInputMap) {
    if (!page) return [];

    const sortedTrackedEntries = await sortMapEntriesByDomOrder(page, simplifyFoundInputMap, {
        keyPrefix: "trackedInput:",
    });

    const preparedQuestions = await page.evaluate(async ({ trackedEntries, sel }) => {

        function normalizeText(value) {
            return String(value ?? "").replace(/\s+/g, " ").trim();
        }

        function xpathAll(path, root) {
            const contextNode = root?.nodeType === Node.DOCUMENT_NODE ? root : (root || document);
            const doc = contextNode.nodeType === Node.DOCUMENT_NODE ? contextNode : contextNode.ownerDocument || document;
            const result = doc.evaluate(
                String(path || ""),
                contextNode,
                null,
                XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                null
            );
            const items = [];
            for (let i = 0; i < result.snapshotLength; i += 1) items.push(result.snapshotItem(i));
            return items;
        }

        function resolveContainer(foundContainer, fallbackRoot = document) {
            if (!foundContainer) return fallbackRoot;
            const parentRoot = foundContainer.parentFoundContainer
                ? resolveContainer(foundContainer.parentFoundContainer, fallbackRoot)
                : fallbackRoot;
            if (!foundContainer.containerPath || foundContainer.containerPath === ".") return parentRoot;
            const nodes = xpathAll(foundContainer.containerPath, parentRoot);
            return nodes[foundContainer.containerIndex || 0] || parentRoot;
        }

        function resolveElement(foundElement, fallbackRoot = document) {
            if (!foundElement) return null;
            const baseRoot = foundElement.foundContainer
                ? resolveContainer(foundElement.foundContainer, fallbackRoot)
                : fallbackRoot;
            if (!foundElement.elementPath || foundElement.elementPath === ".") return baseRoot;
            const nodes = xpathAll(foundElement.elementPath, baseRoot);
            return nodes[foundElement.elementIndex || 0] || null;
        }

        function clickElement(el) {
            if (!el) return;
            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            if (typeof el.click === "function") el.click();
        }

        async function closeOpenDropdownsBeforeQuestion() {
            const mainContainer = document.querySelector(sel.MAIN_CLICK_TARGET) || document.querySelector("main") || document.body;
            if (!mainContainer) return;

            clickElement(mainContainer);
            await new Promise((resolve) => setTimeout(resolve, 120));
            clickElement(mainContainer);
            await new Promise((resolve) => setTimeout(resolve, 120));
        }

        function triggerInputEvents(el) {
            if (!el) return;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
        }

        function clearSelectedValue(fieldEl, inputEl) {
            if (inputEl instanceof HTMLSelectElement) {
                inputEl.selectedIndex = -1;
                inputEl.value = "";
                triggerInputEvents(inputEl);
                return;
            }

            if (inputEl instanceof HTMLInputElement) {
                const currentValue = normalizeText(inputEl.value);
                if (currentValue) {
                    inputEl.value = "";
                    triggerInputEvents(inputEl);
                }
            }

            const clearButton = fieldEl?.querySelector?.(
                sel.CLEAR_BUTTON
            );
            if (clearButton) clickElement(clearButton);
        }

        function clearCheckedInputs(fieldEl, inputEl) {
            const scope = fieldEl || inputEl || document;
            const targets = Array.from(scope.querySelectorAll(sel.CHECKBOX_RADIO_INPUTS));
            const nativeCheckedSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;

            for (const target of targets) {
                if (!(target instanceof HTMLInputElement)) continue;
                if (!target.checked) continue;

                if (nativeCheckedSetter) {
                    nativeCheckedSetter.call(target, false);
                } else {
                    target.checked = false;
                }
                target.dispatchEvent(new Event("input", { bubbles: true }));
                target.dispatchEvent(new Event("change", { bubbles: true }));
            }
        }

        function collectOptionNodes(roots, optionPaths) {
            const nodes = [];
            for (const root of roots) {
                for (const path of optionPaths) {
                    const found = xpathAll(path, root);
                    for (const node of found) nodes.push(node);
                }
            }
            return nodes;
        }

        function detectType(entryValue, fieldEl, inputEl) {
            const selector = entryValue?.trackedInputSelector || {};
            const optionsPaths = Array.isArray(selector?.optionsPath) ? selector.optionsPath.map((p) => String(p || "")) : [];

            const inputType = String(inputEl?.type || "").toLowerCase();
            console.error(`[greenhouse:question-builder] Detecting type for keyPath=${entryValue?.keyPath} inputType=${inputType} fieldClass="${String(fieldEl?.className || "")}" optionsPaths=[${optionsPaths.join(", ")}]`);
            const fieldClass = String(fieldEl?.className || "").toLowerCase();
            const hasFoundOptions = Array.isArray(entryValue?.foundOptionsElements) && entryValue.foundOptionsElements.length > 0;
            const hasCheckboxLikeDescendants =
                !!fieldEl?.querySelector?.(sel.CHECKBOX_RADIO_DESCENDANTS);

            if (inputEl instanceof HTMLTextAreaElement) return "textarea";

            if (inputEl instanceof HTMLInputElement) {
                if (inputType === "checkbox" || inputType === "radio") return "checkbox";
                return "text";
            }

            if (inputEl instanceof HTMLSelectElement || fieldEl instanceof HTMLSelectElement) return "select";

            // Select check must run before checkbox check.
            const isSelect =
                new RegExp(sel.SELECT_CLASS_PATTERN).test(fieldClass) ||
                optionsPaths.some((p) => new RegExp(sel.SELECT_OPTION_PATH_PATTERN, "i").test(p));
            if (isSelect) return "select";

            const isCheckbox =
                hasFoundOptions ||
                hasCheckboxLikeDescendants ||
                optionsPaths.some((p) => new RegExp(sel.CHECKBOX_OPTION_PATH_PATTERN, "i").test(p));
            if (isCheckbox) return "checkbox";

            return "text";
        }

        function dedupeOptions(options) {
            const seen = new Set();
            const cleaned = [];
            for (const raw of options) {
                const text = normalizeText(raw);
                if (!text) continue;
                const key = text.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                cleaned.push(text);
            }
            return cleaned;
        }

        async function collectSelectOptions(entryValue, fieldEl, inputEl) {
            const selector = entryValue?.trackedInputSelector || {};
            const optionPaths = Array.isArray(selector?.optionsPath) ? selector.optionsPath : [];

            const clickable = inputEl || fieldEl;
            clearSelectedValue(fieldEl, inputEl);

            const roots = [fieldEl, inputEl, document].filter(Boolean);
            let optionNodes = collectOptionNodes(roots, optionPaths);
            const wasOpen = optionNodes.length > 0;

            if (clickable && !wasOpen) {
                clickElement(clickable);
                await new Promise((r) => setTimeout(r, 250));
                optionNodes = collectOptionNodes(roots, optionPaths);
            }

            const rawOptions = [];

            if (inputEl instanceof HTMLSelectElement) {
                for (const opt of Array.from(inputEl.options || [])) {
                    rawOptions.push(opt?.textContent || opt?.value || "");
                }
            }

            for (const node of optionNodes) {
                const text = normalizeText(node?.textContent || "");
                if (!text) continue;
                rawOptions.push(text);
            }

            if (clickable) {
                const shouldClose = wasOpen || optionNodes.length > 0;
                if (shouldClose) {
                    clickable.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
                    await new Promise((r) => setTimeout(r, 100));
                    const remaining = collectOptionNodes(roots, optionPaths);
                    if (remaining.length > 0) {
                        clickElement(clickable);
                    }
                }
            }

            return dedupeOptions(rawOptions);
        }

        function collectCheckboxOptions(entryValue, fieldEl) {
            const selector = entryValue?.trackedInputSelector || {};
            const optionsTextPaths = Array.isArray(selector?.optionsTextPath) ? selector.optionsTextPath : [];
            const rawOptions = [];

            const foundOptions = Array.isArray(entryValue?.foundOptionsElements)
                ? entryValue.foundOptionsElements
                : [];

            for (const foundOption of foundOptions) {
                const optionEl = resolveElement(foundOption);
                if (!optionEl) continue;

                if (optionsTextPaths.length > 0) {
                    for (const textPath of optionsTextPaths) {
                        const textNodes = xpathAll(textPath, optionEl);
                        for (const tn of textNodes) {
                            rawOptions.push(tn?.textContent || "");
                        }
                    }
                }

                if (optionEl instanceof HTMLInputElement) {
                    const byFor = optionEl.id
                        ? document.querySelector(`${sel.LABEL_WITH_FOR_PREFIX}"${CSS.escape(optionEl.id)}"]`)
                        : null;
                    if (byFor?.textContent) rawOptions.push(byFor.textContent);
                }

                const nearLabel = optionEl.closest("label") || optionEl.parentElement?.querySelector("label");
                if (nearLabel?.textContent) rawOptions.push(nearLabel.textContent);
            }

            if (!rawOptions.length && fieldEl) {
                const labels = Array.from(fieldEl.querySelectorAll(sel.CHECKBOX_LABELS));
                for (const lb of labels) rawOptions.push(lb?.textContent || "");
            }

            return dedupeOptions(rawOptions);
        }

        const result = [];
        for (const item of trackedEntries) {
            const [key, value] = item;
            await closeOpenDropdownsBeforeQuestion();
            const fieldEl = resolveElement(value?.foundFieldElement);
            const inputEl = resolveElement(value?.foundInputElement);
            const type = detectType(value, fieldEl, inputEl);
            const questionId = `Que${result.length + 1}`;

            let options = [];
            if (type === "select") {
                options = await collectSelectOptions(value, fieldEl, inputEl);
            } else if (type === "checkbox") {
                // Clear preselected checkbox/radio values first.
                clearCheckedInputs(fieldEl, inputEl);
                options = collectCheckboxOptions(value, fieldEl);
            }

            const labelText = String(value?.labelText || "");
            const trackedInputSelector = value?.trackedInputSelector || null;

            result.push({
                id: questionId,
                keyPath: String(value?.keyPath || key),
                labelText,
                question: labelText,
                type,
                options,
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
                    question: labelText,
                    type,
                    options,
                },
            });

            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        // Add cover letter only when required.
        const coverLetterGroup = document.querySelector(sel.COVER_LETTER_GROUP);
        if (coverLetterGroup) {
            const label = coverLetterGroup.querySelector(sel.COVER_LETTER_LABEL);
            const labelText = String(label?.textContent || "").replace(/\s+/g, " ").trim() || "Cover Letter";
            const requiredByAria = String(coverLetterGroup.getAttribute("aria-required") || "").toLowerCase() === "true";
            const requiredByStar = Boolean(label?.querySelector?.(sel.COVER_LETTER_REQUIRED_MARK)) || /\*/.test(String(label?.textContent || ""));
            const isRequired = requiredByAria || requiredByStar;

            if (isRequired) {
                const enterManuallyButton = coverLetterGroup.querySelector(sel.COVER_LETTER_ENTER_MANUAL)
                    || Array.from(coverLetterGroup.querySelectorAll(sel.BUTTON)).find((btn) => new RegExp(sel.ENTER_MANUAL_TEXT_PATTERN, "i").test(String(btn?.textContent || "")));
                if (enterManuallyButton) {
                    clickElement(enterManuallyButton);
                    await new Promise((resolve) => setTimeout(resolve, 250));
                }

                const textArea = coverLetterGroup.querySelector(sel.COVER_LETTER_TEXTAREA);
                if (textArea) {
                    const questionId = `Que${result.length + 1}`;
                    result.push({
                        id: questionId,
                        keyPath: "coverLetter:\"required\"",
                        labelText,
                        question: labelText,
                        type: "textarea",
                        options: [],
                        trackedInputSelector: null,
                        fillActions: [],
                        coverLetter: {
                            required: true,
                        },
                        simplify: {
                            keyPath: "coverLetter:\"required\"",
                            labelText,
                            trackedInputSelector: null,
                            foundFieldElement: null,
                            foundInputElement: null,
                            foundLabelElement: null,
                            foundOptionsElements: [],
                        },
                        llmRequest: {
                            id: questionId,
                            keyPath: "coverLetter:\"required\"",
                            question: labelText,
                            type: "textarea",
                            options: [],
                        },
                    });

                    // Collapse back to keep DOM index stable.
                    if (enterManuallyButton) {
                        clickElement(enterManuallyButton);
                        await new Promise((resolve) => setTimeout(resolve, 250));
                    }
                }
            }
        }

        return result;
    }, { trackedEntries: sortedTrackedEntries, sel: QUESTION_BUILDER });

    const outDir = path.join(process.cwd(), "scripts", "ats", "debug");
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "greenhouse-prepared-questions.latest.json");
    writeFileSync(outFile, JSON.stringify(preparedQuestions, null, 2), "utf8");
    console.error(`[greenhouse:question-builder] Saved temp prepared questions: ${outFile}`);

    return preparedQuestions;
}