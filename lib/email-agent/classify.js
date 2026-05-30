/**
 * Klassifikation einer einzelnen E-Mail via Claude.
 *
 * Nutzt Structured Outputs (output_config.format) → garantiert valides JSON
 * nach Schema. Thinking ist deaktiviert (Klassifikation ist eine einfache
 * Aufgabe → schneller & günstiger).
 *
 * Der gecachte System-Prefix (Wissensbasis) liegt im ERSTEN System-Block mit
 * cache_control. Der zweite Block enthält die task-spezifischen Anweisungen.
 * So teilen sich Klassifikation und Draft denselben Cache-Prefix.
 */

const { getClient } = require('./anthropic');

function buildSchema(categoryNames) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      category: {
        type: 'string',
        enum: categoryNames,
        description: 'Die am besten passende Kategorie aus der Liste.'
      },
      priority: {
        type: 'string',
        enum: ['hoch', 'mittel', 'niedrig'],
        description: 'Dringlichkeit aus Kundensicht.'
      },
      needsReply: {
        type: 'boolean',
        description: 'Braucht diese Mail eine persönliche Antwort?'
      },
      sentiment: {
        type: 'string',
        enum: ['positiv', 'neutral', 'negativ', 'verärgert'],
        description: 'Stimmung des Absenders.'
      },
      language: {
        type: 'string',
        description: 'Sprache der Mail als ISO-Code, z.B. "de" oder "en".'
      },
      summary: {
        type: 'string',
        description: 'Ein bis zwei Sätze: worum geht es konkret?'
      },
      missingInfo: {
        type: 'array',
        items: { type: 'string' },
        description: 'Infos, die für eine gute Antwort fehlen (leer, wenn alles da ist).'
      }
    },
    required: ['category', 'priority', 'needsReply', 'sentiment', 'language', 'summary', 'missingInfo']
  };
}

function renderCategoryList(categories) {
  return categories
    .map(c => `- ${c.name}: ${c.description}`)
    .join('\n');
}

function renderEmail(email) {
  return [
    `Von: ${email.from}`,
    `An: ${email.to}`,
    `Betreff: ${email.subject}`,
    `Datum: ${email.date}`,
    '',
    'Text der E-Mail:',
    '"""',
    email.text,
    '"""'
  ].join('\n');
}

const SYSTEM_TASK = (categories) => `Du bist der E-Mail-Assistent eines Fahrrad-Service-Betriebs.
Deine Aufgabe: Klassifiziere die eingehende E-Mail.

Verfügbare Kategorien:
${renderCategoryList(categories)}

Regeln:
- Wähle genau EINE Kategorie aus der Liste.
- needsReply = false bei Newslettern, automatischen Benachrichtigungen, reinen Bestätigungen oder Spam.
- Nutze die Wissensbasis oben, um den Kontext (Leistungen, Standorte, Preise) zu verstehen.
- Antworte ausschließlich im vorgegebenen JSON-Format.`;

/**
 * @returns {Promise<object>} geparstes Klassifikations-Objekt
 */
async function classifyEmail({ email, knowledge, categories, model }) {
  const client = getClient();
  const categoryNames = categories.map(c => c.name);

  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    system: [
      // Block 1: stabile Wissensbasis — wird gecacht (Prefix für alle Mails gleich)
      { type: 'text', text: knowledge, cache_control: { type: 'ephemeral' } },
      // Block 2: task-spezifische Anweisung
      { type: 'text', text: SYSTEM_TASK(categories) }
    ],
    output_config: {
      format: { type: 'json_schema', schema: buildSchema(categoryNames) }
    },
    messages: [
      { role: 'user', content: renderEmail(email) }
    ]
  });

  const textBlock = resp.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Keine Klassifikations-Antwort erhalten.');

  return {
    result: JSON.parse(textBlock.text),
    usage: resp.usage
  };
}

module.exports = { classifyEmail };
