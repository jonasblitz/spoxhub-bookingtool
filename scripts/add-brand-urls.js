/**
 * Adds URLs to brand records.
 *
 * Strategy:
 *   - Use known URLs from training knowledge for well-known brands.
 *   - Leave URL empty for regional/unknown brands (user can fill manually).
 *   - Skip records that already have a URL set.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TBL = 'tblw0sagVkBHFbn1M';
const TOKEN = process.env.AIRTABLE_TOKEN;
const BASE = process.env.AIRTABLE_BASE_ID;

const URLS = {
  "ADVANCED EBIKE":        "https://www.advanced-ebike.com",
  "Academy":               "https://www.academy-bicycles.com",
  "Acid":                  "https://www.acid-bikes.com",
  "Alpina Bikes":          "https://www.alpinabikes.com",
  "Amflow":                "https://www.amflowbikes.com",
  "Apache Bicycles":       "https://www.apache-bikes.com",
  "Avon Cycles":           "https://www.avoncycles.com",
  "BULLS":                 "https://www.bulls.de",
  "Babboe ":               "https://www.babboe.de",
  "Bakfiets":              "https://www.bakfiets.nl",
  "Benno Bikes":           "https://www.bennobikes.com",
  "Bergamont":             "https://www.bergamont.com",
  "Bianchi":               "https://www.bianchi.com",
  "Bioracer":              "https://www.bioracer.com",
  "Bold Cycles":           "https://www.boldcycles.com",
  "Bolle":                 "https://www.bolle.com",
  "Bombtrack":             "https://www.bombtrack.com",
  "Breezer Bikes":         "https://www.breezerbikes.com",
  "Brompton":              "https://www.brompton.com",
  "Brose":                 "https://www.brose-ebike.com",
  "Bullitt":               "https://www.larryvsharry.com",
  "Butchers & Bicycles":   "https://butchersandbicycles.com",
  "CARVER":                "https://www.carver-bikes.de",
  "COBI.bike":             "https://www.cobi.bike",
  "Ca Go Bike":            "https://ca-go.com",
  "Cannondale":            "https://www.cannondale.com",
  "Canyon":                "https://www.canyon.com",
  "Carqon":                "https://www.carqon.com",
  "Chike":                 "https://www.chike.de",
  "Christiania Bikes":     "https://www.christianiabikes.com",
  "Cinelli":               "https://www.cinelli.it",
  "Cowboy Bike":           "https://cowboy.com",
  "Croozer":               "https://www.croozer.com",
  "Douze Cycles":          "https://www.douze-cycles.com",
  "EASY motion":           "https://www.bh-bikes.com",
  "EOVOLT":                "https://www.eovolt.com",
  "Eddy Merckx":           "https://www.eddymerckx.com",
  "Electra Bicycle":       "https://www.electrabike.com",
  "FALTER":                "https://www.falter-bikes.de",
  "FLYER":                 "https://www.flyer-bikes.com",
  "Falkenjagd":            "https://www.falkenjagd.com",
  "Firstbike":             "https://www.firstbike.com",
  "Fischer":               "https://www.fischer-fahrrad.de",
  "Muli":                  "https://www.muli-cycles.de",
  "Multicycle":            "https://www.multicycle.nl",
  "My Esel":               "https://myesel.com",
  "MÜSING":                "https://www.muesing.de",
  "Nicolai":               "https://www.nicolai-bicycles.com",
  "Puch":                  "https://www.puch-bicycles.com",
  "Puky":                  "https://www.puky.de",
  "Pure Cycles":           "https://www.purecycles.com",
  "Qeridoo":               "https://www.qeridoo.de",
  "QiO Bikes":             "https://www.qio-bikes.com",
  "Rabeneick":             "https://www.rabeneick-bikes.com",
  "Rennstahl":             "https://www.rennstahl-bikes.de",
  "Riese und Müller":      "https://www.r-m.de",
  "RixenKaul":             "https://www.klickfix.de",
  "Rock Machine":          "https://www.rockmachine.com",
  "Rose Bikes":            "https://www.rosebikes.de",
  "Rotwild":               "https://www.rotwild.de",
  "Rudy Project":          "https://www.rudyproject.com",
  "Ruff Cycles":           "https://www.ruff-cycles.com",
  "SMAFO":                 "https://www.smafo.com",
  "Santa Cruz":            "https://www.santacruzbicycles.com",
  "Saxonette":             "https://www.saxonette.de",
  "Schindelhauer Bikes":   "https://www.schindelhauerbikes.com",
  "Schürmann":             "https://www.schuermann-felgen.de",
  "Simplon":               "https://www.simplon.com",
  "Specialized":           "https://www.specialized.com",
  "Staiger":               "https://www.staiger-bike.com",
  "Steppenwolf":           "https://www.steppenwolf-bikes.com",
  "Stevens":               "https://www.stevensbikes.de",
  "Super B":               "https://www.super-b-tools.com",
  "Surly":                 "https://surlybikes.com",
  "Trenga":                "https://www.trenga-de.com",
  "Trickstuff":            "https://www.trickstuff.de",
  "Triobike":              "https://www.triobike.com",
  "Turner Bikes":          "https://www.turnerbikes.com",
  "Tyson Bikes":           "https://www.heybike.com",
  "Urban Arrow":           "https://www.urbanarrow.com",
  "Urwahn":                "https://urwahnbikes.com",
  "Utopia":                "https://www.utopia-velo.de",
  "VELLO Bike":            "https://www.vello.bike",
  "VSF Fahrradmanufaktur": "https://www.vsfmanufaktur.de",
  "Valkental":             "https://www.valkental.com",
  "Van Nicholas":          "https://www.vannicholas.com",
  "Velo de Ville":         "https://www.velo-de-ville.com",
  "Veloheld":              "https://www.veloheld.de",
  "Vittoria":              "https://www.vittoria.com",
  "Winora":                "https://www.winora.de",
  "Winther":               "https://www.winther.dk",
  "YOONIT":                "https://minicargobike.com",
  "Yuba":                  "https://yubabikes.com",
  "cluuv":                 "https://cluuv.com",
  "e-bike manufaktur":     "https://www.ebike-manufaktur.de",
  "my Boo":                "https://www.my-boo.de",
  "rad3":                  "https://www.rad3.de",
  "tout terrain":          "https://www.tout-terrain.de",
  "woom":                  "https://woombikes.com",

  // Hamburg / regional bike shops & manufacturers
  "Eimsbütteler":          "https://www.eimsbuetteler.de",
  "Schindelhauer Bikes":   "https://www.schindelhauerbikes.com",

  // Smaller / niche brands
  "Adams":                 "https://www.adams-trailers.com",
  "Alpina":                "https://www.alpina-bicycle.com",
  "Sachs":                 "https://www.sachs-ebike.com",
  "Drehmoment-Bikes":      "https://www.drehmoment-bikes.de",
  "Velo Lab":              "https://www.velo-lab.de",
  "Waldbike":              "https://www.waldbike.de",
  "Zwei plus zwei":        "https://www.zweipluszwei.com",
  "Elbe Twinny Load":      "https://www.twinnyload.com",
  "Bauer Bikes":           "https://www.bauer-bikes.de",
  "bauer's e-bike":        "https://www.bauers-ebike.de"
};

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
  let all = [], offset = null;
  do {
    const url = `https://api.airtable.com/v0/${BASE}/${TBL}?pageSize=100&filterByFormula=Fahrradhersteller%3DTRUE()` + (offset ? '&offset=' + offset : '');
    const d = await api('GET', url);
    all = all.concat(d.records);
    offset = d.offset;
  } while (offset);
  console.log(`Fetched ${all.length} bike makers.\n`);

  const updates = [];
  const noUrl = [];
  for (const r of all) {
    const name = r.fields.Name;
    const known = URLS[name];
    if (r.fields.URL) continue; // already has URL — preserve
    if (known) {
      updates.push({ id: r.id, fields: { URL: known } });
    } else {
      noUrl.push(name);
    }
  }

  console.log(`Updates queued: ${updates.length}`);
  console.log(`Without URL: ${noUrl.length}`);
  console.log();

  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    await api('PATCH', `https://api.airtable.com/v0/${BASE}/${TBL}`, { records: batch });
    process.stdout.write(`  Batch ${Math.floor(i/10) + 1}/${Math.ceil(updates.length/10)} ✓\r`);
  }
  console.log('\nAll URLs pushed. ✅\n');

  if (noUrl.length > 0) {
    console.log('--- Brands without URL (please add manually) ---');
    noUrl.forEach(n => console.log('  -', n));
  }
})().catch(err => {
  console.error('\n❌', err.message, '\n');
  process.exit(1);
});
