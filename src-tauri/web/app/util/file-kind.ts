/* Endungs-Spiegel von file_kind.rs::classify — IO-frei, fuer Gates
   (Git-Diff), die keinen geladenen Deskriptor haben. Image gewinnt vor
   Text, damit .svg nicht als Diff-faehig gilt. Unbekannte Endungen
   sind Binary. */

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd']);
const IMAGE_EXT = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
]);
const TEXT_EXT = new Set([
    'txt', 'log', 'ini', 'conf', 'cfg', 'env', 'rst', 'csv', 'tsv',
    'json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm',
    'css', 'scss', 'sass', 'less', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
    'rs', 'py', 'rb', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp',
    'hpp', 'cs', 'fs', 'fsx', 'swift', 'php', 'sh', 'bash', 'zsh', 'fish',
    'ps1', 'bat', 'cmd', 'sql', 'graphql', 'gql', 'lua', 'r', 'tex', 'bib',
    'dockerfile', 'makefile', 'gitignore', 'gitattributes', 'editorconfig',
    'step', 'stp', 'gcode', 'gco', 'nc', 'scad', 'obj',
]);
const SPECIAL_TEXT_NAMES = new Set([
    'readme', 'license', 'licence', 'changelog', 'authors', 'contributors',
]);

function fileName(path: string): string {
    const norm = path.replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    return (slash >= 0 ? norm.slice(slash + 1) : norm).toLowerCase();
}

/** true fuer classify() ∈ {Markdown, Text}. Image und Binary sind false. */
export function isTextOrMarkdownPath(path: string): boolean {
    const name = fileName(path);
    if (!name) return false;
    if (SPECIAL_TEXT_NAMES.has(name)) return true;
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot + 1) : '';
    const key = ext || (name.charAt(0) === '.' ? name.slice(1) : '');
    if (!key) return false;
    if (IMAGE_EXT.has(key)) return false;
    return MARKDOWN_EXT.has(key) || TEXT_EXT.has(key);
}
