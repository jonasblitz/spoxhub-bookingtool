/**
 * Leasing Providers — lädt Liste und füllt das Dropdown auf dem Leasing-Screen.
 */

let leasingProviders = null;
let leasingLoadPromise = null;

async function loadLeasingProviders() {
  if (leasingProviders) return leasingProviders;
  if (leasingLoadPromise) return leasingLoadPromise;

  leasingLoadPromise = fetch(API_BASE + '/api/leasing')
    .then(r => r.json())
    .then(list => {
      leasingProviders = Array.isArray(list) ? list : [];
      return leasingProviders;
    })
    .catch(err => {
      console.error('Leasing load error:', err);
      leasingProviders = [];
      return leasingProviders;
    });

  return leasingLoadPromise;
}

function renderLeasingOptions() {
  const select = document.getElementById('b-leasing-company');
  if (!select || !leasingProviders) return;

  const currentValue = select.value || BookingState.get('bike.leasing') || '';

  // Build options, grouped: Supported first, then other
  const supported = leasingProviders.filter(p => p.supported);
  const other     = leasingProviders.filter(p => !p.supported);

  const mkOption = p => {
    const selected = p.name === currentValue ? 'selected' : '';
    const label = p.supported ? `${p.name}  ·  ✓` : p.name;
    return `<option value="${escapeHtmlAttr(p.name)}" ${selected}>${escapeHtmlAttr(label)}</option>`;
  };

  let html = '<option value="">Bitte wählen...</option>';
  if (supported.length > 0) {
    html += '<optgroup label="Unterstützte Anbieter">' + supported.map(mkOption).join('') + '</optgroup>';
  }
  if (other.length > 0) {
    html += '<optgroup label="Weitere Anbieter">' + other.map(mkOption).join('') + '</optgroup>';
  }
  html += '<option value="Sonstiges">Sonstiges / Nicht gelistet</option>';
  select.innerHTML = html;

  // Show status if something is pre-selected (e.g. restored from state)
  if (currentValue) checkLeasingStatus(currentValue);
}

function checkLeasingStatus(name) {
  const statusEl = document.getElementById('leasing-status');
  if (!statusEl) return;

  if (!name || name === 'Sonstiges') {
    statusEl.classList.add('hidden');
    statusEl.innerHTML = '';
    return;
  }

  const provider = (leasingProviders || []).find(p => p.name.toLowerCase() === name.toLowerCase());
  if (!provider) {
    statusEl.classList.add('hidden');
    return;
  }

  if (provider.supported) {
    statusEl.className = 'brand-status brand-status--preferred mt-2';
    statusEl.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      <span>Wir sind <strong>${escapeHtmlAttr(provider.name)}</strong>-Partner — direkte Abwicklung über den Anbieter.</span>`;
  } else {
    statusEl.className = 'brand-status brand-status--warning mt-2';
    statusEl.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span>Mit <strong>${escapeHtmlAttr(provider.name)}</strong> haben wir noch keine direkte Kooperation — du kannst aber trotzdem buchen. Die Abrechnung läuft ggf. über dich.</span>`;
  }
  statusEl.classList.remove('hidden');
}

function escapeHtmlAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Exposed for flow.js onEnter hook
async function onEnterBikeLeasing() {
  if (!leasingProviders) await loadLeasingProviders();
  renderLeasingOptions();
}

// Pre-load in background
document.addEventListener('DOMContentLoaded', () => {
  loadLeasingProviders();
});
