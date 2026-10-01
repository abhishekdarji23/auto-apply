
import { getJobPostingDetails, scrapeJobDetails } from "./helpers.mjs";
import { handleSignIn } from "./signin.mjs";
import { reloadIfErrorPage, runStepLoop, checkWorkdaySubmissionSuccess } from "./step-loop.mjs";
import { JOB_POSTING, STEP_LOOP } from "./selectors.mjs";
import { shouldCloseAtsPageOnFailure } from "../../utils/env.mjs";

export { scrapeJobDetails };

let currentJobPostingTitle = "";
let currentJobPostingDescription = "";

/**
 * @param {import('playwright').Page} page
 * @param {object} job  - job document from MongoDB
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export default async function apply(page, job, context) {
    void context;

    try {
        console.error(`[workday] Starting auto-apply for: ${job.title} @ ${job.company}`);
        console.error(`[workday] URL: ${page.url()}`);

        await assertPageAvailable(page);
        await page.waitForTimeout(1_000);

        page = await signOutIfAlreadySignedIn(page);

        await captureJobDetails(page, job);

        await clickApplyButton(page);
        await assertPageAvailable(page);
        await page.waitForTimeout(1_000);

        await handleSignIn(page);
        await assertPageAvailable(page);
        await page.waitForTimeout(1_000);

        await reloadIfErrorPage(page);

        await runStepLoop(page, job);

        const confirmResult = await checkWorkdaySubmissionSuccess(page, 6000);
        const confirmed = Boolean(confirmResult?.confirmed);
        const trackingError = confirmed ? "" : "submission_not_confirmed";

        await saveTrackingFromWorkday({ job, success: confirmed, error: trackingError });

        if (confirmed) {
            console.error(`[workday] ✅ Application submitted (${confirmResult.method}) for ${job.title} @ ${job.company}`);
            await page.close().catch(() => { });
        } else {
            console.error(`[workday] ⚠️  Submit clicked but confirmation not detected for ${job.title} @ ${job.company}`);
            if (shouldCloseAtsPageOnFailure()) await page.close().catch(() => { });
        }

        return { success: confirmed, error: trackingError || undefined };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "workday_already_applied") {
            console.error(`[workday] ℹ️  Already applied for ${job.title} @ ${job.company} — saving as success`);
            await saveTrackingFromWorkday({ job, success: true, error: "already_applied" });
            await page.close().catch(() => { });
            return { success: true, error: "already_applied" };
        }
        console.error(`[workday] ❌ Error: ${message}`);
        await saveTrackingFromWorkday({ job, success: false, error: message });
        if (shouldCloseAtsPageOnFailure()) await page.close().catch(() => { });
        return { success: false, error: message };
    }
}

async function signOutIfAlreadySignedIn(page) {
    const mainUrl = page.url();
    await closeSimplifyPopupIfPresent(page);
    const accountTasksMenu = page.locator('[data-automation-id="utilityButtonAccountTasksMenu"]').first();
    const hasAccountTasksMenu = await accountTasksMenu.isVisible({ timeout: 2_000 }).catch(() => false);
    if (!hasAccountTasksMenu) {
        console.error("[workday:signin-check] Account menu not found — continuing.");
        return page;
    }

    console.error("[workday:signin-check] Account menu detected — opening account tasks.");
    const accountMenuButton = accountTasksMenu.locator("button").first();
    const hasInnerButton = (await accountMenuButton.count()) > 0;
    if (hasInnerButton) {
        await accountMenuButton.click().catch(() => { });
    } else {
        await accountTasksMenu.click().catch(() => { });
    }

    await page.waitForTimeout(1_000);

    const hasSignOutButton = await hasVisibleSignOutButton(page);
    if (!hasSignOutButton) {
        console.error("[workday:signin-check] Sign Out button not found after opening account menu — continuing.");
        return page;
    }

    console.error("[workday:signin-check] Clicking Sign Out to reset session.");
    const clickedSignOut = await clickVisibleSignOutButton(page);
    if (!clickedSignOut) {
        console.error("[workday:signin-check] Sign Out button was detected but click failed — continuing.");
        return page;
    }

    await page.waitForTimeout(1_000);
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => { });
    console.error(`[workday:signin-check] Sign-out complete. Navigating same page back to: ${mainUrl}`);
    await page.goto(mainUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => { });
    await page.waitForTimeout(1_000);
    return page;
}

async function closeSimplifyPopupIfPresent(page) {
    const closed = await page.evaluate(() => {
        const hosts = Array.from(document.querySelectorAll(".simplify-jobs-shadow-root"));
        let clickedAny = false;

        for (const host of hosts) {
            const shadowBtn = host.shadowRoot?.querySelector("#close-button");
            const lightBtn = host.querySelector("#close-button");
            const btn = shadowBtn || lightBtn;
            if (!btn) continue;

            btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
            btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
            btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            clickedAny = true;
        }

        if (clickedAny) return true;

        const globalBtn = document.querySelector("#close-button");
        if (!globalBtn) return false;
        globalBtn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        globalBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        globalBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        globalBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
    }).catch(() => false);

    if (closed) {
        console.error("[workday:signin-check] Simplify popup detected and closed.");
        await page.waitForTimeout(500);
    }
}

async function clickWithRealMouse(page, locator, label) {
    try {
        await locator.waitFor({ state: "visible", timeout: 2_000 });
        await locator.scrollIntoViewIfNeeded().catch(() => { });
        await locator.hover({ force: true }).catch(() => { });
        const box = await locator.boundingBox();
        if (box) {
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            await page.mouse.move(x, y, { steps: 12 });
            await page.mouse.down();
            await page.mouse.up();
            return;
        }
        await locator.click({ timeout: 2_000 }).catch(() => { });
    } catch (err) {
        console.error(`[workday:signin-check] Failed real click for ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function hasVisibleSignOutButton(page) {
    return page.evaluate(() => {
        const elements = [
            ...document.querySelectorAll('button[aria-label="Sign Out"], [role="button"][aria-label="Sign Out"], [role="menuitem"][aria-label="Sign Out"], button, [role="button"], [role="menuitem"]')
        ].filter((el) => {
            const text = (el.innerText || el.textContent || "").trim();
            const matches = el.getAttribute("aria-label") === "Sign Out" || text === "Sign Out";
            if (!matches) return false;
            const htmlEl = /** @type {HTMLElement} */ (el);
            return !!(htmlEl.offsetParent || getComputedStyle(htmlEl).display !== "none");
        });
        return elements.length > 0;
    }).catch(() => false);
}

async function clickVisibleSignOutButton(page) {
    return page.evaluate(() => {
        const elements = [
            ...document.querySelectorAll('button[aria-label="Sign Out"], [role="button"][aria-label="Sign Out"], [role="menuitem"][aria-label="Sign Out"], button, [role="button"], [role="menuitem"]')
        ].filter((el) => {
            const text = (el.innerText || el.textContent || "").trim();
            const matches = el.getAttribute("aria-label") === "Sign Out" || text === "Sign Out";
            if (!matches) return false;
            const htmlEl = /** @type {HTMLElement} */ (el);
            return !!(htmlEl.offsetParent || getComputedStyle(htmlEl).display !== "none");
        });

        const first = elements[0];
        if (!first) return false;

        first.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        first.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
    }).catch(() => false);
}

async function saveTrackingFromWorkday({ job, success, error }) {
    const origin = process.env.JOBTRACK_API_ORIGIN || (process.env.PORT ? `http://localhost:${process.env.PORT}` : "http://localhost:3000");
    const payload = {
        jobId: job?.jobId || "",
        jobUrl: job?.url || "",
        atsId: "workday",
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
            console.error(`[workday] tracking save failed: ${res.status} ${txt}`);
            return false;
        }
        return true;
    } catch (saveErr) {
        console.error(`[workday] tracking save error: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`);
        return false;
    }
}

// Reload if "Something went wrong" is showing, then throw if job is not available.
async function assertPageAvailable(page) {
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => { });
    await page.waitForTimeout(2_000); // let SPA render error message before checking

    // If Workday's generic error screen is showing, reload and wait for it to recover
    const isErrorPage = await page.evaluate(
        (sel) => document.body?.innerText?.includes(sel.ERROR_PAGE_TEXT),
        STEP_LOOP
    ).catch(() => false);
    if (isErrorPage) {
        console.error("[workday] ⚠️  'Something went wrong' detected — reloading and waiting...");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => { });
        await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => { });
        await page.waitForTimeout(2_000);
        console.error("[workday] Reloaded after error page.");
    }

    // Check for "already applied" — throw so caller can record as success
    const alreadyApplied = await page.evaluate(
        () => document.body?.innerText?.toLowerCase().includes("you've already applied for this job") ||
            document.body?.innerText?.toLowerCase().includes("you applied for this job")
    ).catch(() => false);
    if (alreadyApplied) {
        console.error(`[workday] ℹ️  Already applied — "You've already applied for this job" detected`);
        throw new Error("workday_already_applied");
    }

    // Check for "job not found" — throw so the caller skips this job
    const notFound = await page.evaluate(
        (sel) => {
            const els = Array.from(document.querySelectorAll(sel.ERROR_MESSAGE));
            return els.some(
                (el) => el.offsetParent !== null &&
                    el.textContent.replace(/\s+/g, " ").trim().toLowerCase().includes(sel.NOT_FOUND_TEXT)
            );
        },
        JOB_POSTING
    ).catch(() => false);
    console.error(`[workday] Page availability check: notFound=${notFound}`);
    if (notFound) {
        console.error(`[workday] ❌ Job posting not available (errorMessage element detected)`);
        throw new Error("workday_page_not_found");
    }
}

async function captureJobDetails(page, job) {
    const details = await getJobPostingDetails(page);
    currentJobPostingTitle = details.title || job?.title || "";
    currentJobPostingDescription = details.description || "";
    console.error(
        `[workday] Captured posting details — title="${currentJobPostingTitle || "(missing)"}" jdChars=${currentJobPostingDescription.length}`
    );
}

async function clickApplyButton(page) {
    console.error(`[workday:apply] Current URL: ${page.url()}`);

    if (page.url().includes("/apply/")) {
        console.error("[workday:apply] Already on apply page — skipping Apply button click.");
        return;
    }

    console.error("[workday:apply] Waiting for page load...");
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
    await page.waitForTimeout(1_000); // anti-bot: wait for page to fully render

    console.error("[workday:apply] Looking for Apply button (adventureButton)...");
    const applyBtn = page.locator(JOB_POSTING.APPLY_BUTTON).first();
    await applyBtn.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1_000); // anti-bot: pause before clicking Apply
    console.error("[workday] Clicking Apply button...");
    await applyBtn.click();

    try {
        const applyManuallyBtn = page.locator(JOB_POSTING.APPLY_MANUALLY_BUTTON);
        await applyManuallyBtn.waitFor({ state: "visible", timeout: 5_000 });
        await page.waitForTimeout(1_000); // anti-bot: pause before choosing Apply Manually
        console.error("[workday] 'Apply Manually' popup detected — clicking it...");
        await applyManuallyBtn.click();
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
        await page.waitForTimeout(1_000); // anti-bot: let the form settle
    } catch {
        console.error("[workday] No 'Apply Manually' popup — already on apply form.");
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
        await page.waitForTimeout(1_000); // anti-bot: let the form settle
    }

    console.error(`[workday] On apply page: ${page.url()}`);
}
