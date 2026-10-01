/**
 * greenhouse/selectors.mjs
 *
 * Central DOM / sessionStorage selector map for the Greenhouse ATS.
 * Change a selector here and it takes effect everywhere in this module.
 *
 * Sections (top → bottom, matching dependency order in the pipeline):
 *   1.  EXTENSION_FILL  – keys / selectors the Simplify extension uses
 *   2.  JOB_INFO        – page selectors used to scrape job title + description
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Extension-fill selectors
//    Used in index.mjs when reading the maps the extension writes to session
//    storage after it finishes filling the form.
// ─────────────────────────────────────────────────────────────────────────────

export const EXTENSION_FILL = {
    /** sessionStorage key written by the Simplify extension with fill status */
    STATUS_KEY: "autofill-fill-status",

    /** sessionStorage key for the field-map the extension builds */
    FIELDMAP_KEY: "autofill-fieldmap",

    /** sessionStorage key for the found-input map the extension builds */
    FOUND_INPUT_MAP_KEY: "simplify_foundInputMap",
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Job-info page selectors
//    Used in index.mjs to scrape job title and description from the page
//    and to detect a 404 / job-not-found state before doing any work.
// ─────────────────────────────────────────────────────────────────────────────

export const JOB_INFO = {
    /** <h1> element that contains the job title */
    TITLE: "h1.section-header",

    /** <div> element that contains the full job description */
    DESCRIPTION: "div.job__description",

    /** Text that appears in body when the job post no longer exists */
    NOT_FOUND_TEXT: "Sorry, but we can't find that page.",
};

export const QUESTION_BUILDER = {
    MAIN_CLICK_TARGET: ".main",
    CLEAR_BUTTON: '[class*="clear-indicator"], [class*="clearIndicator"], [aria-label*="clear" i], [title*="clear" i]',
    CHECKBOX_RADIO_INPUTS: "input[type='checkbox'], input[type='radio']",
    CHECKBOX_RADIO_DESCENDANTS: "input[type='checkbox'], input[type='radio']",
    CHECKBOX_LABELS: "label",
    LABEL_WITH_FOR_PREFIX: "label[for=",

    COVER_LETTER_GROUP: '[aria-labelledby="upload-label-cover_letter"]',
    COVER_LETTER_LABEL: "#upload-label-cover_letter, .upload-label",
    COVER_LETTER_REQUIRED_MARK: ".required",
    COVER_LETTER_ENTER_MANUAL: '[data-testid="cover_letter-text"], button[data-testid="cover_letter-text"], button[aria-label*="enter manually" i]',
    COVER_LETTER_TEXTAREA: "textarea#cover_letter_text, textarea",
    BUTTON: "button",

    SELECT_CLASS_PATTERN: "select__container|select__value-container",
    SELECT_OPTION_PATH_PATTERN: "select__option|option",
    CHECKBOX_OPTION_PATH_PATTERN: 'checkbox__wrapper|fieldset\\[contains\\(@class,\\s*"checkbox"\\)\\]',
    ENTER_MANUAL_TEXT_PATTERN: "enter\\s+manually",
};

export const FORM_FILLER = {
    LOCATE_BUTTONS: "button.btn--tertiary, button[type='button']",
    LOCATE_ME_TEXT: "locate me",

    CONSENT_CHECKBOX_INPUTS: "input[type='checkbox']",
    CONSENT_CHECKBOX_GROUPS: ".checkbox--full-width.checkbox",
    CONSENT_DISABLED_CLASS: "checkbox--disabled",
    CONSENT_MAX_PASSES: 4,
    CONSENT_PASS_DELAY_MS: 200,
    LABEL_WITH_FOR_PREFIX: "label[for=",
    CHECKBOX_WRAPPER: ".checkbox__wrapper",
    LABEL: "label",
    CONSENT_PREFIXES: [
        "i consent",
        "i agree",
        "by checking this box i consent",
        "by checking this box, i consent",
        "i authorize",
        "i acknowledge",
    ],
    CONSENT_KEYWORDS: [
        "consent",
        "gdpr",
        "demographic data",
        "privacy",
        "data processing",
        "collecting, storing, and processing",
    ],

    TEXT_TARGET: "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([disabled]), textarea:not([disabled])",
    COVER_LETTER_GROUP: '[aria-labelledby="upload-label-cover_letter"]',
    COVER_LETTER_LABEL: "#upload-label-cover_letter, #upload-label_cover_letter, .upload-label",
    COVER_LETTER_REQUIRED_MARK: ".required",
    COVER_LETTER_ENTER_MANUAL: '[data-testid="cover_letter-text"], button[data-testid="cover_letter-text"], button[aria-label*="enter manually" i]',
    BUTTON: "button",
    COVER_LETTER_IN_GROUP_TEXTAREA: "textarea#cover_letter_text, textarea[id*='cover_letter' i], textarea[name*='cover_letter' i], textarea",
    FIELD_WRAPPER: ".field-wrapper",
    COVER_LETTER_BY_ID: "textarea#cover_letter_text",
    COVER_LETTER_ANY: "textarea[id*='cover_letter' i], textarea[name*='cover_letter' i]",
    COVER_LETTER_TEXTAREA: "textarea#cover_letter_text, textarea",
    ENTER_MANUAL_TEXT_PATTERN: "enter\\s+manually",

    VISIBLE_SELECT_OPTIONS: ".select__option, [role='option'], option",
    CHECKBOX_RADIO_INPUTS: "input[type='checkbox'], input[type='radio']",
};

export const GREENHOUSE_INDEX = {
    SUBMIT_BUTTON_PATHS: [
        './/input[@type="submit" and @data-trackingid="job-application-submit"]',
        './/button[@type="submit" and (contains(@class, "submit-step") or contains(., "Submit"))]',
    ],
    SUBMITTED_SUCCESS_PATHS: [
        './/div[@class="confirmation"]/div[@class="confirmation__content"]',
        './/h2[contains(@class, "rich-text__title") and contains(text(), "We got your application")]',
    ],

    OTP_WRAPPER: ".email-verification__wrapper",
    OTP_INPUTS: "input[id^='security-input-']",

    GMAIL_INBOX_TABLE: '[id^=":1"] div table',
    GMAIL_FIRST_MAIL_ROW_INDEX: 1,
    GMAIL_FIRST_MAIL_ROW: "tbody tr",
    GMAIL_ROW_COUNTER: "tr",
    GMAIL_H1_COUNTER: "h1",
    GMAIL_OTP_TAG: "h1",
    GMAIL_DELETE_BUTTON: 'div[gh="mtb"] div[role="button"][act="10"][title="Delete"]',
    GMAIL_DELETE_INNER: ".asa, .ar9, div",
};
