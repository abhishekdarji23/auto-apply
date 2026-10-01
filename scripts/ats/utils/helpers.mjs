

export function parseJsonOrNull(value) {
    if (!value || typeof value !== "string") return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

export function toEntryArray(value) {
    return Array.isArray(value) ? value.filter((entry) => Array.isArray(entry) && entry.length >= 2) : [];
}

export function normalizeText(value) {
    return String(value ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

/**
 * Sort map entries by live DOM order in browser context.
 * Works for any ATS as long as entry values use Simplify-style found element metadata.
 *
 * @param {import('playwright').Page} page
 * @param {*} mapData
 * @param {{ keyPrefix?: string }} [options]
 * @returns {Promise<Array<[string, any]>>}
 */
export async function sortMapEntriesByDomOrder(page, mapData, options = {}) {
    if (!page) return [];

    const keyPrefix = String(options?.keyPrefix ?? "trackedInput:");

    return page.evaluate(({ inputMap, prefix }) => {
        function toEntryArrayLocal(value) {
            return Array.isArray(value)
                ? value.filter((entry) => Array.isArray(entry) && entry.length >= 2)
                : [];
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

        function getBestDomNode(entryValue) {
            return (
                resolveElement(entryValue?.foundLabelElement) ||
                resolveElement(entryValue?.foundFieldElement) ||
                resolveElement(entryValue?.foundInputElement) ||
                resolveElement(entryValue?.foundElement) ||
                resolveElement(entryValue?.foundInput?.foundElement) ||
                null
            );
        }

        const entries = toEntryArrayLocal(inputMap);
        const scopedEntries = entries.filter(([key]) => String(key).startsWith(prefix));

        const enriched = scopedEntries.map((entry, originalIndex) => ({
            entry,
            originalIndex,
            node: getBestDomNode(entry?.[1]),
        }));

        enriched.sort((a, b) => {
            const aNode = a.node;
            const bNode = b.node;

            if (aNode && bNode) {
                if (aNode === bNode) return 0;
                const pos = aNode.compareDocumentPosition(bNode);
                if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            }

            if (aNode && !bNode) return -1;
            if (!aNode && bNode) return 1;
            return a.originalIndex - b.originalIndex;
        });

        return enriched.map((item) => item.entry);
    }, { inputMap: mapData, prefix: keyPrefix });
}