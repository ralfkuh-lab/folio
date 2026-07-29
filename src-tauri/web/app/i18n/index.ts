/* Public surface for app/i18n (I1b). */

export { initI18n, t, tPlural, seedCatalog, getCatalog, isI18nReady, __resetI18nForTests } from './translate';
export { applyStaticTranslations } from './apply';
export {
    fmtNumber,
    fmtDate,
    fmtBytes,
    compareStrings,
    normalizeForSearch,
    setFormatLocale,
    getFormatLocale,
} from './format';
export {
    BOOT_EVENT_NAMES,
    installListenPatch,
    installPreAdapters,
    awaitPendingListens,
    drainUntilDryAndGoLive,
    getBootstrapPhase,
    setBootstrapPhase,
    getQueueSnapshot,
    enqueue,
    __resetEventQueueForTests,
} from './event-queue';
export type { I18nCatalog, CatalogValue, LanguageInfo, BootstrapPhase } from './types';
