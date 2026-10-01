const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);

export function isEnvEnabled(name, defaultValue = false) {
    const raw = process.env[name];
    if (raw === undefined) return defaultValue;

    const value = String(raw).trim().toLowerCase();
    if (!value) return defaultValue;
    if (TRUE_VALUES.has(value)) return true;
    if (FALSE_VALUES.has(value)) return false;
    return defaultValue;
}

export function shouldCloseAtsPageOnFailure() {
    return isEnvEnabled("ATS_CLOSE_PAGE_ON_FAIL", !isEnvEnabled("ATS_DEBUG", false));
}
