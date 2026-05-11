/**
 * Setup für Tabelle "Termine/Locations" (tbl3IDm2tNEUipn4B).
 *
 * - Legt fehlende Felder an: BookingID (primary), Vorname, Name, Anschrift,
 *   Datum, Kalender, Lat, Lng, Geocoded, GeocodedAt.
 * - Löscht alle Felder, die nicht zu diesem Schema gehören (außer Primary).
 *   ⚠ Felder können nicht ungelöscht werden — alte Daten gehen verloren.
 *
 * Usage:
 *   node scripts/setup-locations-table.js          # Dry-run (zeigt nur was passieren würde)
 *   node scripts/setup-locations-table.js --apply  # Wendet die Änderungen an
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE  = process.env.AIRTABLE_BASE_ID;
const TABLE_ID = 'tbl3IDm2tNEUipn4B';
const APPLY = process.argv.includes('--apply');

if (!TOKEN || !BASE) {
  console.error('❌ Missing AIRTABLE_TOKEN or AIRTABLE_BASE_ID in .env');
  process.exit(1);
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  let d; try { d = t ? JSON.parse(t) : {}; } catch { d = { raw: t }; }
  if (!r.ok) throw new Error(`${method} → ${r.status}: ${d?.error?.message || d?.error?.type || t}`);
  return d;
}

const SCHEMA = [
  { name: 'BookingID', type: 'singleLineText', primary: true },
  { name: 'Vorname',   type: 'singleLineText' },
  { name: 'Name',      type: 'singleLineText' },
  { name: 'Anschrift', type: 'singleLineText' },
  { name: 'Datum',     type: 'dateTime', options: {
      timeZone: 'Europe/Berlin',
      dateFormat: { name: 'european' },
      timeFormat: { name: '24hour' }
  }},
  { name: 'Kalender',  type: 'singleLineText' },
  { name: 'Lat',       type: 'number', options: { precision: 6 } },
  { name: 'Lng',       type: 'number', options: { precision: 6 } },
  { name: 'Geocoded',  type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
  { name: 'GeocodedAt', type: 'dateTime', options: {
      timeZone: 'Europe/Berlin',
      dateFormat: { name: 'iso' },
      timeFormat: { name: '24hour' }
  }}
];

(async () => {
  console.log(`→ Lade Schema von ${TABLE_ID}…`);
  const meta = await api('GET', `https://api.airtable.com/v0/meta/bases/${BASE}/tables`);
  const table = meta.tables.find(t => t.id === TABLE_ID);
  if (!table) {
    console.error(`❌ Tabelle ${TABLE_ID} nicht in Base ${BASE} gefunden.`);
    process.exit(1);
  }

  console.log(`✓ Tabelle: "${table.name}" (${table.id})`);
  console.log(`  Aktuelle Felder: ${table.fields.map(f => f.name).join(', ') || '(keine)'}`);

  const targetNames = new Set(SCHEMA.map(s => s.name));
  const existing    = new Map(table.fields.map(f => [f.name, f]));
  const primaryId   = table.primaryFieldId;

  // ─── 1) Primary-Field umbenennen auf BookingID (kann nicht gelöscht werden) ──
  // Airtable API: PATCH erlaubt nur { name, description } — keine Type-Änderung.
  const primaryField = table.fields.find(f => f.id === primaryId);
  if (primaryField && primaryField.name !== 'BookingID') {
    console.log(`\n→ Primary-Feld umbenennen: "${primaryField.name}" → "BookingID"`);
    if (APPLY) {
      try {
        await api('PATCH',
          `https://api.airtable.com/v0/meta/bases/${BASE}/tables/${table.id}/fields/${primaryField.id}`,
          { name: 'BookingID' }
        );
        console.log(`  ✓ umbenannt`);
        existing.delete(primaryField.name);
        existing.set('BookingID', { ...primaryField, name: 'BookingID' });
      } catch (e) {
        console.warn(`  ⚠ Konnte Primary nicht umbenennen: ${e.message}`);
      }
    } else {
      existing.delete(primaryField.name);
      existing.set('BookingID', { ...primaryField, name: 'BookingID' });
    }
  }

  // ─── 2) Fehlende Felder anlegen ─────────────────────────────────────────────
  const toAdd = SCHEMA.filter(f => !f.primary && !existing.has(f.name));
  if (toAdd.length) {
    console.log(`\n→ ${toAdd.length} Feld(er) hinzufügen:`);
    for (const f of toAdd) {
      console.log(`  + ${f.name} (${f.type})`);
      if (APPLY) {
        const { primary, ...payload } = f;
        try {
          await api('POST',
            `https://api.airtable.com/v0/meta/bases/${BASE}/tables/${table.id}/fields`,
            payload
          );
        } catch (e) {
          console.warn(`    ⚠ ${e.message}`);
        }
      }
    }
  } else {
    console.log(`\n✓ Alle Soll-Felder vorhanden.`);
  }

  // ─── 3) Alte Felder kennzeichnen (Airtable API kann Felder NICHT löschen) ───
  // Workaround: umbenennen mit "_DEPRECATED_" Präfix, damit du sie in der UI
  // erkennst und manuell löschen kannst.
  const toDelete = table.fields.filter(f =>
    f.id !== primaryId && !targetNames.has(f.name) && !f.name.startsWith('_DEPRECATED_')
  );
  if (toDelete.length) {
    console.log(`\n→ ${toDelete.length} alte Feld(er) (manuell in Airtable löschen):`);
    for (const f of toDelete) {
      const newName = `_DEPRECATED_${f.name}`;
      console.log(`  • ${f.name} → "${newName}" (rename)`);
      if (APPLY) {
        try {
          await api('PATCH',
            `https://api.airtable.com/v0/meta/bases/${BASE}/tables/${table.id}/fields/${f.id}`,
            { name: newName }
          );
        } catch (e) {
          console.warn(`    ⚠ Umbenennen fehlgeschlagen: ${e.message}`);
        }
      }
    }
    console.log(`\n  ⚠ Airtable's Public API kann Felder nicht löschen.`);
    console.log(`     Bitte die "_DEPRECATED_*" Felder manuell in Airtable entfernen.`);
  } else {
    console.log(`\n✓ Keine alten Felder zum Aufräumen.`);
  }

  if (!APPLY) {
    console.log(`\n────────────────────────────────────────────────`);
    console.log(`Dry-Run beendet. Mit --apply ausführen, um die Änderungen anzuwenden.`);
  } else {
    console.log(`\n✓ Schema aktualisiert.`);
  }
})().catch(err => { console.error('❌', err.message); process.exit(1); });
