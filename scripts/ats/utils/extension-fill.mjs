/**
 * extension-fill.mjs — Wait for Simplify extension to fill form fields.
 * Generic for all ATS platforms.
 */

// ─────────────────────────────────────────────────────────────────────────────
// DOM / sessionStorage selector map — change here to survive Simplify UI updates
// ─────────────────────────────────────────────────────────────────────────────

const SELECTORS = {
    /** Class on every element the Simplify extension injects as a shadow host */
    EXTENSION_HOST: ".simplify-jobs-shadow-root",

    /** Tag used for the extension's status heading inside the shadow root / host */
    EXTENSION_HEADING_TAG: "h1",

    /** sessionStorage key the extension writes when it finishes filling */
    STATUS_KEY: "autofill-fill-status",

    /** Value the extension sets STATUS_KEY to when all fields are done */
    STATUS_FILLED_VALUE: "filled",

    /**
     * Text fragments used to identify the "Skip to next input" button inside
     * the extension's shadow root. All three are checked: aria-label, title, textContent.
     */
    SKIP_BUTTON_TEXT: "skip to next input",

    /**
     * Regex to extract current/total from the heading text, e.g.
     * "Filling 3 of 12 unique questions"
     */
    HEADING_PROGRESS_PATTERN: /filling\s+(\d+)\s+of\s+(\d+)\s+unique\s+questions/i,

    /**
     * Regex to match the "Autofill N Skills" button (Simplify may vary the format).
     * Primary pattern — requires a number.  A fallback covers numberless variants.
     */
    SKILLS_BUTTON_PATTERN: "autofill.*skills?|add.*skills?|fill.*skills?",

    /**
     * Fallback: any button containing just the word "skills" (only applied inside
     * extension shadow roots to avoid false positives on the page itself).
     */
    SKILLS_BUTTON_FALLBACK_PATTERN: "\\bskills?\\b",

    /** Card button used by Simplify to open the popup when collapsed */
    LOGO_CARD_SELECTOR: "#logo-card",

    /** Button that is visible only when Simplify popup panel is open */
    REPORT_BUTTON_SELECTOR: 'button[title="Report an issue"], button[aria-label="Report an issue"]',
};

// ─────────────────────────────────────────────────────────────────────────────

async function ensureSimplifyPopupOpen(page) {
    return await page.evaluate((sel) => {
        const hosts = Array.from(document.querySelectorAll(sel.EXTENSION_HOST));

        let hasReportIssueButton = false;
        let clicked = false;

        for (const host of hosts) {
            let scope = null;

            if (host.shadowRoot) {
                scope = host.shadowRoot;
            } else {
                const tpl = host.querySelector('template[shadowrootmode="open"]');
                if (tpl) scope = tpl.content;
            }

            if (!scope) continue;

            const reportButtons = Array.from(scope.querySelectorAll(sel.REPORT_BUTTON_SELECTOR));
            hasReportIssueButton = reportButtons.some((btn) => {
                const title = String(btn.getAttribute("title") || "").trim().toLowerCase();
                const aria = String(btn.getAttribute("aria-label") || "").trim().toLowerCase();
                const text = String(btn.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
                return title === "report an issue"
                    || aria === "report an issue"
                    || text.includes("report");
            });

            if (hasReportIssueButton) break;

            const logoCard = scope.querySelector(sel.LOGO_CARD_SELECTOR);
            if (logoCard) {
                try {
                    logoCard.scrollIntoView({ block: "center", inline: "center" });
                } catch {
                    // no-op
                }

                ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
                    logoCard.dispatchEvent(new MouseEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        view: window,
                    }));
                });

                if (!clicked) {
                    try {
                        logoCard.click();
                    } catch {
                        // no-op
                    }
                }

                clicked = true;
                break;
            }
        }

        return { hasReportIssueButton, clicked };
    }, SELECTORS).catch(() => ({ hasReportIssueButton: false, clicked: false }));
}

/**
 * Wait until sessionStorage["autofill-fill-status"] is "filled"
 * and stays "filled" for STABLE_MS continuous seconds.
 *
 * Monitors per-question filling: each question gets a per-question timeout.
 * If the same question hasn't progressed in QUESTION_TIMEOUT_MS, skip it.
 * When question number changes, timer resets for the new question.
 *
 * @param {import('playwright').Page} page
 * @param {string} atsName — used only for log prefixes
 */
export async function waitForExtensionFill(page, atsName = "ats") {
    const STABLE_MS = 2_000;
    const QUESTION_TIMEOUT_MS = 3_000;
    const POLL_MS = 500;
    const POPUP_CHECK_MS = 500;      // fast loop check so popup reopens quickly
    const POPUP_LONG_CHECK_MS = 200_000; // explicit long-run check at 200 seconds
    const TIMEOUT_MS = 5 * 60 * 1_000;
    const tag = `${atsName}:autofill`;

    console.error(`[${tag}] Waiting for extension to fill...`);
    await page.waitForTimeout(2_000); // initial wait — let the page & extension fully load
    let lastPopupStateKey = "";
    const logPopupState = (result, reason) => {
        const stateKey = `${result.hasReportIssueButton}:${result.clicked}`;
        if (result.clicked || stateKey !== lastPopupStateKey || reason !== "loop") {
            console.error(`[${tag}:popup] reason=${reason} hasReportIssueButton=${result.hasReportIssueButton} clickedLogoCard=${result.clicked}`);
        }
        lastPopupStateKey = stateKey;
    };

    const initialPopupState = await ensureSimplifyPopupOpen(page);
    logPopupState(initialPopupState, "initial-2s");

    let stableSince = null;
    let lastSeenHeading = null;
    let lastRootState = null;
    let lastPopupCheckAt = Date.now();
    let nextLongPopupCheckAt = Date.now() + POPUP_LONG_CHECK_MS;
    let currentQuestionIndex = null;
    let questionStartTime = null;
    let lastSeenStatus = undefined;   // tracks exact status value; any change resets stability
    const deadline = Date.now() + TIMEOUT_MS;

    while (Date.now() < deadline) {
        const now = Date.now();
        if (now >= nextLongPopupCheckAt) {
            const popupState = await ensureSimplifyPopupOpen(page);
            logPopupState(popupState, "200s");
            nextLongPopupCheckAt = now + POPUP_LONG_CHECK_MS;
            lastPopupCheckAt = now;
        } else if (now - lastPopupCheckAt >= POPUP_CHECK_MS) {
            const popupState = await ensureSimplifyPopupOpen(page);
            logPopupState(popupState, "loop");
            lastPopupCheckAt = now;
        }

        const extensionState = await page.evaluate((sel) => {
            const hosts = Array.from(document.querySelectorAll(sel.EXTENSION_HOST));

            for (const host of hosts) {
                const shadowHeading = host.shadowRoot?.querySelector?.(sel.EXTENSION_HEADING_TAG);
                if (shadowHeading) {
                    return {
                        hostCount: hosts.length,
                        rootSource: "shadowRoot",
                        headingText: String(shadowHeading.textContent || "").replace(/\s+/g, " ").trim(),
                    };
                }

                const lightHeading = host.querySelector?.(sel.EXTENSION_HEADING_TAG);
                if (lightHeading) {
                    return {
                        hostCount: hosts.length,
                        rootSource: "host",
                        headingText: String(lightHeading.textContent || "").replace(/\s+/g, " ").trim(),
                    };
                }
            }

            return {
                hostCount: hosts.length,
                rootSource: "none",
                headingText: "",
            };
        }, SELECTORS).catch(() => ({ hostCount: 0, rootSource: "error", headingText: "" }));

        const rootState = `${extensionState.rootSource}:${extensionState.hostCount}`;
        if (rootState !== lastRootState) {
            console.error(
                `[${tag}:root] source=${extensionState.rootSource} hosts=${extensionState.hostCount}`
            );
            lastRootState = rootState;
        }

        const headingText = extensionState.headingText;

        if (headingText && headingText !== lastSeenHeading) {
            console.error(`[${tag}:heading] "${headingText}"`);
            lastSeenHeading = headingText;
        }

        const questionMatch = headingText.match(SELECTORS.HEADING_PROGRESS_PATTERN);
        const questionIndex = questionMatch ? parseInt(questionMatch[1], 10) : null;
        const totalQuestions = questionMatch ? parseInt(questionMatch[2], 10) : null;

        if (questionIndex !== null) {
            if (questionIndex !== currentQuestionIndex) {
                currentQuestionIndex = questionIndex;
                questionStartTime = Date.now();
                console.error(`[${tag}] ✓ Question ${questionIndex}/${totalQuestions}`);
            } else if (questionStartTime && Date.now() - questionStartTime >= QUESTION_TIMEOUT_MS) {
                const skipResult = await page.evaluate((sel) => {
                    const hosts = Array.from(document.querySelectorAll(sel.EXTENSION_HOST));

                    for (const host of hosts) {
                        const roots = [host.shadowRoot, host];

                        for (const root of roots) {
                            if (!root?.querySelectorAll) continue;

                            const buttons = Array.from(root.querySelectorAll("button"));
                            const skipBtn = buttons.find((btn) => {
                                const aria = String(btn.getAttribute("aria-label") || "").toLowerCase();
                                const title = String(btn.getAttribute("title") || "").toLowerCase();
                                const text = String(btn.textContent || "")
                                    .replace(/\s+/g, " ")
                                    .trim()
                                    .toLowerCase();
                                return (
                                    aria.includes(sel.SKIP_BUTTON_TEXT)
                                    || title.includes(sel.SKIP_BUTTON_TEXT)
                                    || text.includes(sel.SKIP_BUTTON_TEXT)
                                );
                            });

                            if (skipBtn) {
                                skipBtn.click();
                                return { clicked: true };
                            }
                        }
                    }

                    return { clicked: false, reason: "skip_button_not_found" };
                }, SELECTORS).catch((error) => ({
                    clicked: false,
                    reason: error instanceof Error ? error.message : String(error),
                }));

                if (skipResult.clicked) {
                    console.error(`[${tag}] 🚫 Question ${questionIndex} stuck >10s — skipped`);
                    questionStartTime = Date.now();
                } else {
                    console.error(
                        `[${tag}] Question ${questionIndex} stuck >10s; skip failed: ${skipResult.reason || "unknown"}`
                    );
                }
            }
        } else {
            currentQuestionIndex = null;
            questionStartTime = null;
        }

        // ── "Autofill N Skills" button ────────────────────────────────────────
        // Its presence means the extension has finished filling — return immediately.
        // NOTE: After education fill, Simplify transitions its popup to a different
        // shadow host (different class/element).  We must scan ALL simplify-related
        // shadow roots, not only .simplify-jobs-shadow-root.
        const skillsBtn = await page.evaluate((sel) => {
            const pattern = new RegExp(sel.SKILLS_BUTTON_PATTERN, "i");
            const fallbackPattern = new RegExp(sel.SKILLS_BUTTON_FALLBACK_PATTERN, "i");

            // Collect all roots to search: known host class + ANY element whose
            // class/id/tagName contains "simplify" (covers the skills popup host).
            const knownHosts = Array.from(document.querySelectorAll(sel.EXTENSION_HOST));
            const extraEls = Array.from(document.querySelectorAll(
                "[class*='simplify'],[id*='simplify'],[class*='Simplify'],[id*='Simplify']"
            ));

            const seenRoots = new Set();
            const roots = [];
            for (const el of [...knownHosts, ...extraEls]) {
                if (el.shadowRoot && !seenRoots.has(el.shadowRoot)) {
                    seenRoots.add(el.shadowRoot);
                    roots.push({ root: el.shadowRoot, isExtension: true });
                }
                if (!seenRoots.has(el)) {
                    seenRoots.add(el);
                    roots.push({ root: el, isExtension: true });
                }
            }
            // Also check document.body for any non-shadow buttons
            roots.push({ root: document.body, isExtension: false });

            const allButtonTexts = [];
            for (const { root, isExtension } of roots) {
                if (!root?.querySelectorAll) continue;
                for (const btn of root.querySelectorAll("button")) {
                    const text = String(btn.textContent || "").replace(/\s+/g, " ").trim();
                    allButtonTexts.push(text);
                    if (pattern.test(text)) return { found: true, text, method: "primary" };
                    // Fallback: "skills" word anywhere — but only inside extension roots
                    if (isExtension && fallbackPattern.test(text)) {
                        return { found: true, text, method: "fallback" };
                    }
                }
            }
            return { found: false, allButtonTexts };
        }, SELECTORS).catch(() => ({ found: false }));

        if (skillsBtn.found) {
            console.error(`[${tag}] ✅ Skills autofill button detected ("${skillsBtn.text}") via ${skillsBtn.method} — waiting 3s before returning...`);
            await page.waitForTimeout(2_000);
            return;
        }

        // Diagnostic: after source=none (fill done, skills visible), log all button texts once
        if (extensionState.rootSource === "none" && extensionState.hostCount > 0 && skillsBtn.allButtonTexts?.length) {
            const key = skillsBtn.allButtonTexts.join("|");
            if (key !== lastRootState) {
                console.error(`[${tag}:debug] source=none, buttons in ext roots: [${skillsBtn.allButtonTexts.map(t => `"${t}"`).join(", ")}]`);
            }
        }

        const status = await page
            .evaluate((sel) => sessionStorage.getItem(sel.STATUS_KEY), SELECTORS)
            .catch(() => null);

        // Any change in the status value resets the stability window entirely.
        if (status !== lastSeenStatus) {
            if (lastSeenStatus !== undefined) {
                console.error(`[${tag}] Status changed: "${lastSeenStatus}" → "${status}" — stability reset`);
            }
            lastSeenStatus = status;
            stableSince = null;
        }

        if (status === SELECTORS.STATUS_FILLED_VALUE) {
            if (!stableSince) {
                stableSince = Date.now();
                console.error(`[${tag}] Status filled; stabilizing ${(STABLE_MS / 1000).toFixed(1)}s...`);
            } else if (Date.now() - stableSince >= STABLE_MS) {
                console.error(`[${tag}] Stable for ${(STABLE_MS / 1000).toFixed(1)}s — done.`);
                return;
            }
        }

        await page.waitForTimeout(POLL_MS);
    }

    throw new Error(`[${tag}] Timed out waiting for extension fill`);
}
