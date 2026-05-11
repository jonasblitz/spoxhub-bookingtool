/**
 * Brand Autocomplete — Suche + Blacklist/Preferred Markierung
 */

let allBrands = null;
let brandDropdownActive = false;

async function loadBrandsData() {
  if (allBrands) return allBrands;
  try {
    const res = await fetch(API_BASE + '/api/brands');
    allBrands = await res.json();
    return allBrands;
  } catch (err) {
    console.error('Brands load error:', err);
    return [];
  }
}

function onBrandInput(el) {
  const query = el.value.trim().toLowerCase();
  updateCustomerField(el);

  if (query.length < 1) {
    hideBrandDropdown();
    hideBrandStatus();
    return;
  }

  if (!allBrands) {
    loadBrandsData().then(() => onBrandInput(el));
    return;
  }

  const matches = allBrands.filter(b =>
    b.name.toLowerCase().includes(query)
  ).slice(0, 8);

  showBrandDropdown(matches, el);
}

function onBrandBlur(el) {
  // Delay to allow click on dropdown
  setTimeout(() => {
    hideBrandDropdown();
    validateField(el);
    checkBrandStatus(el.value.trim());
  }, 200);
}

function showBrandDropdown(matches, inputEl) {
  const dropdown = document.getElementById('brand-dropdown');
  if (!dropdown) return;

  if (matches.length === 0) {
    dropdown.innerHTML = '<div class="brand-item brand-item--empty">Keine Marke gefunden — du kannst den Namen manuell eingeben</div>';
    dropdown.classList.remove('hidden');
    return;
  }

  dropdown.innerHTML = matches.map(b => {
    let cls = 'brand-item';
    let badge = '';

    if (b.blacklist) {
      cls += ' brand-item--blacklist';
      badge = '<span class="brand-badge brand-badge--blacklist">Nicht unterstützt</span>';
    } else if (b.preferred) {
      cls += ' brand-item--preferred';
      badge = '<span class="brand-badge brand-badge--preferred">Spezialisiert</span>';
    }

    return `<div class="${cls}" onmousedown="selectBrand('${b.name.replace(/'/g, "\\'")}', ${b.blacklist}, ${b.preferred})">
      <span class="brand-item__name">${highlightMatch(b.name, inputEl.value)}</span>
      ${badge}
    </div>`;
  }).join('');

  dropdown.classList.remove('hidden');
}

function hideBrandDropdown() {
  document.getElementById('brand-dropdown')?.classList.add('hidden');
}

function selectBrand(name, isBlacklist, isPreferred) {
  const input = document.getElementById('b-marke');
  if (input) {
    input.value = name;
    BookingState.set('bike.marke', name);
  }
  hideBrandDropdown();
  checkBrandStatus(name);
}

function checkBrandStatus(name) {
  const statusEl = document.getElementById('brand-status');
  if (!statusEl || !allBrands || !name) {
    hideBrandStatus();
    return;
  }

  const brand = allBrands.find(b => b.name.toLowerCase() === name.toLowerCase());

  if (brand?.blacklist) {
    statusEl.className = 'brand-status brand-status--blacklist mt-2';
    statusEl.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      <span>Leider können wir <strong>${brand.name}</strong> aktuell nicht warten. Bitte kontaktiere uns für Alternativen.</span>`;
    statusEl.classList.remove('hidden');
  } else if (brand?.preferred) {
    statusEl.className = 'brand-status brand-status--preferred mt-2';
    statusEl.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      <span><strong>${brand.name}</strong> — darauf sind wir spezialisiert!</span>`;
    statusEl.classList.remove('hidden');
  } else {
    hideBrandStatus();
  }
}

function hideBrandStatus() {
  document.getElementById('brand-status')?.classList.add('hidden');
}

// Exposed: is the currently entered brand blacklisted?
function isBrandBlacklisted(name) {
  if (!allBrands || !name) return false;
  const brand = allBrands.find(b => b.name.toLowerCase() === name.toLowerCase());
  return !!brand?.blacklist;
}

function highlightMatch(text, query) {
  if (!query) return text;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.replace(regex, '<mark class="brand-highlight">$1</mark>');
}

// Pre-load brands when entering step 3
BookingState.subscribe((key, value) => {
  if (key === 'currentStep' && value === 3) {
    loadBrandsData();
  }
});
