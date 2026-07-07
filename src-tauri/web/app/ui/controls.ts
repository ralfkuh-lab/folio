export function makeToggle(
    id: string,
    checked: boolean,
    labelText: string,
    onChange: (checked: boolean) => void,
): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'settings-ai-switch';
    label.title = labelText;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = id;
    checkbox.checked = checked;
    checkbox.setAttribute('aria-label', labelText);
    checkbox.addEventListener('change', () => onChange(checkbox.checked));
    const track = document.createElement('span');
    track.className = 'settings-ai-switch__track';
    const thumb = document.createElement('span');
    thumb.className = 'settings-ai-switch__thumb';
    track.appendChild(thumb);
    label.append(checkbox, track);
    return label;
}
