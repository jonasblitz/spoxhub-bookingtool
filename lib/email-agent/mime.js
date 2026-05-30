/**
 * Baut eine RFC822-Nachricht für einen Antwort-Entwurf.
 *
 * Nutzt nodemailers MailComposer, damit Header (In-Reply-To, References,
 * UTF-8-Betreff-Kodierung) korrekt gesetzt werden. Das Ergebnis ist ein
 * Buffer, der per IMAP APPEND in den Drafts-Ordner geschrieben wird.
 */

const MailComposer = require('nodemailer/lib/mail-composer');

/**
 * Hängt "Re: " an den Betreff an, ohne es zu verdoppeln.
 */
function replySubject(subject) {
  const s = (subject || '').trim();
  if (/^re:/i.test(s)) return s;
  return `Re: ${s}`;
}

/**
 * @param {object} opts
 * @param {string} opts.from        Absender-Adresse des Betriebs (EMAIL_FROM)
 * @param {string} opts.to          Empfänger (= ursprünglicher Absender)
 * @param {string} opts.subject     ursprünglicher Betreff
 * @param {string} opts.bodyText    der von Claude erzeugte Antworttext
 * @param {string} [opts.inReplyTo] Message-ID der Original-Mail
 * @returns {Promise<Buffer>}
 */
function buildDraftMime({ from, to, subject, bodyText, inReplyTo }) {
  const mail = {
    from,
    to,
    subject: replySubject(subject),
    text: bodyText
  };

  if (inReplyTo) {
    mail.inReplyTo = inReplyTo;
    mail.references = inReplyTo;
  }

  return new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((err, message) => {
      if (err) return reject(err);
      resolve(message);
    });
  });
}

module.exports = { buildDraftMime, replySubject };
