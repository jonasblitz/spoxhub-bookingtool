/**
 * Leasing Providers Service — Lädt Leasinggesellschaften aus Airtable
 */

const AIRTABLE_BASE = 'https://api.airtable.com/v0';
const TABLE_ID = 'tbleZbkp4RfU8cFw5';

let cached = null;
let cacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 min

async function loadLeasingProviders() {
  if (cached && Date.now() - cacheTime < CACHE_TTL) {
    return cached;
  }

  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    console.warn('Airtable not configured — using empty leasing list');
    return [];
  }

  try {
    let allRecords = [];
    let offset = null;

    do {
      let url = `${AIRTABLE_BASE}/${baseId}/${TABLE_ID}?pageSize=100`;
      if (offset) url += `&offset=${encodeURIComponent(offset)}`;

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!res.ok) throw new Error(`Airtable error (${res.status})`);

      const data = await res.json();
      allRecords = allRecords.concat(data.records || []);
      offset = data.offset;
    } while (offset);

    cached = allRecords
      .map(r => ({
        id: r.id,
        name: r.fields.Name || '',
        rechnungsanschrift: r.fields.Rechnungsanschrift || '',
        portal: r.fields.Portal || '',
        supported: !!r.fields.Supported
      }))
      .filter(l => l.name)
      .sort((a, b) => {
        // Supported first, then alphabetical
        if (a.supported && !b.supported) return -1;
        if (!a.supported && b.supported) return 1;
        return a.name.localeCompare(b.name, 'de');
      });

    cacheTime = Date.now();
    console.log(`Loaded ${cached.length} leasing providers from Airtable`);
    return cached;
  } catch (err) {
    console.error('Leasing load error:', err.message);
    return cached || [];
  }
}

module.exports = { loadLeasingProviders };
