export const $ = (id) => document.getElementById(id);

export function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

export function showToast(message, type = 'info', duration = 4200) {
  const toast = $('app-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `app-toast ${type}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), duration);
}

export function setButtonBusy(button, busy, label = 'Working...') {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

export function setStatus(element, message, type = 'info') {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error', type === 'error');
  element.classList.toggle('success', type === 'success');
}
