/**
 * Erstellt einen Antwort-Entwurf zu einer E-Mail via Claude.
 *
 * Nutzt adaptive Thinking (das Schreiben einer tonfall-treuen Antwort ist
 * anspruchsvoller als Klassifikation) und effort: "medium".
 *
 * Der System-Prefix ist identisch zur Klassifikation (gecachte Wissensbasis),
 * danach folgen die Draft-spezifischen Anweisungen inkl. Style-Guide-Hinweis.
 * Der Style-Guide selbst ist Teil der Wissensbasis (knowledge/style-guide.md).
 */

const { getClient } = require('./anthropic');

const SYSTEM_TASK = `Du schreibst Antwort-Entwürfe im Namen des Inhabers eines Fahrrad-Service-Betriebs.

Wichtig:
- Die Datei "style-guide.md" in der Wissensbasis oben beschreibt Stil und Tonfall. Halte dich strikt daran.
- Nutze die Fakten aus der Wissensbasis (Preise, Standorte, Abläufe). Erfinde NICHTS dazu.
- Wenn wichtige Infos fehlen, frage höflich danach oder formuliere einen sinnvollen Platzhalter in [eckigen Klammern].
- Antworte in der Sprache der ursprünglichen E-Mail.
- Schreibe NUR den reinen E-Mail-Text (Anrede bis Grußformel). Keine Betreffzeile, keine Meta-Kommentare, keine Erklärungen.
- Es ist ein ENTWURF — der Mensch liest gegen und sendet selbst ab.`;

function renderDraftPrompt({ email, classification }) {
  const lines = [
    'Erstelle einen Antwort-Entwurf zu folgender E-Mail.',
    '',
    `Kategorie: ${classification.category}`,
    `Stimmung des Absenders: ${classification.sentiment}`,
    `Zusammenfassung: ${classification.summary}`,
  ];

  if (classification.missingInfo && classification.missingInfo.length) {
    lines.push(`Fehlende Infos (ggf. erfragen): ${classification.missingInfo.join(', ')}`);
  }

  lines.push(
    '',
    `Absender: ${email.from}`,
    `Betreff: ${email.subject}`,
    '',
    'Ursprüngliche E-Mail:',
    '"""',
    email.text,
    '"""'
  );

  return lines.join('\n');
}

/**
 * @returns {Promise<{text: string, usage: object}>}
 */
async function draftReply({ email, classification, knowledge, model }) {
  const client = getClient();

  const resp = await client.messages.create({
    model,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system: [
      // identischer gecachter Prefix wie bei der Klassifikation
      { type: 'text', text: knowledge, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: SYSTEM_TASK }
    ],
    messages: [
      { role: 'user', content: renderDraftPrompt({ email, classification }) }
    ]
  });

  const text = resp.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  return { text, usage: resp.usage };
}

module.exports = { draftReply };
