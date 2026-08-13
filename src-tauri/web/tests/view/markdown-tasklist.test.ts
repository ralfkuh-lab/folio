import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock } from '../helpers';
import { initMarkdownView, prepareMarkdownView, getTaskItemLabel } from '../../app/view/markdown';

function renderTasklistShell(html: string, versionId: number = 1): HTMLElement {
    document.body.className = 'kind-markdown';
    document.body.innerHTML = `
        <main id="view-content">
            ${html}
        </main>
        <aside id="toc-region"><ul class="toc"></ul></aside>
    `;
    const viewContent = document.getElementById('view-content') as HTMLElement;
    prepareMarkdownView(viewContent);
    return viewContent;
}

describe('view/markdown tasklist checkbox click integration', () => {
    let mockFolioEditor: {
        getText: ReturnType<typeof vi.fn>;
        getVersionId: ReturnType<typeof vi.fn>;
        applyReplace: ReturnType<typeof vi.fn>;
        getSelection: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        installTauriMock();

        mockFolioEditor = {
            getText: vi.fn(),
            getVersionId: vi.fn().mockReturnValue(1),
            applyReplace: vi.fn(),
            getSelection: vi.fn().mockReturnValue({ start: 10, length: 0 }),
        };
        (window as any).FolioEditor = mockFolioEditor;
    });

    it('activates checkboxes and sets aria-label via prepareMarkdownView', () => {
        renderTasklistShell(`
            <ul class="contains-task-list" data-sourcepos="1:1-2:15" data-line="1">
                <li class="task-list-item" data-sourcepos="1:1-1:15" data-line="1"><input id="cb1" disabled="disabled" type="checkbox" /> Buy milk</li>
                <li class="task-list-item" data-sourcepos="2:1-2:15" data-line="2"><input id="cb2" disabled="disabled" type="checkbox" checked="checked" /> Read <code>book</code></li>
            </ul>
        `, 1);

        const cb1 = document.getElementById('cb1') as HTMLInputElement;
        const cb2 = document.getElementById('cb2') as HTMLInputElement;

        expect(cb1.hasAttribute('disabled')).toBe(false);
        expect(cb1.getAttribute('aria-label')).toBe('Buy milk');

        expect(cb2.hasAttribute('disabled')).toBe(false);
        expect(cb2.getAttribute('aria-label')).toBe('Read book');
    });

    it('toggles unchecked checkbox on click and calls applyReplace with noReveal: true', () => {
        renderTasklistShell(`
            <ul class="contains-task-list" data-sourcepos="1:1-2:15" data-line="1">
                <li class="task-list-item" data-sourcepos="1:1-1:15" data-line="1"><input id="cb1" disabled="disabled" type="checkbox" /> Task 1</li>
                <li class="task-list-item" data-sourcepos="2:1-2:15" data-line="2"><input id="cb2" disabled="disabled" type="checkbox" checked="checked" /> Task 2</li>
            </ul>
        `, 1);
        initMarkdownView();

        mockFolioEditor.getText.mockReturnValue('- [ ] Task 1\n- [x] Task 2');
        mockFolioEditor.getVersionId.mockReturnValue(1);

        const cb1 = document.getElementById('cb1') as HTMLInputElement;
        cb1.click();

        expect(mockFolioEditor.applyReplace).toHaveBeenCalledTimes(1);
        expect(mockFolioEditor.applyReplace).toHaveBeenCalledWith({
            fullText: '- [x] Task 1\n- [x] Task 2',
            selectionStart: 10,
            selectionLength: 0,
            noReveal: true,
        });
    });

    it('toggles checked checkbox on click to unchecked', () => {
        renderTasklistShell(`
            <ul class="contains-task-list" data-sourcepos="1:1-1:11" data-line="1">
                <li class="task-list-item" data-sourcepos="1:1-1:11" data-line="1"><input id="cb1" disabled="disabled" type="checkbox" checked="checked" /> Done</li>
            </ul>
        `, 1);
        initMarkdownView();

        mockFolioEditor.getText.mockReturnValue('- [x] Done');
        mockFolioEditor.getVersionId.mockReturnValue(1);

        const cb1 = document.getElementById('cb1') as HTMLInputElement;
        cb1.click();

        expect(mockFolioEditor.applyReplace).toHaveBeenCalledTimes(1);
        expect(mockFolioEditor.applyReplace).toHaveBeenCalledWith({
            fullText: '- [ ] Done',
            selectionStart: 10,
            selectionLength: 0,
            noReveal: true,
        });
    });

    it('Fix 1: line shift / stale buffer (versionId mismatch) aborts without applyReplace and reverts checkbox', () => {
        // Preview was rendered at version 1 with "- [ ] Alpha" on line 1
        renderTasklistShell(`
            <ul class="contains-task-list" data-sourcepos="1:1-1:12" data-line="1">
                <li class="task-list-item" data-sourcepos="1:1-1:12" data-line="1"><input id="cb1" disabled="disabled" type="checkbox" /> Alpha</li>
            </ul>
        `, 1);
        initMarkdownView();

        // In the editor, user inserted "- [ ] New" above -> versionId bumped to 2
        // Line 1 is now "- [ ] New" (also unchecked!).
        mockFolioEditor.getText.mockReturnValue('- [ ] New\n- [ ] Alpha');
        mockFolioEditor.getVersionId.mockReturnValue(2);

        const cb1 = document.getElementById('cb1') as HTMLInputElement;
        expect(cb1.checked).toBe(false);
        cb1.click();

        // Stale-Guard must abort because version 2 !== 1
        expect(mockFolioEditor.applyReplace).not.toHaveBeenCalled();
        expect(cb1.checked).toBe(false);
    });

    it('Fix 2 & Nested lists: clicking child item in real renderer HTML targets child line, not parent', () => {
        // Real comrak renderer output for nested task list
        renderTasklistShell(`
            <ul class="contains-task-list" data-sourcepos="1:1-3:19" data-line="1">
                <li class="task-list-item" data-sourcepos="1:1-1:20" data-line="1"><input id="cbParent1" disabled="disabled" type="checkbox" /> Unchecked parent</li>
                <li class="task-list-item" data-sourcepos="2:1-3:19" data-line="2"><input id="cbParent2" disabled="disabled" type="checkbox" checked="checked" /> Checked parent
                    <ul class="contains-task-list" data-sourcepos="3:3-3:19" data-line="3">
                        <li class="task-list-item" data-sourcepos="3:3-3:19" data-line="3"><input id="cbChild" disabled="disabled" type="checkbox" /> Nested item</li>
                    </ul>
                </li>
            </ul>
        `, 1);
        initMarkdownView();

        const doc = '- [ ] Unchecked parent\n- [x] Checked parent\n  - [ ] Nested item';
        mockFolioEditor.getText.mockReturnValue(doc);
        mockFolioEditor.getVersionId.mockReturnValue(1);

        // Click child checkbox (line 3)
        const cbChild = document.getElementById('cbChild') as HTMLInputElement;
        cbChild.click();

        expect(mockFolioEditor.applyReplace).toHaveBeenCalledTimes(1);
        expect(mockFolioEditor.applyReplace).toHaveBeenCalledWith({
            fullText: '- [ ] Unchecked parent\n- [x] Checked parent\n  - [x] Nested item',
            selectionStart: 10,
            selectionLength: 0,
            noReveal: true,
        });

        // aria-label for parent excludes child sublist text
        const cbParent2 = document.getElementById('cbParent2') as HTMLInputElement;
        expect(cbParent2.getAttribute('aria-label')).toBe('Checked parent');
        expect(cbChild.getAttribute('aria-label')).toBe('Nested item');
    });

    it('Fix 4: li without data-line inside ul with data-line aborts and reverts instead of toggling ul line', () => {
        renderTasklistShell(`
            <ul class="contains-task-list" data-sourcepos="1:1-2:15" data-line="1">
                <li class="task-list-item"><input id="cbNoLine" disabled="disabled" type="checkbox" /> Missing data-line</li>
            </ul>
        `, 1);
        initMarkdownView();

        mockFolioEditor.getText.mockReturnValue('- [ ] Item 1\n- [ ] Item 2');
        mockFolioEditor.getVersionId.mockReturnValue(1);

        const cbNoLine = document.getElementById('cbNoLine') as HTMLInputElement;
        expect(cbNoLine.checked).toBe(false);
        cbNoLine.click();

        expect(mockFolioEditor.applyReplace).not.toHaveBeenCalled();
        expect(cbNoLine.checked).toBe(false);
    });

    it('Fix 3: supports ordered task lists and blockquote tasks', () => {
        renderTasklistShell(`
            <ol class="contains-task-list" data-sourcepos="1:1-1:19" data-line="1">
                <li class="task-list-item" data-sourcepos="1:1-1:19" data-line="1"><input id="cbOrdered" disabled="disabled" type="checkbox" /> Ordered task</li>
            </ol>
            <blockquote data-sourcepos="2:1-2:19" data-line="2">
                <ul class="contains-task-list" data-sourcepos="2:3-2:19" data-line="2">
                    <li class="task-list-item" data-sourcepos="2:3-2:19" data-line="2"><input id="cbQuoted" disabled="disabled" type="checkbox" /> Quoted task</li>
                </ul>
            </blockquote>
        `, 1);
        initMarkdownView();

        mockFolioEditor.getText.mockReturnValue('1. [ ] Ordered task\n> - [ ] Quoted task');
        mockFolioEditor.getVersionId.mockReturnValue(1);

        const cbOrdered = document.getElementById('cbOrdered') as HTMLInputElement;
        cbOrdered.click();

        expect(mockFolioEditor.applyReplace).toHaveBeenCalledWith({
            fullText: '1. [x] Ordered task\n> - [ ] Quoted task',
            selectionStart: 10,
            selectionLength: 0,
            noReveal: true,
        });

        const cbQuoted = document.getElementById('cbQuoted') as HTMLInputElement;
        cbQuoted.click();

        expect(mockFolioEditor.applyReplace).toHaveBeenCalledWith({
            fullText: '1. [ ] Ordered task\n> - [x] Quoted task',
            selectionStart: 10,
            selectionLength: 0,
            noReveal: true,
        });
    });

    it('Fix 5a: early returns consistently revert checkbox state', () => {
        renderTasklistShell(`
            <ul class="contains-task-list" data-sourcepos="1:1-1:15" data-line="1">
                <li class="task-list-item" data-sourcepos="1:1-1:15" data-line="1"><input id="cb1" disabled="disabled" type="checkbox" /> Task 1</li>
            </ul>
        `, 1);
        initMarkdownView();

        const cb1 = document.getElementById('cb1') as HTMLInputElement;

        // 1. Not kind-markdown
        document.body.className = 'kind-text';
        cb1.click();
        expect(cb1.checked).toBe(false);
        expect(mockFolioEditor.applyReplace).not.toHaveBeenCalled();
        document.body.className = 'kind-markdown';

        // 2. FolioEditor not available
        (window as any).FolioEditor = null;
        cb1.click();
        expect(cb1.checked).toBe(false);
        expect(mockFolioEditor.applyReplace).not.toHaveBeenCalled();
        (window as any).FolioEditor = mockFolioEditor;

        // 3. getVersionId returns null
        mockFolioEditor.getVersionId.mockReturnValue(null);
        cb1.click();
        expect(cb1.checked).toBe(false);
        expect(mockFolioEditor.applyReplace).not.toHaveBeenCalled();
        mockFolioEditor.getVersionId.mockReturnValue(1);

        // 4. Invalid data-line on li
        const li = cb1.closest('li') as HTMLElement;
        li.setAttribute('data-line', 'invalid');
        cb1.click();
        expect(cb1.checked).toBe(false);
        expect(mockFolioEditor.applyReplace).not.toHaveBeenCalled();
    });

    it('Frontmatter-offset: data-line correctly targets task line after yaml frontmatter block', () => {
        // Document with frontmatter (lines 1-3), empty line (4), heading (5), empty line (6), task (7)
        const doc = '---\ntitle: Pipeline\n---\n\n# Heading\n\n- [ ] Task after frontmatter';
        renderTasklistShell(`
            <aside class="frontmatter"><dl><dt>title</dt><dd>Pipeline</dd></dl></aside>
            <h1 id="heading" data-sourcepos="5:1-5:9" data-line="5">Heading</h1>
            <ul class="contains-task-list" data-sourcepos="7:1-7:30" data-line="7">
                <li class="task-list-item" data-sourcepos="7:1-7:30" data-line="7"><input id="cbFm" disabled="disabled" type="checkbox" /> Task after frontmatter</li>
            </ul>
        `, 1);
        initMarkdownView();

        mockFolioEditor.getText.mockReturnValue(doc);
        mockFolioEditor.getVersionId.mockReturnValue(1);

        const cbFm = document.getElementById('cbFm') as HTMLInputElement;
        cbFm.click();

        expect(mockFolioEditor.applyReplace).toHaveBeenCalledTimes(1);
        expect(mockFolioEditor.applyReplace).toHaveBeenCalledWith({
            fullText: '---\ntitle: Pipeline\n---\n\n# Heading\n\n- [x] Task after frontmatter',
            selectionStart: 10,
            selectionLength: 0,
            noReveal: true,
        });
    });

    it('only toggles when checkbox itself is clicked, not item text', () => {
        renderTasklistShell(`
            <ul class="contains-task-list" data-line="1">
                <li id="li1" class="task-list-item" data-line="1">
                    <input id="cb1" disabled="disabled" type="checkbox" />
                    <span id="text1">Task description text</span>
                </li>
            </ul>
        `, 1);
        initMarkdownView();

        mockFolioEditor.getText.mockReturnValue('- [ ] Task description text');
        mockFolioEditor.getVersionId.mockReturnValue(1);

        const text1 = document.getElementById('text1') as HTMLElement;
        text1.click();

        expect(mockFolioEditor.applyReplace).not.toHaveBeenCalled();
    });
});
