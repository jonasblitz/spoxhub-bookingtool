/**
 * Brands Service — Lädt Fahrradmarken aus Airtable
 */

const AIRTABLE_BASE = 'https://api.airtable.com/v0';
const TABLE_ID = 'tblw0sagVkBHFbn1M';

let cachedBrands = null;
let cacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 Minuten (Marken ändern sich selten)

async function loadBrands() {
  if (cachedBrands && Date.now() - cacheTime < CACHE_TTL) {
    return cachedBrands;
  }

  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    console.warn('Airtable not configured — using empty brands list');
    return [];
  }

  try {
    let allRecords = [];
    let offset = null;

    do {
      let url = `${AIRTABLE_BASE}/${baseId}/${TABLE_ID}?pageSize=100&filterByFormula=Fahrradhersteller%3DTRUE()`;
      if (offset) url += `&offset=${offset}`;

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!res.ok) throw new Error(`Airtable error (${res.status})`);

      const data = await res.json();
      allRecords = allRecords.concat(data.records || []);
      offset = data.offset;
    } while (offset);

    cachedBrands = allRecords.map(r => ({
      id: r.id,
      name: r.fields.Name || '',
      brandId: r.fields.BrandID,
      blacklist: !!r.fields.Blacklist,
      preferred: !!r.fields.Preferred
    })).sort((a, b) => {
      // Preferred first, then alphabetical
      if (a.preferred && !b.preferred) return -1;
      if (!a.preferred && b.preferred) return 1;
      return a.name.localeCompare(b.name, 'de');
    });

    cacheTime = Date.now();
    console.log(`Loaded ${cachedBrands.length} bike brands from Airtable`);
    return cachedBrands;
  } catch (err) {
    console.error('Brands load error:', err.message);
    return cachedBrands || [];
  }
}

module.exports = { loadBrands };
