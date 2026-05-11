/**
 * Classify bike brands as e-bike makers / cargo bike makers and update Airtable.
 * Sources: training knowledge for well-known brands; ?-flagged for uncertain/regional ones.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TBL = 'tblw0sagVkBHFbn1M';
const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE = process.env.AIRTABLE_BASE_ID;

// e-bikes / cargo classification.
// Format: { ebike: bool, cargo: bool }
// Brands left out are treated as { ebike: false, cargo: false }.
const KNOWN = {
  // -- Definite e-bike + cargo specialists
  "Babboe ":              { ebike: true,  cargo: true  },
  "Bakfiets":             { ebike: true,  cargo: true  },
  "Benno Bikes":          { ebike: true,  cargo: true  },
  "Bullitt":              { ebike: true,  cargo: true  },
  "Butchers & Bicycles":  { ebike: true,  cargo: true  },
  "Ca Go Bike":           { ebike: true,  cargo: true  },
  "Carqon":               { ebike: true,  cargo: true  },
  "Chike":                { ebike: true,  cargo: true  },
  "Christiania Bikes":    { ebike: true,  cargo: true  },
  "Douze Cycles":         { ebike: true,  cargo: true  },
  "FLYER":                { ebike: true,  cargo: true  },
  "Muli":                 { ebike: true,  cargo: true  },
  "My Esel":              { ebike: true,  cargo: true  },
  "QiO Bikes":            { ebike: true,  cargo: true  },
  "Riese und Müller":     { ebike: true,  cargo: true  },
  "Triobike":             { ebike: true,  cargo: true  },
  "Urban Arrow":          { ebike: true,  cargo: true  },
  "Valkental":            { ebike: true,  cargo: true  },
  "Velo Lab":             { ebike: true,  cargo: true  },
  "Velo de Ville":        { ebike: true,  cargo: true  },
  "Waldbike":             { ebike: true,  cargo: true  },
  "Winora":               { ebike: true,  cargo: true  },
  "Winther":              { ebike: true,  cargo: true  },
  "YOONIT":               { ebike: true,  cargo: true  },
  "Yuba":                 { ebike: true,  cargo: true  },
  "Zwei plus zwei":       { ebike: true,  cargo: true  },
  "cluuv":                { ebike: true,  cargo: true  },
  "my Boo":               { ebike: true,  cargo: true  },
  "Bergamont":            { ebike: true,  cargo: true  },
  "Specialized":          { ebike: true,  cargo: true  },
  "Surly":                { ebike: true,  cargo: true  },
  "Multicycle":           { ebike: true,  cargo: true  },

  // -- E-bike yes, cargo no
  "ADVANCED EBIKE":       { ebike: true,  cargo: false },
  "Amflow":               { ebike: true,  cargo: false },
  "BULLS":                { ebike: true,  cargo: false },
  "Bianchi":              { ebike: true,  cargo: false },
  "Bold Cycles":          { ebike: true,  cargo: false },
  "Breezer Bikes":        { ebike: true,  cargo: false },
  "Brompton":             { ebike: true,  cargo: false },
  "CARVER":               { ebike: true,  cargo: false },
  "Cannondale":           { ebike: true,  cargo: false },
  "Canyon":               { ebike: true,  cargo: false },
  "Cowboy Bike":          { ebike: true,  cargo: false },
  "EASY motion":          { ebike: true,  cargo: false },
  "EOVOLT":               { ebike: true,  cargo: false },
  "Electra Bicycle":      { ebike: true,  cargo: false },
  "FALTER":               { ebike: true,  cargo: false },
  "Falkenjagd":           { ebike: true,  cargo: false },
  "Fischer":              { ebike: true,  cargo: false },
  "MÜSING":               { ebike: true,  cargo: false },
  "Nicolai":              { ebike: true,  cargo: false },
  "Puch":                 { ebike: true,  cargo: false },
  "Pure Cycles":          { ebike: true,  cargo: false },
  "Rabeneick":            { ebike: true,  cargo: false },
  "Rock Machine":         { ebike: true,  cargo: false },
  "Rose Bikes":           { ebike: true,  cargo: false },
  "Rotwild":              { ebike: true,  cargo: false },
  "Ruff Cycles":          { ebike: true,  cargo: false },
  "SMAFO":                { ebike: true,  cargo: false },
  "Santa Cruz":           { ebike: true,  cargo: false },
  "Saxonette":            { ebike: true,  cargo: false },
  "Schindelhauer Bikes":  { ebike: true,  cargo: false },
  "Simplon":              { ebike: true,  cargo: false },
  "Staiger":              { ebike: true,  cargo: false },
  "Steppenwolf":          { ebike: true,  cargo: false },
  "Stevens":              { ebike: true,  cargo: false },
  "Trenga":               { ebike: true,  cargo: false },
  "Urwahn":               { ebike: true,  cargo: false },
  "Utopia":               { ebike: true,  cargo: false },
  "VELLO Bike":           { ebike: true,  cargo: false },
  "VSF Fahrradmanufaktur":{ ebike: true,  cargo: false },
  "Veloheld":             { ebike: true,  cargo: false },
  "bauer's e-bike":       { ebike: true,  cargo: false },
  "e-bike manufaktur":    { ebike: true,  cargo: false },
  "rad3":                 { ebike: true,  cargo: false },
  "tout terrain":         { ebike: true,  cargo: false },
  "Apache Bicycles":      { ebike: true,  cargo: false },
  "woom":                 { ebike: true,  cargo: false }, // woom UP series
  "Tyson Bikes":          { ebike: true,  cargo: false },

  // -- Neither (kids only / accessories / non-bike)
  "Academy":              { ebike: false, cargo: false },
  "Acid":                 { ebike: false, cargo: false },
  "Adams":                { ebike: false, cargo: false },
  "Alpina":               { ebike: false, cargo: false },
  "Bioracer":             { ebike: false, cargo: false },
  "Bolle":                { ebike: false, cargo: false },
  "Bombtrack":            { ebike: false, cargo: false },
  "Brose":                { ebike: false, cargo: false }, // motor maker
  "Böttcher Kids":        { ebike: false, cargo: false },
  "COBI.bike":            { ebike: false, cargo: false }, // platform/Bosch
  "Cinelli":              { ebike: false, cargo: false },
  "Croozer":              { ebike: false, cargo: false }, // child trailers
  "Eddy Merckx":          { ebike: false, cargo: false },
  "Elbe Twinny Load":     { ebike: false, cargo: false },
  "Firstbike":            { ebike: false, cargo: false },
  "Puky":                 { ebike: false, cargo: false },
  "Qeridoo":              { ebike: false, cargo: false }, // trailers
  "Rennstahl":            { ebike: false, cargo: false },
  "RixenKaul":            { ebike: false, cargo: false },
  "Rudy Project":         { ebike: false, cargo: false },
  "Sachs":                { ebike: false, cargo: false },
  "Schürmann":            { ebike: false, cargo: false },
  "Super B":              { ebike: false, cargo: false },
  "Trickstuff":           { ebike: false, cargo: false },
  "Turner Bikes":         { ebike: false, cargo: false },
  "Unicycle":             { ebike: false, cargo: false },
  "Van Nicholas":         { ebike: false, cargo: false },
  "Vittoria":             { ebike: false, cargo: false },
  "Avon Cycles":          { ebike: false, cargo: false }
};

// Brands I'm uncertain about — left for user to verify.
// These remain false/false but are listed in the report.
const UNCERTAIN = [
  "19twentyfiver", "AT Zweirad", "Alpina Bikes", "Arval", "Bauer Bikes",
  "BiGBOY Bikes", "Bike-Manufaktur", "Böttcher", "Checker Pig",
  "Circle Cycles", "Drehmoment-Bikes", "Eimsbütteler", "FAHRRADIES RAD",
  "Fahrradcity Manufaktur", "Fahrradhof Stadtrad", "Fahrwerk",
  "Fjord Manufaktur", "Sandmann-Rad", "Sandvoß-Bike", "Schwabenrad",
  "Super Duty", "Twicycle", "edelbike", "van der Falk"
];

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  const d = t ? JSON.parse(t) : {};
  if (!r.ok) throw new Error(`${method} → ${r.status}: ${d?.error?.message || t}`);
  return d;
}

(async () => {
  // 1. Fetch all bike makers
  let all = [], offset = null;
  do {
    const url = `https://api.airtable.com/v0/${BASE}/${TBL}?pageSize=100&filterByFormula=Fahrradhersteller%3DTRUE()` + (offset ? '&offset=' + offset : '');
    const d = await api('GET', url);
    all = all.concat(d.records);
    offset = d.offset;
  } while (offset);

  console.log(`Fetched ${all.length} bike makers.\n`);

  // 2. Build update payload — preserve existing HatCargobikes by mirroring into HasCargo
  const updates = [];
  let counts = { eYes: 0, cYes: 0, untouched: 0, uncertainFound: 0 };

  for (const r of all) {
    const name = r.fields.Name;
    const klass = KNOWN[name];
    const existingCargo = !!r.fields.HatCargobikes; // preserve from old column

    // Determine new values
    const ebike = klass ? klass.ebike : false;
    const cargo = klass ? klass.cargo : existingCargo; // fallback to legacy column

    // Skip if values unchanged
    const cur = { e: !!r.fields.HasEBikes, c: !!r.fields.HasCargo };
    if (cur.e === ebike && cur.c === cargo) {
      counts.untouched++;
      continue;
    }

    updates.push({
      id: r.id,
      fields: { HasEBikes: ebike, HasCargo: cargo }
    });
    if (ebike) counts.eYes++;
    if (cargo) counts.cYes++;
    if (UNCERTAIN.includes(name)) counts.uncertainFound++;
  }

  console.log(`Updates queued: ${updates.length}`);
  console.log(`  HasEBikes=true: ${counts.eYes}`);
  console.log(`  HasCargo=true:  ${counts.cYes}`);
  console.log(`  Untouched (already correct): ${counts.untouched}`);
  console.log();

  // 3. Push in batches of 10
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    await api('PATCH', `https://api.airtable.com/v0/${BASE}/${TBL}`, { records: batch });
    process.stdout.write(`  Batch ${Math.floor(i/10) + 1}/${Math.ceil(updates.length/10)} ✓\r`);
  }
  console.log('\nAll updates pushed. ✅\n');

  // 4. Report uncertain brands (left as false)
  console.log('--- Brands I could not confidently classify (currently HasEBikes=false, HasCargo=false) ---');
  console.log('Please verify these manually:');
  UNCERTAIN.forEach(n => console.log('  -', n));
})().catch(err => {
  console.error('\n❌', err.message, '\n');
  process.exit(1);
});
