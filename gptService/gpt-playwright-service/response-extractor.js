/** Read a complete LaTeX document from either ChatGPT response layout. */
async function readLatexResponseState(pg) {
    const stopVisible = await pg.evaluate(() => Array.from(document.querySelectorAll("button")).some((button) => {
        const label = (button.getAttribute("aria-label") || "").toLowerCase();
        const text = (button.innerText || "").trim().toLowerCase();
        const testId = (button.dataset.testid || "").toLowerCase();
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 &&
            (label.includes("stop") || text === "stop" || testId.includes("stop"));
    })).catch(() => false);

    if (stopVisible) return { latex: null, stopVisible, source: null };

    // Prefer the newest document card when both response layouts are present.
    const openDocument = pg.getByRole("button", { name: /^Open document$/i }).last();
    if (await openDocument.isVisible({ timeout: 300 }).catch(() => false)) {
        const panel = pg.locator("#latex-document-left");
        const editor = panel.locator(".cm-content");
        if (!(await panel.isVisible({ timeout: 300 }).catch(() => false))) {
            await openDocument.click({ timeout: 3000 }).catch(() => { });
        }
        await editor.waitFor({ state: "visible", timeout: 5000 }).catch(() => { });
    }

    // CodeMirror virtualizes visible lines. Its document state contains the full source.
    let result = await pg.evaluate(() => {
        const editor = document.querySelector("#latex-document-left .cm-content");
        const text = editor?.cmTile?.view?.state?.doc?.toString() || "";
        return { text, source: text ? "latex-document-editor" : null };
    }).catch(() => ({ text: "", source: null }));

    if (!result.text) {
        // The older response layout exposes its entire code block directly.
        result = await pg.evaluate(() => {
            const text = document.getElementById("code-block-viewer")?.innerText || "";
            return { text, source: text ? "code-block-viewer" : null };
        }).catch(() => ({ text: "", source: null }));
    }

    const text = result.text.trim();
    const complete = text.includes("\\documentclass") &&
        text.includes("\\begin{document}") && text.includes("\\end{document}");
    return { latex: complete ? text : null, stopVisible, source: result.source };
}

module.exports = { readLatexResponseState };
