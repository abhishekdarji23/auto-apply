// workday/signin.mjs — full Workday sign-in / create-account flow.
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import { dumpAutomationIds, getVisibleErrors, isPastAuth } from "./helpers.mjs";
import { SIGN_IN, GMAIL } from "./selectors.mjs";
import { getDataPath, getDataDirName } from "../../../lib/user-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const projectRoot = path.resolve(__dirname, "../../../..");

function loadProfile() {
    const candidateProfilePath = getDataPath(projectRoot, "candidate-profile.json");
    try {
        return require(candidateProfilePath);
    } catch (e) {
        throw new Error(`Could not load ${getDataDirName(projectRoot)}/candidate-profile.json: ${e.message}`);
    }
}

function loadCurrentEmails() {
    try {
        return require(getDataPath(projectRoot, "current-emails.json"));
    } catch {
        return {};
    }
}

/**
 * Opens Gmail, finds the Workday account-activation link in the first inbox email,
 * navigates to it in a new tab (which verifies the account), then returns to the
 * original page. Returns true on success, false if no activation link was found.
 */
async function verifyEmailFromGmail(page) {
    let gmailPage = null;
    let activationPage = null;
    try {
        gmailPage = await page.context().newPage();
        await gmailPage.bringToFront().catch(() => { });
        await gmailPage.waitForTimeout(10_000);

        const gmailUrl = loadCurrentEmails().gmailUrl || "https://mail.google.com/mail/u/7/#inbox";
        await gmailPage.goto(gmailUrl, {
            waitUntil: "domcontentloaded",
            timeout: 10_000,
        }).catch(() => { });
        await gmailPage.waitForTimeout(2_000);

        await gmailPage.waitForSelector(GMAIL.INBOX_TABLE, { timeout: 5_000 }).catch(() => { });

        // Click the first email in inbox
        await gmailPage.evaluate((sel) => {
            const table = document.querySelectorAll(sel.INBOX_TABLE)[sel.FIRST_ROW_INDEX];
            const firstRow = table?.querySelector(sel.FIRST_ROW_SELECTOR);
            if (firstRow) firstRow.click();
        }, GMAIL);
        await gmailPage.waitForTimeout(2_000);

        // Extract the Workday /activate/ link from the opened email
        const activationUrl = await gmailPage.evaluate(() => {
            const links = Array.from(document.querySelectorAll("a[href]"));
            const link = links.find((a) => {
                const href = a.getAttribute("href") || "";
                return href.includes("myworkdayjobs.com") && href.includes("/activate/");
            });
            return link ? link.getAttribute("href") : null;
        });
        console.error(`[workday:signin] Activation URL: ${activationUrl ? "found" : "not found"}`);

        // Delete the email to keep inbox clean (same pattern as Greenhouse)
        await gmailPage.evaluate(async (sel) => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const fire = (el, type, x, y) => {
                el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
            };
            const btn = document.querySelector(sel.DELETE_BUTTON);
            if (!btn) return;
            const inner = btn.querySelector(sel.DELETE_INNER) || btn;
            btn.scrollIntoView({ block: "center", inline: "center" });
            await wait(300);
            const rect = btn.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            fire(btn, "mouseover", x, y); fire(btn, "mouseenter", x, y); fire(btn, "mousemove", x, y);
            fire(inner, "mouseover", x, y); fire(inner, "mouseenter", x, y); fire(inner, "mousemove", x, y);
            await wait(500);
            fire(inner, "mousedown", x, y); await wait(80); fire(inner, "mouseup", x, y); fire(inner, "click", x, y);
        }, GMAIL).catch(() => { });
        await gmailPage.waitForTimeout(500);

        await gmailPage.close().catch(() => { });
        gmailPage = null;

        if (!activationUrl) {
            console.error("[workday:signin] ⚠️  No Workday activation link found in the first Gmail email.");
            return false;
        }

        // Open the activation link — this verifies the account on Workday's end
        activationPage = await page.context().newPage();
        await activationPage.bringToFront().catch(() => { });
        await activationPage.goto(activationUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => { });
        console.error("[workday:signin] Activation page opened — waiting 2s...");
        await activationPage.waitForTimeout(2_000);
        await activationPage.close().catch(() => { });
        activationPage = null;

        await page.bringToFront().catch(() => { });
        await page.waitForTimeout(1_000);
        console.error("[workday:signin] ✅ Email verification complete.");
        return true;
    } catch (err) {
        console.error(`[workday:signin] verifyEmailFromGmail error: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    } finally {
        if (gmailPage && !gmailPage.isClosed()) await gmailPage.close().catch(() => { });
        if (activationPage && !activationPage.isClosed()) await activationPage.close().catch(() => { });
        await page.bringToFront().catch(() => { });
    }
}

// Called when attemptSignIn returns "verify_required". Verifies via Gmail then retries sign-in.
async function verifyAndRetrySignIn(page, email, password, fallbackPassword) {
    console.error("[workday:signin] Email verification required — checking for Resend button...");

    // Click "Resend Account Verification" if present so a fresh email arrives
    // Filter by text so we only match buttons whose label includes "resend" (case-insensitive)
    const resendBtn = page.locator(SIGN_IN.RESEND_VERIFICATION_BUTTON).filter({ hasText: /resend/i });
    const resendVisible = await resendBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    console.error(`[workday:signin] Resend verification button visible: ${resendVisible}`);
    if (resendVisible) {
        await resendBtn.click().catch(() => { });
        console.error("[workday:signin] Clicked Resend Account Verification — waiting 3s for email to arrive...");
        await page.waitForTimeout(3_000);
    }

    console.error("[workday:signin] Opening Gmail to fetch activation link...");
    const verified = await verifyEmailFromGmail(page);
    if (!verified) {
        throw new Error(`Email verification required for ${email} but no activation link found in Gmail.`);
    }
    console.error("[workday:signin] Verification link opened — retrying sign-in in 2s...");
    await page.waitForTimeout(2_000);
    const retryResult = await attemptSignInWithFallback(page, email, password, fallbackPassword);
    if (retryResult === true) {
        console.error("[workday:signin] ✅ Sign-in succeeded after email verification.");
        return;
    }
    throw new Error(`Sign-in still failed after email verification for ${email}.`);
}

// If the SSO chooser page is showing ("Sign in with Apple / Google / Sign in with email"),
// click the "Sign in with email" button and wait for the email/password form to appear.
// Safe to call at any point — does nothing if the button isn't present.
async function clickSignInWithEmailIfPresent(page) {
    const btn = page.locator(SIGN_IN.SIGN_IN_WITH_EMAIL_BUTTON);
    const visible = await btn.isVisible({ timeout: 2_000 }).catch(() => false);
    if (!visible) return;
    console.error("[workday:signin] SSO chooser detected — clicking 'Sign in with email'...");
    await page.waitForTimeout(1_000);
    await btn.click();
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => { });
    await page.waitForTimeout(1_500);
    console.error(`[workday:signin] After 'Sign in with email' click: ${page.url()}`);
}

export async function handleSignIn(page) {
    const profile = loadProfile();
    const { email, password, FallbackPassword } = profile.credentials;

    console.error("[workday:signin] ── handleSignIn enter ──────────────────────────────");
    console.error("[workday:signin] Waiting for page to stabilize (networkidle)...");
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {
        console.error("[workday:signin] networkidle timed out — continuing anyway");
    });
    await page.waitForTimeout(1_000); // anti-bot: let SPA fully render
    console.error(`[workday:signin] URL after stabilize: ${page.url()}`);

    console.error("[workday:signin] Checking if already past auth...");
    if (await isPastAuth(page)) {
        console.error("[workday:signin] ✅ Already signed in — skipping login step.");
        return;
    }

    // Handle intermediate "Sign in with email" SSO page (may appear here and after transitions)
    await clickSignInWithEmailIfPresent(page);

    const hasVerifyPassword = await page.locator(SIGN_IN.VERIFY_PASSWORD_INPUT).isVisible({ timeout: 4_000 }).catch(() => false);
    const hasEmailInput = await page.locator(SIGN_IN.EMAIL_INPUT).isVisible({ timeout: 4_000 }).catch(() => false);
    console.error(`[workday:signin] Form detection → hasVerifyPassword=${hasVerifyPassword}  hasEmailInput=${hasEmailInput}`);

    if (!hasEmailInput && !hasVerifyPassword) {
        console.error("[workday:signin] No auth form detected — assuming already signed in.");
        return;
    }

    // PHASE 1: Try signing in first
    if (hasVerifyPassword) {
        console.error("[workday:signin] Landed on Create Account — switching to Sign In form...");
        const signedIn = await switchToSignInAndAttempt(page, email, password, FallbackPassword);
        if (signedIn === true) {
            console.error("[workday:signin] ✅ Sign-in succeeded on first try.");
            return;
        }
        if (signedIn === "verify_required") {
            await verifyAndRetrySignIn(page, email, password, FallbackPassword);
            return;
        }
        console.error("[workday:signin] ❌ Sign-in failed (account may not exist) — falling back to Create Account.");
    } else {
        console.error("[workday:signin] Already on Sign In form — attempting sign-in...");
        const signedIn = await attemptSignInWithFallback(page, email, password, FallbackPassword);
        if (signedIn === true) {
            console.error("[workday:signin] ✅ Sign-in succeeded.");
            return;
        }
        if (signedIn === "verify_required") {
            await verifyAndRetrySignIn(page, email, password, FallbackPassword);
            return;
        }
        console.error("[workday:signin] ❌ Sign-in failed — falling back to Create Account.");
    }

    // PHASE 2: Create Account
    console.error("[workday:signin] Switching to Create Account form...");
    const createLinkVisible = await page.locator(SIGN_IN.CREATE_ACCOUNT_LINK).isVisible({ timeout: 3_000 }).catch(() => false);
    console.error(`[workday:signin] createAccountLink visible: ${createLinkVisible}`);

    if (createLinkVisible) {
        await page.waitForTimeout(1_000); // anti-bot: pause before clicking Create Account toggle
        await page.locator(SIGN_IN.CREATE_ACCOUNT_LINK).click();
        console.error("[workday:signin] Clicked createAccountLink — waiting for verifyPassword...");
        await page.waitForFunction((sel) => {
            const el = document.querySelector(sel.VERIFY_PASSWORD_INPUT);
            return el && el.offsetParent !== null;
        }, SIGN_IN, { timeout: 8_000 }).catch(() =>
            console.error("[workday:signin] Timed out waiting for Create Account form — continuing")
        );
        await page.waitForTimeout(1_000); // anti-bot: let form animate in
    } else {
        console.error("[workday:signin] createAccountLink not visible — checking if already on Create Account form...");
        await dumpAutomationIds(page, "signin-pre-create");
    }

    const onCreateForm = await page.locator(SIGN_IN.VERIFY_PASSWORD_INPUT).isVisible({ timeout: 3_000 }).catch(() => false);
    console.error(`[workday:signin] On Create Account form: ${onCreateForm}`);

    await createAccount(page, email, password);
    console.error("[workday:signin] Account creation submitted — waiting for result...");

    await page.waitForTimeout(3_000);
    console.error(`[workday:signin] URL after account creation: ${page.url()}`);

    if (await isPastAuth(page)) {
        console.error("[workday:signin] ✅ Auto-signed in after account creation.");
        return;
    }

    // PHASE 3: Sign in after account creation
    // The page may have returned to the SSO chooser — handle it before checking for the form.
    await clickSignInWithEmailIfPresent(page);

    const emailVisible = await page.locator(SIGN_IN.EMAIL_INPUT).isVisible({ timeout: 3_000 }).catch(() => false);
    console.error(`[workday:signin] Email input visible after creation: ${emailVisible}`);

    if (!emailVisible) {
        console.error("[workday:signin] Auth form gone — assuming signed in.");
        return;
    }

    const verifyStillVisible = await page.locator(SIGN_IN.VERIFY_PASSWORD_INPUT).isVisible({ timeout: 1_000 }).catch(() => false);
    console.error(`[workday:signin] verifyPassword still visible: ${verifyStillVisible}`);

    let signedIn;
    if (verifyStillVisible) {
        console.error("[workday:signin] Still on Create Account after submission — switching to Sign In for retry...");
        signedIn = await switchToSignInAndAttempt(page, email, password, FallbackPassword);
    } else {
        console.error("[workday:signin] On Sign In form — retrying sign-in...");
        signedIn = await attemptSignInWithFallback(page, email, password, FallbackPassword);
    }

    if (signedIn === "verify_required") {
        await verifyAndRetrySignIn(page, email, password, FallbackPassword);
        return;
    }
    if (!signedIn) {
        const errors = await getVisibleErrors(page);
        throw new Error(
            `Login failed even after account creation. Page errors: ${errors.join(" | ") || "(none)"}\nCheck credentials in ${getDataDirName(projectRoot)}/candidate-profile.json.`
        );
    }
    console.error("[workday:signin] ✅ Signed in after account creation.");
}

// Switch from Create Account form → Sign In form, then attempt sign-in
async function switchToSignInAndAttempt(page, email, password, FallbackPassword) {
    const signInLink = page.locator(SIGN_IN.SIGN_IN_LINK);
    const linkVisible = await signInLink.isVisible({ timeout: 3_000 }).catch(() => false);
    console.error(`[workday:signin] switchToSignInAndAttempt — signInLink visible: ${linkVisible}`);

    if (!linkVisible) {
        console.error("[workday:signin] ⚠️  signInLink not found — cannot switch to Sign In");
        await dumpAutomationIds(page, "signin-link-missing");
        return false;
    }

    await page.waitForTimeout(1_000); // anti-bot: pause before clicking Sign In toggle
    await signInLink.click();
    console.error("[workday:signin] Clicked signInLink — waiting for verifyPassword to disappear...");

    await page.waitForFunction((sel) => {
        const vp = document.querySelector(sel.VERIFY_PASSWORD_INPUT);
        return !vp || vp.offsetParent === null;
    }, SIGN_IN, { timeout: 8_000 }).catch(() =>
        console.error("[workday:signin] Timed out waiting for form switch — continuing")
    );
    await page.waitForTimeout(1_000); // anti-bot: let Sign In form animate in

    const signInBtnVisible = await page.locator(SIGN_IN.SIGN_IN_SUBMIT_BUTTON).isVisible({ timeout: 3_000 }).catch(() => false);
    const verifyGone = !(await page.locator(SIGN_IN.VERIFY_PASSWORD_INPUT).isVisible({ timeout: 1_000 }).catch(() => false));
    console.error(`[workday:signin] After switch → signInSubmitButton=${signInBtnVisible}  verifyPassword gone=${verifyGone}`);

    if (!signInBtnVisible) {
        console.error("[workday:signin] ⚠️  Sign In form did not appear after clicking signInLink");
        await dumpAutomationIds(page, "signin-switch-failed");
        return false;
    }

    return await attemptSignInWithFallback(page, email, password, FallbackPassword);
}

// Try primary password first, then fallback. Skips fallback if passwords match or fallback is missing.
async function attemptSignInWithFallback(page, email, password, fallbackPassword) {
    const result = await attemptSignIn(page, email, password);
    if (result === true) return true;
    if (result === "verify_required") return "verify_required";

    if (fallbackPassword && fallbackPassword !== password) {
        console.error("[workday:signin] Primary password failed — trying fallback password...");
        return await attemptSignIn(page, email, fallbackPassword);
    }
    return result;
}

// Fill and submit the Sign In form. Returns true on success, false on failure.
async function attemptSignIn(page, email, password) {
    console.error("[workday:attemptSignIn] ── enter ──");
    const emailInput = page.locator(SIGN_IN.EMAIL_INPUT);

    console.error("[workday:attemptSignIn] Waiting for email input...");
    await emailInput.waitFor({ state: "visible", timeout: 8_000 });
    console.error(`[workday:attemptSignIn] Filling email: ${email}`);
    await emailInput.fill("");
    await page.waitForTimeout(500); // anti-bot: brief pause between keystrokes
    await emailInput.fill(email);
    await page.waitForTimeout(1_000); // anti-bot: pause after typing email

    const pwInput = page.locator(SIGN_IN.PASSWORD_INPUT);
    console.error("[workday:attemptSignIn] Waiting for password input...");
    await pwInput.waitFor({ state: "visible", timeout: 5_000 });
    await pwInput.fill(password);
    await page.waitForTimeout(1_000); // anti-bot: pause after typing password
    console.error("[workday:attemptSignIn] Credentials filled — looking for submit control...");

    const signInOverlay = page.locator(SIGN_IN.SIGN_IN_OVERLAY);
    const signInBtn = page.locator(SIGN_IN.SIGN_IN_SUBMIT_BUTTON);
    const overlayVis = await signInOverlay.isVisible({ timeout: 1_000 }).catch(() => false);
    const btnVis = await signInBtn.isVisible({ timeout: 1_000 }).catch(() => false);
    console.error(`[workday:attemptSignIn] click_filter overlay=${overlayVis}  signInSubmitButton=${btnVis}`);

    await page.waitForTimeout(1_000); // anti-bot: pause before clicking Sign In submit
    if (overlayVis) {
        console.error("[workday:attemptSignIn] Clicking click_filter[Sign In] overlay...");
        await signInOverlay.click();
    } else if (btnVis) {
        console.error("[workday:attemptSignIn] Clicking signInSubmitButton (force)...");
        await signInBtn.click({ force: true });
    } else {
        console.error("[workday:attemptSignIn] No submit control found — pressing Enter in password field...");
        await pwInput.press("Enter");
    }

    console.error("[workday:attemptSignIn] Submitted — polling for outcome (up to 8 s)...");

    for (let i = 0; i < 16; i++) {
        await page.waitForTimeout(500);

        const url = page.url().split('/').slice(-2).join('/');
        const formStill = await signInBtn.isVisible({ timeout: 500 }).catch(() => false);
        const pastAuth = await isPastAuth(page);
        const errors = await getVisibleErrors(page);

        console.error(`[workday:attemptSignIn] poll ${i + 1}/16 — url=...${url}  formBtn=${formStill}  pastAuth=${pastAuth}  errors=${errors.length}`);

        if (errors.length > 0) {
            console.error(`[workday:attemptSignIn] ❌ Error(s) on page: ${errors.join(" | ")}`);
            if (errors.some(e => /verify.*account|verify.*email|account.*verif/i.test(e))) {
                console.error("[workday:attemptSignIn] ⚠️  Email verification required — returning verify_required");
                return "verify_required";
            }
            return false;
        }
        if (pastAuth) {
            console.error("[workday:attemptSignIn] ✅ Past auth — sign-in succeeded.");
            return true;
        }
        if (!formStill) {
            console.error("[workday:attemptSignIn] Form gone — waiting 2 s for navigation...");
            await page.waitForTimeout(1_000);
            const lateErrors = await getVisibleErrors(page);
            if (lateErrors.length > 0) {
                console.error(`[workday:attemptSignIn] ❌ Late errors: ${lateErrors.join(" | ")}`);
                return false;
            }
            console.error("[workday:attemptSignIn] ✅ Form gone, no errors — treating as success.");
            return true;
        }
    }

    console.error("[workday:attemptSignIn] ❌ Sign-in form still active after 8 s — treating as failure.");
    return false;
}

// Create a new Workday account. Assumes the Create Account form is visible.
async function createAccount(page, email, password) {
    console.error("[workday:createAccount] ── enter ──");

    const verifyVisible = await page.locator(SIGN_IN.VERIFY_PASSWORD_INPUT).isVisible({ timeout: 1_000 }).catch(() => false);
    const signInVisible = await page.locator(SIGN_IN.SIGN_IN_SUBMIT_BUTTON).isVisible({ timeout: 1_000 }).catch(() => false);
    console.error(`[workday:createAccount] verifyPassword=${verifyVisible}  signInSubmitButton=${signInVisible}`);

    if (!verifyVisible) {
        if (signInVisible) {
            console.error("[workday:createAccount] On Sign In form — switching to Create Account via createAccountLink...");
            const createLink = page.locator(SIGN_IN.CREATE_ACCOUNT_LINK);
            const linkVis = await createLink.isVisible({ timeout: 3_000 }).catch(() => false);
            console.error(`[workday:createAccount] createAccountLink visible: ${linkVis}`);
            if (linkVis) {
                await createLink.click();
                await page.waitForFunction((sel) => {
                    const el = document.querySelector(sel.VERIFY_PASSWORD_INPUT);
                    return el && el.offsetParent !== null;
                }, SIGN_IN, { timeout: 8_000 }).catch(() =>
                    console.error("[workday:createAccount] Timed out waiting for Create Account form")
                );
                await page.waitForTimeout(500);
            } else {
                await dumpAutomationIds(page, "createAccount-link-missing");
            }
        } else {
            console.error("[workday:createAccount] verifyPassword not visible — dumping page state...");
            await dumpAutomationIds(page, "createAccount-no-form");
        }
    }

    console.error("[workday:createAccount] Filling email, password, verifyPassword...");
    await page.locator(SIGN_IN.EMAIL_INPUT).fill(email);
    await page.waitForTimeout(1_000); // anti-bot: pause between fields
    await page.locator(SIGN_IN.PASSWORD_INPUT).fill(password);
    await page.waitForTimeout(1_000); // anti-bot: pause between fields
    await page.locator(SIGN_IN.VERIFY_PASSWORD_INPUT).fill(password);
    await page.waitForTimeout(1_000); // anti-bot: pause after filling all fields
    console.error("[workday:createAccount] Fields filled.");

    const checkbox = page.locator(SIGN_IN.CREATE_ACCOUNT_CHECKBOX);
    const checkboxExists = await checkbox.isVisible({ timeout: 2_000 }).catch(() => false);
    console.error(`[workday:createAccount] Privacy checkbox present: ${checkboxExists}`);
    if (checkboxExists) {
        const isChecked = await checkbox.isChecked().catch(() => false);
        console.error(`[workday:createAccount] Privacy checkbox already checked: ${isChecked}`);
        if (!isChecked) {
            await checkbox.check();
            console.error("[workday:createAccount] Privacy checkbox checked.");
        }
    } else {
        console.error("[workday:createAccount] No privacy checkbox on this instance — skipping.");
    }

    const createOverlay = page.locator(SIGN_IN.CREATE_ACCOUNT_OVERLAY);
    const createBtn = page.locator(SIGN_IN.CREATE_ACCOUNT_SUBMIT_BUTTON);
    const overlayVis = await createOverlay.isVisible({ timeout: 1_000 }).catch(() => false);
    const createBtnVis = await createBtn.isVisible({ timeout: 1_000 }).catch(() => false);
    console.error(`[workday:createAccount] click_filter overlay=${overlayVis}  createAccountSubmitButton=${createBtnVis}`);

    await page.waitForTimeout(1_000); // anti-bot: pause before clicking Create Account submit
    if (overlayVis) {
        console.error("[workday:createAccount] Clicking click_filter[Create Account] overlay...");
        await createOverlay.click();
    } else if (createBtnVis) {
        console.error("[workday:createAccount] Clicking createAccountSubmitButton (force)...");
        await createBtn.click({ force: true });
    } else {
        console.error("[workday:createAccount] No submit control — pressing Enter in verifyPassword...");
        await page.locator(SIGN_IN.VERIFY_PASSWORD_INPUT).press("Enter");
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => { });
    await page.waitForTimeout(2_000); // anti-bot: let the server process account creation
    console.error(`[workday:createAccount] Submitted — URL: ${page.url()}`);
    const postErrors = await getVisibleErrors(page);
    if (postErrors.length > 0) {
        console.error(`[workday:createAccount] ⚠️  Errors after submission: ${postErrors.join(" | ")}`);
        if (postErrors.some(e => /already.*exist|already.*registered|email.*taken/i.test(e))) {
            throw new Error(`Account already exists for ${email}. Try signing in instead.`);
        }
    }
}
