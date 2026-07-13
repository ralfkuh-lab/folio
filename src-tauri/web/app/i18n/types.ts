/** Catalog value: plain string or CLDR plural object (atomic). */
export type CatalogValue = string | { [category: string]: string };

export type LanguageInfo = {
    tag: string;
    name: string;
};

export type I18nCatalog = {
    tag: string;
    locale: string;
    languages: LanguageInfo[];
    strings: { [key: string]: CatalogValue };
};

export type BootstrapPhase = 'booting' | 'i18nReady' | 'uiReady';
