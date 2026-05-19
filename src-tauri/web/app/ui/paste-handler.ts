// Capture-Phase-Paste-Listener fuer Bilder. Wenn der User Strg+V im
// Editor-Bereich drueckt und ein Bild im ClipboardData haengt, wird das
// Default-Paste-Verhalten von Monaco unterdrueckt und stattdessen der
// Image-Insert-Dialog geoeffnet (mit dem Bild-Blob als Preload).
//
// Bei reinem Text-Paste passiert hier nichts — Monaco behandelt das wie
// gehabt. Wir lauschen am Document mit `capture:true`, weil Monacos
// eigener Paste-Handler dieselben Events schluckt, sobald der Fokus im
// Editor liegt.

type Trigger = (blob: Blob) => void;

let trigger: Trigger | null = null;
let attached = false;

function isInEditorScope(target: EventTarget | null): boolean {
    if (!document.body.classList.contains('edit-mode')) return false;
    if (!document.body.classList.contains('kind-markdown')) return false;
    if (!(target instanceof Node)) return true;
    // Editor-Mount + dessen Descendant zaehlen. Wenn der Fokus in der
    // Find-Bar oder im Vault-Tree liegt, ignorieren wir Image-Pastes —
    // sonst stoeren wir Text-Pastes in regulaere <input>-Felder.
    const mount = document.getElementById('editor-mount');
    return !!mount && (mount === target || mount.contains(target as Node));
}

function findImageBlob(data: DataTransfer | null): Blob | null {
    if (!data) return null;
    const items = data.items;
    if (items) {
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
                const file = it.getAsFile();
                if (file) return file;
            }
        }
    }
    if (data.files && data.files.length > 0) {
        for (let i = 0; i < data.files.length; i++) {
            const f = data.files[i];
            if (f.type && f.type.startsWith('image/')) return f;
        }
    }
    return null;
}

function onPaste(e: ClipboardEvent): void {
    if (!trigger) return;
    if (!isInEditorScope(e.target)) return;
    const blob = findImageBlob(e.clipboardData);
    if (!blob) return; // Text-Paste oder kein Bild — Monaco macht normal weiter.
    e.preventDefault();
    e.stopPropagation();
    trigger(blob);
}

export function attachPasteHandler(onImagePaste: Trigger): void {
    trigger = onImagePaste;
    if (attached) return;
    document.addEventListener('paste', onPaste, { capture: true });
    attached = true;
}
