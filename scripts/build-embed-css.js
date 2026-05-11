#!/usr/bin/env node
/**
 * Build-Script für die Embed-CSS-Variante.
 *
 * Liest src/input.css, transformiert sie für den Plugin-Embed-Modus und
 * schreibt das Ergebnis nach src/input.embed.generated.css. Anschließend
 * wird Tailwind mit der Embed-Config aufgerufen.
 *
 * Transformationen:
 *  1. `@tailwind base;`  →  weglassen (Preflight ist via Config deaktiviert,
 *     stattdessen lokaler Mini-Reset innerhalb von .spoxhub-booking)
 *  2. `body { ... }`     →  `.spoxhub-booking { ... }`
 *  3. `body,`            →  `.spoxhub-booking,`
 *  4. Body-spezifische margin/padding-Resets bleiben — wir wollen, dass
 *     der Wrapper genauso aussieht wie der originale body.
 *
 * Aufruf:  node scripts/build-embed-css.js
 *          oder über npm:  npm run build:css:embed
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const postcss = require('postcss');
const prefixSelector = require('postcss-prefix-selector');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/input.css');
const TMP = path.join(ROOT, 'src/input.embed.generated.css');
const OUT = path.join(ROOT, 'public/css/output.embed.css');
const CFG = path.join(ROOT, 'tailwind.embed.config.js');

console.log('▸ Lese Quell-CSS:', path.relative(ROOT, SRC));
let css = fs.readFileSync(SRC, 'utf8');

// 1) @tailwind base BEHALTEN — Preflight ist via Config deaktiviert,
//    aber die Direktive muss da sein, damit @layer base funktioniert.
//    Ohne sie würde Tailwind mit "no matching @tailwind base directive" abbrechen.

// 2) Tailwind-Preflight-Klon, gescoped unter .spoxhub-booking.
//    Notwendig weil corePlugins.preflight: false (siehe tailwind.embed.config.js)
//    die globalen Resets ausschaltet — sonst würde der Wizard im WP-Theme mit
//    Browser-Default-Borders, falscher line-height, ungestylten Placeholder
//    und nicht-resetteten Checkboxen rendern (= sieht anders aus als Standalone).
//
//    1:1 von tailwindcss/src/css/preflight.css übernommen, jeden Top-Level-
//    Selektor mit `.spoxhub-booking ` prefixt. Listen-Selektoren mit
//    `.spoxhub-booking xyz, .spoxhub-booking abc` ausgeschrieben.
const localReset = `
/* ═══════════════════════════════════════════════════════════════════
   Preflight-Clone — gescoped unter .spoxhub-booking
   Spiegelt Tailwind v3 preflight.css. Verhindert dass der WP-Theme-
   Default oder Browser-Default in den Wizard durchschlägt.
   ═══════════════════════════════════════════════════════════════════ */

.spoxhub-booking,
.spoxhub-booking *,
.spoxhub-booking *::before,
.spoxhub-booking *::after {
  box-sizing: border-box;
  border-width: 0;
  border-style: solid;
  border-color: currentColor;
}

.spoxhub-booking { line-height: 1.5; -webkit-text-size-adjust: 100%; tab-size: 4; }

.spoxhub-booking hr {
  height: 0; color: inherit; border-top-width: 1px;
}

.spoxhub-booking abbr:where([title]) { text-decoration: underline dotted; }

.spoxhub-booking h1,
.spoxhub-booking h2,
.spoxhub-booking h3,
.spoxhub-booking h4,
.spoxhub-booking h5,
.spoxhub-booking h6 { font-size: inherit; font-weight: inherit; }

.spoxhub-booking a { color: inherit; text-decoration: inherit; }

.spoxhub-booking b,
.spoxhub-booking strong { font-weight: bolder; }

.spoxhub-booking code,
.spoxhub-booking kbd,
.spoxhub-booking samp,
.spoxhub-booking pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 1em;
}

.spoxhub-booking small { font-size: 80%; }

.spoxhub-booking sub,
.spoxhub-booking sup { font-size: 75%; line-height: 0; position: relative; vertical-align: baseline; }
.spoxhub-booking sub { bottom: -0.25em; }
.spoxhub-booking sup { top: -0.5em; }

.spoxhub-booking table {
  text-indent: 0; border-color: inherit; border-collapse: collapse;
}

.spoxhub-booking button,
.spoxhub-booking input,
.spoxhub-booking optgroup,
.spoxhub-booking select,
.spoxhub-booking textarea {
  font-family: inherit;
  font-feature-settings: inherit;
  font-variation-settings: inherit;
  font-size: 100%;
  font-weight: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  color: inherit;
  margin: 0;
  padding: 0;
}

.spoxhub-booking button,
.spoxhub-booking select { text-transform: none; }

.spoxhub-booking button,
.spoxhub-booking input:where([type='button']),
.spoxhub-booking input:where([type='reset']),
.spoxhub-booking input:where([type='submit']) {
  -webkit-appearance: button;
  background-color: transparent;
  background-image: none;
}

.spoxhub-booking :-moz-focusring { outline: auto; }
.spoxhub-booking :-moz-ui-invalid { box-shadow: none; }

.spoxhub-booking progress { vertical-align: baseline; }

.spoxhub-booking ::-webkit-inner-spin-button,
.spoxhub-booking ::-webkit-outer-spin-button { height: auto; }

.spoxhub-booking [type='search'] { -webkit-appearance: textfield; outline-offset: -2px; }

.spoxhub-booking ::-webkit-search-decoration { -webkit-appearance: none; }

.spoxhub-booking ::-webkit-file-upload-button {
  -webkit-appearance: button;
  font: inherit;
}

.spoxhub-booking summary { display: list-item; }

.spoxhub-booking blockquote,
.spoxhub-booking dl,
.spoxhub-booking dd,
.spoxhub-booking h1,
.spoxhub-booking h2,
.spoxhub-booking h3,
.spoxhub-booking h4,
.spoxhub-booking h5,
.spoxhub-booking h6,
.spoxhub-booking hr,
.spoxhub-booking figure,
.spoxhub-booking p,
.spoxhub-booking pre { margin: 0; }

.spoxhub-booking fieldset { margin: 0; padding: 0; }
.spoxhub-booking legend { padding: 0; }

.spoxhub-booking ol,
.spoxhub-booking ul,
.spoxhub-booking menu { list-style: none; margin: 0; padding: 0; }

.spoxhub-booking dialog { padding: 0; }

.spoxhub-booking textarea { resize: vertical; }

.spoxhub-booking input::placeholder,
.spoxhub-booking textarea::placeholder { opacity: 1; color: #b280b9; }

.spoxhub-booking button,
.spoxhub-booking [role="button"] { cursor: pointer; }

.spoxhub-booking :disabled { cursor: default; }

.spoxhub-booking img,
.spoxhub-booking svg,
.spoxhub-booking video,
.spoxhub-booking canvas,
.spoxhub-booking audio,
.spoxhub-booking iframe,
.spoxhub-booking embed,
.spoxhub-booking object { display: block; vertical-align: middle; }

.spoxhub-booking img,
.spoxhub-booking video { max-width: 100%; height: auto; }

.spoxhub-booking [hidden] { display: none; }

/* Custom-Checkbox/Radio-Reset — Wizard nutzt eigene .checkbox-input Optik */
.spoxhub-booking input[type='checkbox'],
.spoxhub-booking input[type='radio'] { -webkit-appearance: none; appearance: none; }
`;

// Nach @font-face einfügen, damit Reset vor allen Rules greift
css = css.replace(
  /(@font-face[\s\S]*?\}\s*)/,
  `$1\n${localReset}\n`
);

// 3) body { ... }  →  .spoxhub-booking { ... }
//    Auch innerhalb @layer base und @media-Queries.
//    Achtet auf: body{ ... }   body {   und Listen "body, foo {"
css = css.replace(/(^|\s|,)body(\s*[,{])/g, '$1.spoxhub-booking$2');

console.log('▸ Schreibe transformierte CSS:', path.relative(ROOT, TMP));
fs.writeFileSync(TMP, css);

console.log('▸ Tailwind-Build mit Embed-Config…');
execSync(
  `npx tailwindcss -c "${CFG}" -i "${TMP}" -o "${OUT}" --minify`,
  { stdio: 'inherit', cwd: ROOT }
);

// 4) Post-Process: alle Component-Class-Selektoren mit `.spoxhub-booking` prefixen.
//    Tailwind's `important: '.spoxhub-booking'` prefixt nur UTILITIES (.bg-…, .p-…),
//    nicht @layer components Klassen (.btn-cta, .form-input, .checkbox-input, …).
//    Ohne Prefix sind diese (Spez. 0,1,0) niedriger als unser Reset
//    `.spoxhub-booking button` (Spez. 0,1,1) → Reset überschreibt z.B. den
//    lime-Hintergrund von .btn-cta. Dieser Schritt fixt das.
console.log('▸ Post-Process: Component-Selektoren prefixen…');
const builtCss = fs.readFileSync(OUT, 'utf8');
const prefixed = postcss([
  prefixSelector({
    prefix: '.spoxhub-booking',
    transform(prefix, selector, prefixedSelector) {
      // Skip-Liste: Selektoren die schon gescoped sind oder nicht prefixt werden dürfen
      const trimmed = selector.trim();
      if (
        trimmed.startsWith('.spoxhub-booking') ||  // schon gescoped (von Tailwind utilities)
        trimmed.startsWith(':root') ||             // CSS-Variablen
        trimmed.startsWith('@')                    // at-rules
      ) {
        return selector;
      }
      // Pseudo-Element-only Selektoren (z.B. ::selection als Standalone) — nicht prefixen
      if (/^::?[a-z-]+$/i.test(trimmed)) {
        return selector;
      }
      return prefixedSelector;
    },
  }),
]).process(builtCss, { from: OUT, to: OUT }).css;
fs.writeFileSync(OUT, prefixed);

const sizeKB = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`✓ Embed-CSS gebaut: ${path.relative(ROOT, OUT)}  (${sizeKB} KB)`);
