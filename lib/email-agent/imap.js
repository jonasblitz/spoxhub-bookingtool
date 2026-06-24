/**
 * IMAP-Anbindung für den Email-Agenten (imapflow + mailparser).
 *
 * Aufgaben:
 *  - Verbindung herstellen
 *  - in einem Ordner neue Mails finden (innerhalb eines Zeitfensters und noch
 *    nicht vom Agenten bearbeitet — erkannt über ein IMAP-Keyword)
 *  - Mails parsen (Text extrahieren)
 *  - Mails als "bearbeitet" markieren (Keyword setzen)
 *  - Entwürfe in den Drafts-Ordner schreiben
 *
 * Konfiguration via Umgebungsvariablen:
 *  IMAP_HOST, IMAP_PORT (default 993), IMAP_SECURE (default true),
 *  IMAP_USER, IMAP_PASSWORD, IMAP_DRAFTS_FOLDER (optional)
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

function buildClient() {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASSWORD;

  if (!host || !user || !pass) {
    throw new Error('IMAP-Konfiguration fehlt (IMAP_HOST, IMAP_USER, IMAP_PASSWORD).');
  }

  return new ImapFlow({
    host,
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: (process.env.IMAP_SECURE || 'true') !== 'false',
    auth: { user, pass },
    logger: false
  });
}

/**
 * Findet den Drafts-Ordner: erst über die IMAP-Special-Use-Flag "\Drafts",
 * sonst über IMAP_DRAFTS_FOLDER, sonst Fallback "Drafts".
 */
async function resolveDraftsFolder(client) {
  if (process.env.IMAP_DRAFTS_FOLDER) return process.env.IMAP_DRAFTS_FOLDER;

  const list = await client.list();
  const special = list.find(m => m.specialUse === '\\Drafts');
  if (special) return special.path;

  // gängige Fallbacks
  const candidates = ['Drafts', 'INBOX.Drafts', 'Entwürfe'];
  const byName = list.find(m => candidates.includes(m.path));
  return byName ? byName.path : 'Drafts';
}

/**
 * Holt neue, noch nicht bearbeitete Mails aus einem Ordner.
 *
 * @returns {Promise<Array>} Liste von { uid, from, replyTo, to, subject, date, text, messageId }
 */
async function fetchNewMessages(client, folder, { sinceDays, processedKeyword, maxBodyChars = 8000 }) {
  const lock = await client.getMailboxLock(folder);
  const messages = [];

  try {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

    // Mails im Zeitfenster, die das "bearbeitet"-Keyword noch NICHT tragen.
    const searchCriteria = { since };
    if (processedKeyword) searchCriteria.unKeyword = processedKeyword;

    const uids = await client.search(searchCriteria, { uid: true });
    if (!uids || uids.length === 0) return messages;

    for await (const msg of client.fetch(uids, { uid: true, source: true, envelope: true }, { uid: true })) {
      const parsed = await simpleParser(msg.source);

      const fromAddr = parsed.from?.value?.[0];
      const replyToAddr = parsed.replyTo?.value?.[0];

      let text = (parsed.text || '').trim();
      if (!text && parsed.html) {
        // grobe HTML->Text-Reduktion, falls keine Textversion da ist
        text = parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      if (text.length > maxBodyChars) {
        text = text.slice(0, maxBodyChars) + '\n[... gekürzt ...]';
      }

      messages.push({
        uid: msg.uid,
        from: fromAddr ? `${fromAddr.name || ''} <${fromAddr.address}>`.trim() : (parsed.from?.text || 'unbekannt'),
        fromAddress: fromAddr?.address || null,
        replyToAddress: replyToAddr?.address || fromAddr?.address || null,
        to: parsed.to?.text || '',
        subject: parsed.subject || '(kein Betreff)',
        date: parsed.date ? parsed.date.toISOString() : '',
        messageId: parsed.messageId || null,
        text: text || '(leerer Text)'
      });
    }
  } finally {
    lock.release();
  }

  return messages;
}

/**
 * Markiert eine Mail als vom Agenten bearbeitet (custom IMAP-Keyword).
 * Schlägt das Setzen fehl (Server erlaubt keine custom keywords), wird der
 * Fehler nur geloggt — der Lauf bricht nicht ab.
 */
async function markProcessed(client, folder, uid, keyword) {
  if (!keyword) return false;
  const lock = await client.getMailboxLock(folder);
  try {
    await client.messageFlagsAdd({ uid: String(uid) }, [keyword], { uid: true });
    return true;
  } catch (err) {
    console.warn(`  ⚠️  Konnte Keyword "${keyword}" nicht setzen (uid ${uid}): ${err.message}`);
    return false;
  } finally {
    lock.release();
  }
}

/**
 * Schreibt einen Entwurf (RFC822-Buffer) in den Drafts-Ordner.
 */
async function appendDraft(client, draftsFolder, rawBuffer) {
  await client.append(draftsFolder, rawBuffer, ['\\Draft'], new Date());
}

module.exports = {
  buildClient,
  resolveDraftsFolder,
  fetchNewMessages,
  markProcessed,
  appendDraft
};
