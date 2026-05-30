/**
 * Email-Agent — täglicher Lauf.
 *
 * Ablauf:
 *  1. Wissensbasis (knowledge/*.md) laden — wird als gecachter System-Prefix genutzt.
 *  2. Konfiguration (email-agent/config.json) laden.
 *  3. Mit IMAP verbinden.
 *  4. Pro Ordner: neue, noch nicht bearbeitete Mails holen.
 *  5. Jede Mail klassifizieren (Claude, Structured Output).
 *  6. Wenn die Kategorie eine Antwort vorsieht und needsReply=true:
 *       Antwort-Entwurf erzeugen und in den IMAP-Drafts-Ordner schreiben.
 *  7. Mail mit Keyword als "bearbeitet" markieren.
 *  8. Markdown-Report schreiben + Konsolen-Zusammenfassung ausgeben.
 *
 * Es wird NICHTS automatisch versendet — nur Entwürfe erstellt.
 *
 * Start:  node scripts/email-agent.js          (echter Lauf)
 *         node scripts/email-agent.js --dry-run (klassifiziert + draftet, schreibt aber
 *                                                 nichts ins Postfach, markiert nichts)
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { loadKnowledge } = require('../lib/email-agent/knowledge');
const { classifyEmail } = require('../lib/email-agent/classify');
const { draftReply } = require('../lib/email-agent/draft');
const { buildDraftMime } = require('../lib/email-agent/mime');
const { DEFAULT_MODEL } = require('../lib/email-agent/anthropic');
const imap = require('../lib/email-agent/imap');

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIG_PATH = path.join(__dirname, '..', 'email-agent', 'config.json');
const REPORTS_DIR = path.join(__dirname, '..', 'email-agent', 'reports');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function categoryAllowsDraft(config, categoryName) {
  const cat = config.categories.find(c => c.name === categoryName);
  return cat ? cat.draftReply === true : Boolean(config.draftWhenUncertain);
}

async function run() {
  console.log(`\n📬 Email-Agent — ${new Date().toISOString()}${DRY_RUN ? '  [DRY-RUN]' : ''}\n`);

  const knowledge = loadKnowledge();
  const config = loadConfig();
  const model = DEFAULT_MODEL;
  console.log(`Modell: ${model}`);
  console.log(`Ordner: ${config.imap.folders.join(', ')} | Zeitfenster: ${config.lookbackDays} Tage\n`);

  const fromAddress = process.env.EMAIL_FROM || process.env.IMAP_USER;

  const client = imap.buildClient();
  await client.connect();

  const report = [];
  const summary = { total: 0, drafted: 0, skipped: 0, errors: 0 };

  let draftsFolder = null;
  try {
    draftsFolder = await imap.resolveDraftsFolder(client);
    console.log(`Drafts-Ordner: ${draftsFolder}\n`);

    for (const folder of config.imap.folders) {
      let mails;
      try {
        mails = await imap.fetchNewMessages(client, folder, {
          sinceDays: config.lookbackDays,
          processedKeyword: config.processedKeyword
        });
      } catch (err) {
        console.error(`❌ Ordner "${folder}" konnte nicht gelesen werden: ${err.message}`);
        summary.errors++;
        continue;
      }

      console.log(`📂 ${folder}: ${mails.length} neue Mail(s)`);

      for (const email of mails) {
        summary.total++;
        try {
          const { result: classification } = await classifyEmail({ email, knowledge, categories: config.categories, model });

          const wantsDraft = classification.needsReply && categoryAllowsDraft(config, classification.category);
          console.log(`  • ${email.subject.slice(0, 60)}`);
          console.log(`    → ${classification.category} | Prio ${classification.priority} | ${classification.needsReply ? 'Antwort nötig' : 'keine Antwort'}`);

          let draftText = null;
          if (wantsDraft) {
            const draft = await draftReply({ email, classification, knowledge, model });
            draftText = draft.text;

            if (!DRY_RUN) {
              const raw = await buildDraftMime({
                from: fromAddress,
                to: email.replyToAddress || email.fromAddress,
                subject: email.subject,
                bodyText: draftText,
                inReplyTo: email.messageId
              });
              await imap.appendDraft(client, draftsFolder, raw);
            }
            console.log(`    ✏️  Entwurf erstellt${DRY_RUN ? ' (nicht gespeichert, dry-run)' : ` → ${draftsFolder}`}`);
            summary.drafted++;
          } else {
            summary.skipped++;
          }

          if (!DRY_RUN) {
            await imap.markProcessed(client, folder, email.uid, config.processedKeyword);
          }

          report.push({ folder, email, classification, draftText });
        } catch (err) {
          console.error(`    ❌ Fehler bei "${email.subject}": ${err.message}`);
          summary.errors++;
        }
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }

  writeReport(report, summary);

  console.log(`\n────────────────────────────────────────`);
  console.log(`Gesamt: ${summary.total} | Entwürfe: ${summary.drafted} | Ohne Antwort: ${summary.skipped} | Fehler: ${summary.errors}`);
  console.log(`✅ Fertig.\n`);

  if (summary.errors > 0 && summary.total === 0) process.exitCode = 1;
}

function writeReport(report, summary) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(REPORTS_DIR, `${day}.md`);

  const lines = [
    `# Email-Agent Report — ${new Date().toISOString()}`,
    '',
    `**Gesamt:** ${summary.total} · **Entwürfe:** ${summary.drafted} · **Ohne Antwort:** ${summary.skipped} · **Fehler:** ${summary.errors}`,
    ''
  ];

  for (const item of report) {
    const c = item.classification;
    lines.push(
      `## ${item.email.subject}`,
      '',
      `- **Von:** ${item.email.from}`,
      `- **Ordner:** ${item.folder}`,
      `- **Kategorie:** ${c.category} · **Prio:** ${c.priority} · **Stimmung:** ${c.sentiment}`,
      `- **Antwort nötig:** ${c.needsReply ? 'ja' : 'nein'}`,
      `- **Zusammenfassung:** ${c.summary}`
    );
    if (c.missingInfo && c.missingInfo.length) {
      lines.push(`- **Fehlende Infos:** ${c.missingInfo.join(', ')}`);
    }
    if (item.draftText) {
      lines.push('', '**Entwurf:**', '', '```', item.draftText, '```');
    }
    lines.push('');
  }

  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  console.log(`📄 Report: ${path.relative(path.join(__dirname, '..'), file)}`);
}

run().catch(err => {
  console.error('\n❌ Email-Agent abgebrochen:', err.message, '\n');
  process.exit(1);
});
