/* Kleiner Multi-Turn-Chat zum Testen eines whitelisteten Modells über das
   Command `ai_model_chat_test`. Das Overlay-Markup (`#ai-chat-test-dialog`)
   liegt im Panel „KI-Modelle"; geöffnet wird über den „Test"-Button einer
   Modellzeile (settings-ai.ts). Antworten werden ausschließlich per
   textContent gerendert — kein HTML aus Modell-Antworten. */

import { folioLog } from '../util/log';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

let currentProviderId = '';
let currentModelId = '';
let messages: ChatMessage[] = [];
let pending = false;

function el(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function getInvoke(): ((cmd: string, args?: any) => Promise<any>) | null {
    const core = window.__TAURI__ && window.__TAURI__.core;
    return core && typeof core.invoke === 'function' ? core.invoke : null;
}

function setError(message: string | null): void {
    const error = el('ai-chat-test-error');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
}

function renderMessages(loading = false): void {
    const list = el('ai-chat-test-messages');
    if (!list) return;
    list.textContent = '';
    for (const message of messages) {
        const row = document.createElement('div');
        row.className =
            `settings-ai-chat__message settings-ai-chat__message--${message.role}`;
        const role = document.createElement('span');
        role.textContent = message.role === 'user' ? 'Du' : 'Modell';
        const text = document.createElement('p');
        text.textContent = message.content;
        row.append(role, text);
        list.appendChild(row);
    }
    if (loading) {
        const row = document.createElement('div');
        row.className = 'settings-ai-chat__message settings-ai-chat__message--assistant';
        const role = document.createElement('span');
        role.textContent = 'Modell';
        const text = document.createElement('p');
        text.textContent = '…';
        row.append(role, text);
        list.appendChild(row);
    }
    list.scrollTop = list.scrollHeight;
}

async function sendMessage(): Promise<void> {
    const inputEl = el('ai-chat-test-input') as HTMLTextAreaElement | null;
    const sendButton = el('ai-chat-test-send') as HTMLButtonElement | null;
    if (!inputEl || !sendButton || pending) return;
    const content = inputEl.value.trim();
    if (!content) return;
    const invoke = getInvoke();
    if (!invoke) {
        setError('Tauri-Schnittstelle ist nicht verfügbar.');
        return;
    }
    messages.push({ role: 'user', content });
    inputEl.value = '';
    setError(null);
    pending = true;
    sendButton.disabled = true;
    renderMessages(true);
    try {
        const reply = await invoke('ai_model_chat_test', {
            providerId: currentProviderId,
            modelId: currentModelId,
            messages: messages.map((message) => ({ ...message })),
        }) as string;
        messages.push({ role: 'assistant', content: reply });
        renderMessages();
    } catch (error) {
        folioLog.warn('settings-ai', 'Chat-Test fehlgeschlagen', {
            provider: currentProviderId,
            model: currentModelId,
            error: String(error),
        });
        renderMessages();
        setError(String(error));
    } finally {
        pending = false;
        sendButton.disabled = false;
        inputEl.focus();
    }
}

function closeDialog(): void {
    const dialog = el('ai-chat-test-dialog');
    if (dialog) dialog.hidden = true;
    messages = [];
    setError(null);
}

export function openAiChatTest(providerId: string, modelId: string, label: string): void {
    const dialog = el('ai-chat-test-dialog');
    const inputEl = el('ai-chat-test-input') as HTMLTextAreaElement | null;
    const meta = el('ai-chat-test-meta');
    if (!dialog || !inputEl) return;
    currentProviderId = providerId;
    currentModelId = modelId;
    messages = [];
    if (meta) meta.textContent = label;
    setError(null);
    renderMessages();
    dialog.hidden = false;
    inputEl.value = 'Hi';
    inputEl.focus();
    inputEl.select();
}

export function initAiChatTest(): void {
    el('ai-chat-test-send')?.addEventListener('click', () => void sendMessage());
    el('ai-chat-test-close')?.addEventListener('click', closeDialog);
    const dialog = el('ai-chat-test-dialog');
    if (!dialog) return;
    dialog.addEventListener('keydown', (event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key === 'Escape') {
            keyboardEvent.preventDefault();
            keyboardEvent.stopPropagation();
            closeDialog();
            return;
        }
        if (keyboardEvent.key === 'Enter' && !keyboardEvent.shiftKey) {
            keyboardEvent.preventDefault();
            void sendMessage();
        }
    });
}
