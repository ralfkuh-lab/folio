// Das GFM-Plugin von Joplin liefert keine eigenen Typen. Wir nutzen nur
// den `gfm`-Export (Tabellen, Durchgestrichen, Task-Listen).
declare module '@joplin/turndown-plugin-gfm' {
    export function gfm(turndownService: any): void;
}
