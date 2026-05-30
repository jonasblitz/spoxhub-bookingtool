/**
 * Knowledge-Base-Loader für den Email-Agenten.
 *
 * Lädt alle Markdown-Dateien aus email-agent/knowledge/ (außer README.md) und
 * bündelt sie zu EINEM stabilen Textblock. Dieser Block wird als gecachter
 * System-Prefix an Claude geschickt (Prompt-Caching) — er ändert sich pro Lauf
 * nicht, also teilen sich Klassifikation und Draft-Erstellung den Cache.
 *
 * Pflege: einfach .md-Dateien in knowledge/ anlegen/ändern. Kein Code-Deploy nötig.
 */

const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, '..', '..', 'email-agent', 'knowledge');

/**
 * Liest alle Wissens-Dateien ein und gibt sie als ein einziger String zurück.
 * Dateien werden alphabetisch sortiert, damit die Byte-Reihenfolge stabil
 * bleibt (wichtig fürs Prompt-Caching — siehe shared/prompt-caching.md).
 */
function loadKnowledge() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    throw new Error(`Knowledge-Verzeichnis fehlt: ${KNOWLEDGE_DIR}`);
  }

  const files = fs.readdirSync(KNOWLEDGE_DIR)
    .filter(f => f.toLowerCase().endsWith('.md'))
    .filter(f => f.toLowerCase() !== 'readme.md')
    .sort();

  if (files.length === 0) {
    throw new Error(`Keine Wissens-Dateien in ${KNOWLEDGE_DIR} gefunden.`);
  }

  const parts = files.map(file => {
    const content = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8').trim();
    return `===== DATEI: ${file} =====\n\n${content}`;
  });

  return parts.join('\n\n\n');
}

module.exports = { loadKnowledge, KNOWLEDGE_DIR };
