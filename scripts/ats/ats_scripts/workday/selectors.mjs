// workday/selectors.mjs — single source of truth for all Workday DOM selectors.

// Job posting page
export const JOB_POSTING = {
    HEADER: '[data-automation-id="jobPostingHeader"]',
    DESCRIPTION: '[data-automation-id="jobPostingDescription"]',
    APPLY_BUTTON: '[data-automation-id="adventureButton"]',
    APPLY_MANUALLY_BUTTON: '[data-automation-id="applyManually"]',
    ERROR_MESSAGE: '[data-automation-id="errorMessage"]',
    NOT_FOUND_TEXT: "the page you are looking for doesn't exist",
};

// Auth-state detection (used by isPastAuth)
export const AUTH_STATE = {
    BOTTOM_NAV_NEXT: '[data-automation-id="bottomNavigationNext"]',
    SAVE_AND_CONTINUE: '[data-automation-id="saveAndContinueButton"]',
    FORM_HEADER: '[data-automation-id="formHeader"]',
};

// Sign-in / create-account flow
export const SIGN_IN = {
    RESEND_VERIFICATION_BUTTON: '[data-automation-id="informationalBlurbButton"]',
    EMAIL_INPUT: '[data-automation-id="email"]',
    PASSWORD_INPUT: '[data-automation-id="password"]',
    VERIFY_PASSWORD_INPUT: '[data-automation-id="verifyPassword"]',
    SIGN_IN_WITH_EMAIL_BUTTON: '[data-automation-id="SignInWithEmailButton"]',
    SIGN_IN_LINK: '[data-automation-id="signInLink"]',
    SIGN_IN_SUBMIT_BUTTON: '[data-automation-id="signInSubmitButton"]',
    SIGN_IN_OVERLAY: '[data-automation-id="click_filter"][aria-label="Sign In"]',
    CREATE_ACCOUNT_LINK: '[data-automation-id="createAccountLink"]',
    CREATE_ACCOUNT_CHECKBOX: '[data-automation-id="createAccountCheckbox"]',
    CREATE_ACCOUNT_SUBMIT_BUTTON: '[data-automation-id="createAccountSubmitButton"]',
    CREATE_ACCOUNT_OVERLAY: '[data-automation-id="click_filter"][aria-label="Create Account"]',
};

// Step loop / progress bar
export const STEP_LOOP = {
    PROGRESS_BAR_ACTIVE_STEP: '[data-automation-id="progressBarActiveStep"]',
    // XPath: Continue or Next button
    CONTINUE_BUTTON_XPATH: './/button[(@data-automation-id="bottom-navigation-next-button" or @data-automation-id="pageFooterNextButton") and (contains(., "Continue") or contains(., "Next"))]',
    // XPath: Submit or Send button (review page)
    SUBMIT_BUTTON_XPATH: './/button[(@data-automation-id="bottom-navigation-next-button" or @data-automation-id="pageFooterNextButton") and (contains(., "Submit") or contains(., "Send"))]',
    // XPath patterns that confirm the application was submitted successfully
    SUBMITTED_SUCCESS_PATHS: [
        './/div[@role="dialog"]//svg[contains(@class, "wd-icon-check-circle")]',
        './/div[@role="dialog"]//h2[starts-with(translate(normalize-space(translate(., "\u00c2\u00a0", " ")), "APPLICATION SUBMITTED", "application submitted"), "application submitted")]',
        './/*[contains(translate(normalize-space(translate(., "\u00c2\u00a0", " ")), "CONGRATULATIONS", "congratulations"), "congratulations")]',
        './/*[contains(translate(normalize-space(translate(., "\u00c2\u00a0", " ")), "THANK YOU FOR APPLYING", "thank you for applying"), "thank you for applying")]',
    ],
    ERROR_BLOCK: '[data-automation-id="errorBlock"], [data-automation-id*="error"], [role="alert"], [class*="error"]',
    ERROR_PAGE_TEXT: 'Something went wrong',
    DUMP_ALL: '[data-automation-id]',
};

// Information step — auto-fill config (no LLM needed for these two fields)
export const INFORMATION_AUTO_FILLS = {
    // "Were you previously employed here?" — always select No
    PREV_WORKER: {
        CONTAINER: '[data-automation-id="formField-candidateIsPreviousWorker"]',
        NO_RADIO: 'input[type="radio"][value="false"]',
    },
    // "How did you hear about this position?" — always fill with LinkedIn
    SOURCE: {
        CONTAINER: '[data-automation-id="formField-source"]',
        // Type 1: single-select dropdown with a listbox button
        LISTBOX_BUTTON: 'button[aria-haspopup="listbox"]',
        LISTBOX_OPTIONS_XPATH: '//div[@visibility="opened"]//ul[@role="listbox"]//li[@role="option"][not(@aria-disabled="true")]',
        // Type 2: type-ahead multiselect
        MULTISELECT_CONTAINER: '[data-automation-id="multiSelectContainer"]',
        MULTISELECT_INPUT: 'input:not([type="hidden"])',
        MULTISELECT_OPTIONS_XPATH: '//div[@data-uxi-widget-type="multiselectlist"]//*[@data-automation-id="menuItem"]',
        // Value to select/type for both types
        VALUE: "LinkedIn",
    },
};

// Extension fill — sessionStorage keys written by the Simplify extension
export const EXTENSION_FILL = {
    STATUS_KEY: "autofill-fill-status",
    FIELDMAP_KEY: "autofill-fieldmap",
    FOUND_INPUT_MAP_KEY: "simplify_foundInputMap",
};

// Experience page selectors
export const EXPERIENCE = {
    /** aria-labelledby value on the Languages section container */
    LANGUAGES_SECTION: '[aria-labelledby="Languages-section"]',
    /** Exact text of the delete button inside the Languages section */
    DELETE_BUTTON_TEXT: "Delete",
};

// Gmail inbox selectors (used for email verification flow in signin.mjs)
export const GMAIL = {
    INBOX_TABLE: '[id^=":1"] div table',
    FIRST_ROW_INDEX: 1,
    FIRST_ROW_SELECTOR: "tbody tr",
    DELETE_BUTTON: 'div[gh="mtb"] div[role="button"][act="10"][title="Delete"]',
    DELETE_INNER: ".asa, .ar9, div",
};
