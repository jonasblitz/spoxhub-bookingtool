/**
 * Catalog Service — Lädt Leistungen aus Airtable
 * Fallback auf data/catalog.json wenn keine API-Keys konfiguriert
 */

const AIRTABLE_BASE = 'https://api.airtable.com/v0';
const TABLE_ID = 'tblxfZMerv61U0hjb';

let cachedCatalog = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 Minuten

/**
 * Lade Katalog aus Airtable und transformiere ins interne Format
 */
async function loadCatalog() {
  // Cache prüfen
  if (cachedCatalog && Date.now() - cacheTime < CACHE_TTL) {
    return cachedCatalog;
  }

  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    console.warn('Airtable not configured — using static catalog');
    return require('../data/catalog.json');
  }

  try {
    const records = await fetchAllRecords(baseId, token);
    cachedCatalog = transformToCatalog(records);
    cacheTime = Date.now();
    return cachedCatalog;
  } catch (err) {
    console.error('Airtable fetch error:', err.message);
    // Fallback
    return require('../data/catalog.json');
  }
}

/**
 * Alle Records aus Airtable laden (mit Pagination)
 */
async function fetchAllRecords(baseId, token) {
  let allRecords = [];
  let offset = null;

  do {
    let url = `${AIRTABLE_BASE}/${baseId}/${TABLE_ID}?pageSize=100`;
    if (offset) url += `&offset=${offset}`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      throw new Error(`Airtable API error (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return allRecords;
}

/**
 * Airtable Records ins interne Katalog-Format transformieren
 * Gruppiert nach Kategorie, mit Fahrzeugtyp-Filterung
 */
function transformToCatalog(records) {
  const bereicheMap = {};

  for (const record of records) {
    const f = record.fields;
    const kategorie = f.Kategorie || 'Sonstiges';
    const leistung = f.Leistung;
    if (!leistung) continue;

    if (!bereicheMap[kategorie]) {
      bereicheMap[kategorie] = {
        id: slugify(kategorie),
        name: kategorie,
        sortOrder: Number.isFinite(f.KategorieSortOrder) ? f.KategorieSortOrder : 999,
        leistungen: []
      };
    } else if (Number.isFinite(f.KategorieSortOrder)) {
      // Use the lowest value across rows of the same Kategorie
      bereicheMap[kategorie].sortOrder = Math.min(
        bereicheMap[kategorie].sortOrder,
        f.KategorieSortOrder
      );
    }

    const fahrradTypen = f.Fahrradtyp || ['Ebike', 'Cargobike'];
    const typenLower = fahrradTypen.map(t => t.toLowerCase());

    bereicheMap[kategorie].leistungen.push({
      id: record.id,
      name: leistung,
      sortOrder: Number.isFinite(f.LeistungSortOrder) ? f.LeistungSortOrder : 999,
      description: f.Beschreibung || '',
      basePrice: f.Preis || 0,
      baseDuration: f.Dauer || 30,
      // Marginal cost/time per additional unit (>= 2). null = scale linearly with basePrice/baseDuration.
      addPrice:    Number.isFinite(f.PreisZusatz) ? f.PreisZusatz : null,
      addDuration: Number.isFinite(f.DauerZusatz) ? f.DauerZusatz : null,
      materialkosten: f.Materialkosten || null,
      eterminId: f.EterminID || null,
      radblitzId: f.RadblitzID || null,
      vehicleTypes: typenLower,
      materialsIncluded: !f.Materialkosten,
      maxQuantity: Number.isFinite(f.MaximaleZahl) && f.MaximaleZahl > 0 ? f.MaximaleZahl : 1,
      inInspektionEnthalten: !!f.InInspektionEnthalten
    });
  }

  // Inspektion nach vorn sortieren
  const bereiche = Object.values(bereicheMap).sort((a, b) => {
    if (a.id === 'inspektion') return -1;
    if (b.id === 'inspektion') return 1;
    return a.sortOrder - b.sortOrder;
  });

  // Leistungen innerhalb der Kategorie nach LeistungSortOrder sortieren
  bereiche.forEach(b => {
    b.leistungen.sort((a, c) => (a.sortOrder ?? 999) - (c.sortOrder ?? 999));
  });

  return { version: 'airtable', bereiche };
}

/**
 * Katalog gefiltert nach Fahrzeugtyp zurückgeben
 */
async function getCatalogForVehicle(vehicleType) {
  const catalog = await loadCatalog();
  const vt = vehicleType.toLowerCase();

  return {
    ...catalog,
    bereiche: catalog.bereiche.map(bereich => ({
      ...bereich,
      leistungen: bereich.leistungen
        .filter(l => l.vehicleTypes.includes(vt))
        .map(l => ({
          id: l.id,
          name: l.name,
          description: l.description,
          priceWork: l.basePrice,
          priceMaterial: l.materialkosten || 0,
          price: l.basePrice + (l.materialkosten || 0),
          duration: Math.round(l.baseDuration),
          // Marginal pricing (used when qty > 1). null = fall back to base × qty.
          addPrice:    l.addPrice,
          addDuration: l.addDuration != null ? Math.round(l.addDuration) : null,
          materialkosten: l.materialkosten,
          materialsIncluded: l.materialsIncluded,
          eterminId: l.eterminId,
          bereich: bereich.name,
          maxQuantity: l.maxQuantity || 1,
          inInspektionEnthalten: !!l.inInspektionEnthalten
        }))
    })).filter(b => b.leistungen.length > 0)
  };
}

function slugify(str) {
  return str.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Cache invalidieren (z.B. nach Webhook von Airtable)
 */
function invalidateCache() {
  cachedCatalog = null;
  cacheTime = 0;
}

module.exports = { loadCatalog, getCatalogForVehicle, invalidateCache };
