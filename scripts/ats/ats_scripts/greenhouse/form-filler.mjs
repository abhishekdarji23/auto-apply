/**
 * Greenhouse-specific form filling (WIP).
 */

import { FORM_FILLER } from "./selectors.mjs";

/**
 * @param {import('playwright').Page} page
 * @param {Array} preparedQuestions
 * @param {Map<string, any>} llmAnswerByKeyPath
 * @returns {Promise<Array>}
 */
export async function fillGreenhousePreparedQuestions(page, preparedQuestions, llmAnswerByKeyPath) {
    const results = [];
    const allQuestions = Array.isArray(preparedQuestions) ? preparedQuestions : [];
    const regularQuestions = allQuestions.filter((q) => !q?.coverLetter?.required);
    const coverLetterQuestions = allQuestions.filter((q) => q?.coverLetter?.required);

    const clickedLocateMe = await page.evaluate((sel) => {
        const buttons = Array.from(document.querySelectorAll(sel.LOCATE_BUTTONS));
        const locateButton = buttons.find((btn) => {
            const text = String(btn?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            return text === sel.LOCATE_ME_TEXT;
        });
        if (locateButton && !locateButton.disabled) {
            locateButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            locateButton.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            locateButton.click();
            return true;
        }
        return false;
    }, FORM_FILLER);

    // Location autofill is slow after "Locate me" — wait before filling other fields.
    if (clickedLocateMe) {
        console.error("[greenhouse] Locate me clicked — waiting 5s for location fill…");
        await page.waitForTimeout(5000);
    } else {
        await page.waitForTimeout(250);
    }

    for (const question of regularQuestions) {
        if (String(question?.type || "").toLowerCase() === "select") {
            await page.waitForTimeout(250);
        }

        const answer = getAnswerForQuestion(question, llmAnswerByKeyPath);
        const result = await fillOneGreenhouseQuestion(page, question, answer).catch((error) => ({
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
        }));

        results.push({
            id: question?.id || "",
            keyPath: question?.keyPath || "",
            labelText: question?.labelText || "",
            type: question?.type || "",
            answer,
            result,
        });

        await page.waitForTimeout(250);
    }

    // Fill cover letter last so opening manual textarea does not disturb index-based mapping.
    for (const question of coverLetterQuestions) {
        const answer = getAnswerForQuestion(question, llmAnswerByKeyPath);
        const result = await fillOneGreenhouseQuestion(page, question, answer).catch((error) => ({
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
        }));

        results.push({
            id: question?.id || "",
            keyPath: question?.keyPath || "",
            labelText: question?.labelText || "",
            type: question?.type || "",
            answer,
            result,
        });

        await page.waitForTimeout(250);
    }

    const consentResult = await page.evaluate(async (sel) => {

        function sleep(ms) {
            return new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
        }

        function clickElement(el) {
            if (!el) return;
            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
            if (typeof el.click === "function") el.click();
        }

        function isDisabledConsentCheckbox(input, group) {
            const inputAriaDisabled = String(input?.getAttribute?.("aria-disabled") || "").toLowerCase() === "true";
            const groupAriaDisabled = String(group?.getAttribute?.("aria-disabled") || "").toLowerCase() === "true";
            const groupDisabledClass = Boolean(group?.classList?.contains(sel.CONSENT_DISABLED_CLASS));
            return Boolean(input?.disabled || inputAriaDisabled || groupAriaDisabled || groupDisabledClass);
        }

        function getConsentGroups() {
            return Array.from(document.querySelectorAll(sel.CONSENT_CHECKBOX_GROUPS));
        }

        function getGroupCheckboxInput(group) {
            if (!group?.querySelector) return null;
            const input = group.querySelector(sel.CONSENT_CHECKBOX_INPUTS);
            return input instanceof HTMLInputElement ? input : null;
        }

        function makeClickLabel(group, input) {
            const groupId = String(group?.id || "").trim();
            const inputId = String(input?.id || "").trim();
            const inputName = String(input?.name || "").trim();
            if (groupId && inputId) return `${groupId} [${inputId}]`;
            if (groupId) return groupId;
            if (inputId) return inputId;
            if (inputName) return inputName;
            return "consent-checkbox";
        }

        const clicked = [];
        const clickedSet = new Set();
        const maxPasses = Number(sel.CONSENT_MAX_PASSES) > 0 ? Number(sel.CONSENT_MAX_PASSES) : 4;
        const passDelayMs = Number(sel.CONSENT_PASS_DELAY_MS) > 0 ? Number(sel.CONSENT_PASS_DELAY_MS) : 200;

        for (let pass = 0; pass < maxPasses; pass += 1) {
            const groups = getConsentGroups();
            let clickedThisPass = 0;

            for (const group of groups) {
                const input = getGroupCheckboxInput(group);
                if (!input) continue;
                if (input.checked) continue;
                if (isDisabledConsentCheckbox(input, group)) continue;

                clickElement(input);
                if (!input.checked) clickElement(input.closest(sel.CHECKBOX_WRAPPER) || group);

                if (input.checked) {
                    const clickLabel = makeClickLabel(group, input);
                    if (!clickedSet.has(clickLabel)) {
                        clickedSet.add(clickLabel);
                        clicked.push(clickLabel);
                    }
                    clickedThisPass += 1;
                }
            }

            if (clickedThisPass === 0) break;
            await sleep(passDelayMs);
        }

        const unresolved = [];
        const groups = getConsentGroups();
        for (const group of groups) {
            const input = getGroupCheckboxInput(group);
            if (!input) continue;
            if (input.checked) continue;

            const reason = isDisabledConsentCheckbox(input, group) ? "disabled" : "not_checked";
            unresolved.push(`${makeClickLabel(group, input)} (${reason})`);
        }

        console.error(
            `[greenhouse:form-filler] Consent checkbox pass clicked ${clicked.length} checkboxes, unresolved ${unresolved.length}:`,
            { clicked, unresolved }
        );
        return {
            clickedCount: clicked.length,
            labels: clicked,
            unresolvedCount: unresolved.length,
            unresolved,
        };
    }, FORM_FILLER);

    if (consentResult?.clickedCount || consentResult?.unresolvedCount) {
        const unresolvedCount = Number(consentResult?.unresolvedCount || 0);
        results.push({
            id: "__consent__",
            keyPath: "__consent__",
            labelText: "Final consent checkbox pass",
            type: "checkbox",
            answer: true,
            result: {
                ok: unresolvedCount === 0,
                strategy: "consent-final-pass",
                clickedLabels: consentResult.labels || [],
                unresolved: consentResult.unresolved || [],
                reason: unresolvedCount > 0 ? "consent_checkboxes_remaining_disabled_or_unchecked" : undefined,
            },
        });
        await page.waitForTimeout(250);
    }

    console.error(`[greenhouse:form-filler] Fill results:\n` + results.map((r) => `- ${r.labelText} (${r.keyPath}): ${r.result?.ok ? "✅" : "❌ " + String(r.result?.reason || "")}`).join("\n"));
    return results;
}

function getAnswerForQuestion(question, answerMap) {
    if (!(answerMap instanceof Map)) return undefined;
    if (question?.id && answerMap.has(question.id)) return answerMap.get(question.id);
    if (question?.keyPath && answerMap.has(question.keyPath)) return answerMap.get(question.keyPath);
    return undefined;
}

async function fillOneGreenhouseQuestion(page, preparedQuestion, answer) {
    return page.evaluate(async ({ preparedQuestion, answer, sel }) => {
        function sleep(ms) {
            return new Promise((resolve) => setTimeout(resolve, ms));
        }

        function normalize(value) {
            return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        }

        function normalizeLoose(value) {
            return String(value ?? "")
                .replace(/Â /g, " ")
                .replace(/[^a-zA-Z0-9\s]/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
        }

        function scoreOptionMatch(optionText, answerText) {
            const optLoose = normalizeLoose(optionText);
            const ansLoose = normalizeLoose(answerText);
            if (!optLoose || !ansLoose) return 0;
            if (optLoose === ansLoose) return 1000;
            if (optLoose.startsWith(ansLoose) || ansLoose.startsWith(optLoose)) return 900;
            if (optLoose.includes(ansLoose) || ansLoose.includes(optLoose)) return 800;

            const optTokens = new Set(optLoose.split(" ").filter(Boolean));
            const ansTokens = ansLoose.split(" ").filter(Boolean);
            if (!optTokens.size || !ansTokens.length) return 0;

            let overlap = 0;
            for (const token of ansTokens) {
                if (optTokens.has(token)) overlap += 1;
            }
            return overlap;
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
            for (let i = 0; i < result.snapshotLength; i += 1) {
                items.push(result.snapshotItem(i));
            }
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
            if (typeof el.click === "function") {
                el.click();
            } else {
                el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            }
        }

        function triggerTextInput(el, value) {
            el.focus();
            if (el instanceof HTMLInputElement) {
                const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
                if (desc?.set) desc.set.call(el, value);
                else el.value = value;
            } else if (el instanceof HTMLTextAreaElement) {
                const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
                if (desc?.set) desc.set.call(el, value);
                else el.value = value;
            } else if ("value" in el) {
                el.value = value;
            }
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.blur();
        }

        function resolveTextTarget(inputEl, fieldEl) {
            if (inputEl instanceof HTMLInputElement || inputEl instanceof HTMLTextAreaElement) return inputEl;
            if (fieldEl instanceof HTMLInputElement || fieldEl instanceof HTMLTextAreaElement) return fieldEl;
            if (fieldEl?.querySelector) {
                const fromField = fieldEl.querySelector(sel.TEXT_TARGET);
                if (fromField) return fromField;
            }
            return null;
        }

        async function fillCoverLetter(answerValue) {
            const group = document.querySelector(sel.COVER_LETTER_GROUP);
            if (!group) return { ok: false, reason: "cover_letter_group_not_found" };

            const requiredByAria = String(group.getAttribute("aria-required") || "").toLowerCase() === "true";
            const label = group.querySelector(sel.COVER_LETTER_LABEL);
            const requiredByStar = Boolean(label?.querySelector?.(sel.COVER_LETTER_REQUIRED_MARK)) || /\*/.test(String(label?.textContent || ""));
            if (!requiredByAria && !requiredByStar) {
                return { ok: false, reason: "cover_letter_not_required" };
            }

            function isVisible(el) {
                if (!(el instanceof HTMLElement)) return false;
                const style = window.getComputedStyle(el);
                return style.display !== "none" && style.visibility !== "hidden" && el.offsetParent !== null;
            }

            function findCoverLetterTextarea() {
                const inGroup = group.querySelector(sel.COVER_LETTER_IN_GROUP_TEXTAREA);
                if (inGroup instanceof HTMLTextAreaElement && isVisible(inGroup)) return inGroup;

                const fieldWrapper = group.closest(sel.FIELD_WRAPPER);
                const inWrapper = fieldWrapper?.querySelector?.(sel.COVER_LETTER_IN_GROUP_TEXTAREA);
                if (inWrapper instanceof HTMLTextAreaElement && isVisible(inWrapper)) return inWrapper;

                const byId = document.querySelector(sel.COVER_LETTER_BY_ID);
                if (byId instanceof HTMLTextAreaElement && isVisible(byId)) return byId;

                const anyCover = document.querySelector(sel.COVER_LETTER_ANY);
                if (anyCover instanceof HTMLTextAreaElement && isVisible(anyCover)) return anyCover;

                return null;
            }

            let textarea = findCoverLetterTextarea();

            const manualButton = group.querySelector(sel.COVER_LETTER_ENTER_MANUAL)
                || Array.from(group.querySelectorAll(sel.BUTTON)).find((btn) => new RegExp(sel.ENTER_MANUAL_TEXT_PATTERN, "i").test(String(btn?.textContent || "")));
            if (!(textarea instanceof HTMLTextAreaElement) && manualButton) {
                clickElement(manualButton);
                await sleep(250);
            }

            textarea = findCoverLetterTextarea();
            if (!(textarea instanceof HTMLTextAreaElement)) {
                // UI may render the textarea asynchronously after clicking Enter manually.
                for (let i = 0; i < 12; i += 1) {
                    await sleep(250);
                    textarea = findCoverLetterTextarea();
                    if (textarea instanceof HTMLTextAreaElement) break;
                }
            }

            if (!(textarea instanceof HTMLTextAreaElement)) {
                return { ok: false, reason: "cover_letter_textarea_not_found" };
            }

            triggerTextInput(textarea, String(answerValue ?? ""));
            return { ok: true, strategy: "cover-letter-textarea" };
        }

        function replaceActionPathTokens(pathTemplate, value, inputPath) {
            const rawValue = String(value ?? "");
            const lowerValue = rawValue.toLowerCase();
            const upperValue = rawValue.toUpperCase();
            return String(pathTemplate || "")
                .replace(/%INPUTPATH%/g, String(inputPath || "."))
                .replace(/%LOWERVALUE%/g, lowerValue)
                .replace(/%UPPERVALUE%/g, upperValue);
        }

        function findFirstNodeFromActionPaths(paths, roots, value, inputPath) {
            for (const template of Array.isArray(paths) ? paths : []) {
                for (const root of roots) {
                    if (!root) continue;
                    const resolvedPath = replaceActionPathTokens(template, value, inputPath);
                    const nodes = xpathAll(resolvedPath, root);
                    if (nodes.length > 0) return nodes[0];
                }
            }
            return null;
        }

        function getVisibleSelectOptions() {
            return Array.from(document.querySelectorAll(sel.VISIBLE_SELECT_OPTIONS))
                .filter((node) => {
                    if (node instanceof HTMLOptionElement) return true;
                    const el = node instanceof HTMLElement ? node : null;
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    return style.display !== "none" && style.visibility !== "hidden" && el.offsetParent !== null;
                });
        }

        async function fillSelect(question, answerValue, fieldEl, inputEl) {
            if (!String(answerValue || "").trim()) {
                return { ok: false, reason: "select_empty_answer" };
            }

            const actions = Array.isArray(question?.fillActions) && question.fillActions.length
                ? question.fillActions
                : (Array.isArray(question?.trackedInputSelector?.fillActions) ? question.trackedInputSelector.fillActions : []);
            const inputPath = question?.simplify?.foundInputElement?.elementPath || question?.simplify?.foundFieldElement?.elementPath || ".";
            const inputContainer = question?.simplify?.foundInputElement?.foundContainer
                ? resolveContainer(question.simplify.foundInputElement.foundContainer)
                : null;
            const fieldContainer = question?.simplify?.foundFieldElement?.foundContainer
                ? resolveContainer(question.simplify.foundFieldElement.foundContainer)
                : null;
            const roots = [inputContainer, fieldEl, inputEl, fieldContainer, document].filter(Boolean);

            const clickable = inputEl || fieldEl;
            if (!clickable) return { ok: false, reason: "select_target_not_found" };

            let optionsVisible = getVisibleSelectOptions().length > 0;

            for (const action of actions) {
                if (!action?.valueRequired) {
                    if (action?.method === "click") {
                        if (!optionsVisible) {
                            clickElement(clickable);
                            await sleep(250);
                            optionsVisible = getVisibleSelectOptions().length > 0;
                        }
                    }
                    continue;
                }

                const match = findFirstNodeFromActionPaths(action?.path, roots, answerValue, inputPath);
                if (!match) {
                    continue;
                }
                if (action?.method === "click") {
                    clickElement(match);
                    await sleep(250);
                    return { ok: true, strategy: "select", clickedText: match.textContent?.trim() || String(answerValue || "") };
                }
            }

            // Re-open and try robust text matching against visible options.
            if (!optionsVisible) {
                clickElement(clickable);
                await sleep(250);
            }

            const allOptions = getVisibleSelectOptions();
            let bestNode = null;
            let bestScore = 0;

            for (const option of allOptions) {
                const text = String(option?.textContent || option?.value || "").trim();
                const score = scoreOptionMatch(text, answerValue);
                if (score > bestScore) {
                    bestScore = score;
                    bestNode = option;
                }
            }

            if (bestNode && bestScore > 0) {
                clickElement(bestNode);
                return {
                    ok: true,
                    strategy: "select-fallback",
                    clickedText: bestNode.textContent?.trim() || String(answerValue || ""),
                    score: bestScore,
                };
            }

            return { ok: false, reason: "select_option_not_found", value: String(answerValue || "") };
        }

        async function fillCheckbox(question, answerValue, fieldEl, inputEl) {
            const answers = Array.isArray(answerValue) ? answerValue : (answerValue ? [answerValue] : []);
            if (!answers.length) return { ok: false, reason: "checkbox_no_answers" };

            const actions = Array.isArray(question?.fillActions) && question.fillActions.length
                ? question.fillActions
                : (Array.isArray(question?.trackedInputSelector?.fillActions) ? question.trackedInputSelector.fillActions : []);
            const roots = [fieldEl, inputEl, document].filter(Boolean);
            const clicked = [];

            for (const oneAnswer of answers) {
                let matched = null;
                for (const action of actions) {
                    if (action?.method !== "click") continue;
                    matched = findFirstNodeFromActionPaths(action?.path, roots, oneAnswer, ".");
                    if (matched) break;
                }

                if (!matched) {
                    const desired = normalize(oneAnswer);
                    const candidates = Array.from((fieldEl || document).querySelectorAll(sel.CHECKBOX_RADIO_INPUTS));
                    matched = candidates.find((candidate) => {
                        const label = candidate.id ? document.querySelector(`${sel.LABEL_WITH_FOR_PREFIX}"${CSS.escape(candidate.id)}"]`) : null;
                        const text = normalize(label?.textContent || candidate.closest(sel.LABEL)?.textContent || "");
                        return text === desired || text.includes(desired);
                    }) || null;
                }

                if (matched) {
                    if (!(matched instanceof HTMLInputElement) || !matched.checked) {
                        clickElement(matched);
                    }
                    clicked.push(String(oneAnswer));
                }
            }

            if (!clicked.length) {
                return { ok: false, reason: "checkbox_option_not_found", answers };
            }

            return { ok: true, strategy: "checkbox", clicked };
        }

        const fieldEl = resolveElement(preparedQuestion?.simplify?.foundFieldElement);
        const inputEl = resolveElement(preparedQuestion?.simplify?.foundInputElement);
        const qType = String(preparedQuestion?.type || "").toLowerCase();

        if (preparedQuestion?.coverLetter?.required) {
            return fillCoverLetter(String(answer ?? ""));
        }

        if (qType === "text" || qType === "textarea") {
            const textTarget = resolveTextTarget(inputEl, fieldEl);
            if (!textTarget) return { ok: false, reason: "text_target_not_found" };
            triggerTextInput(textTarget, String(answer ?? ""));
            return { ok: true, strategy: qType, value: String(answer ?? "") };
        }

        if (qType === "select") {
            return fillSelect(preparedQuestion, String(answer ?? ""), fieldEl, inputEl);
        }

        if (qType === "checkbox") {
            return fillCheckbox(preparedQuestion, answer, fieldEl, inputEl);
        }

        return { ok: false, reason: `unsupported_type:${qType || "unknown"}` };
    }, { preparedQuestion, answer, sel: FORM_FILLER });
}
