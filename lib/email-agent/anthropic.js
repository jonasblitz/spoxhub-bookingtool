/**
 * Dünner Wrapper um das offizielle Anthropic SDK.
 *
 * Der API-Key wird aus der Umgebung gelesen (ANTHROPIC_API_KEY) — niemals
 * hartcodieren. Das Default-Modell ist claude-opus-4-8; bei sehr hohem
 * Mail-Volumen kann über EMAIL_AGENT_MODEL ein günstigeres Modell gewählt
 * werden (z.B. claude-haiku-4-5 für die Klassifikation).
 */

const Anthropic = require('@anthropic-ai/sdk');

let client = null;

function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY ist nicht gesetzt.');
    }
    client = new Anthropic(); // liest ANTHROPIC_API_KEY aus der Umgebung
  }
  return client;
}

// Default-Modell für alle Calls; einzeln überschreibbar.
const DEFAULT_MODEL = process.env.EMAIL_AGENT_MODEL || 'claude-opus-4-8';

module.exports = { getClient, DEFAULT_MODEL };
