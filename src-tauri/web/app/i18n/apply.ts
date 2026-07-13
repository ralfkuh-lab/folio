/* Static DOM applier: data-i18n / -title / -placeholder / -aria-label.
   data-i18n only on leaf elements (no element children); otherwise warn+skip.
   Without catalog: no apply (German HTML placeholders stay; never raw keys). */

import { getCatalog, t } from './translate';

function hasElementChildren(el: Element): boolean {
    for (let i = 0; i < el.childNodes.length; i++) {
        if (el.childNodes[i].nodeType === 1) return true;
    }
    return false;
}

/**
 * Apply catalog strings to the static DOM. No-op when catalog is missing
 * (degradation). Always sets documentElement.lang when catalog is present.
 */
export function applyStaticTranslations(root?: ParentNode): void {
    const catalog = getCatalog();
    if (!catalog) return;

    const scope: ParentNode = root || document;
    const doc = (scope as Document).documentElement
        ? (scope as Document)
        : document;

    if (doc.documentElement) {
        doc.documentElement.lang = catalog.tag || 'en';
    }

    const nodes = scope.querySelectorAll
        ? scope.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label]')
        : [];

    for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i] as HTMLElement;
        const textKey = el.getAttribute('data-i18n');
        if (textKey) {
            if (hasElementChildren(el)) {
                // eslint-disable-next-line no-console
                console.warn(
                    '[folio:i18n] data-i18n on non-leaf element; skip',
                    textKey,
                    el.tagName,
                );
            } else {
                el.textContent = t(textKey);
            }
        }
        const titleKey = el.getAttribute('data-i18n-title');
        if (titleKey) {
            el.setAttribute('title', t(titleKey));
        }
        const phKey = el.getAttribute('data-i18n-placeholder');
        if (phKey) {
            el.setAttribute('placeholder', t(phKey));
        }
        const ariaKey = el.getAttribute('data-i18n-aria-label');
        if (ariaKey) {
            el.setAttribute('aria-label', t(ariaKey));
        }
    }
}
