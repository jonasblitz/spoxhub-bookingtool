# Email-Agent

Ein täglicher Assistent, der die Mails in deinen IMAP-Ordnern durchsieht,
**klassifiziert** und bei Bedarf **Antwort-Entwürfe** schreibt. Die Entwürfe
landen direkt im Drafts-Ordner deines Postfachs — du liest gegen und sendest
selbst ab. **Es wird nie automatisch versendet.**

## Was er macht

1. Holt neue Mails (Zeitfenster konfigurierbar) aus den definierten Ordnern.
2. Klassifiziert jede Mail (Kategorie, Priorität, Stimmung, „Antwort nötig?").
3. Schreibt für antwortwürdige Kategorien einen Entwurf — mit deinem Wissen
   (Knowledge Base) und in deinem Stil (Style-Guide).
4. Legt den Entwurf als Draft ins Postfach und markiert die Mail als bearbeitet.
5. Schreibt einen Markdown-Report nach `email-agent/reports/`.

## Architektur

```
scripts/email-agent.js          ← Orchestrierung (der tägliche Lauf)
lib/email-agent/
  knowledge.js                  ← lädt knowledge/*.md als gecachten Prompt-Prefix
  anthropic.js                  ← Anthropic-SDK-Client (Modell konfigurierbar)
  classify.js                   ← Klassifikation (Structured Output)
  draft.js                      ← Antwort-Entwurf (adaptive thinking)
  imap.js                       ← IMAP lesen / markieren / Draft schreiben
  mime.js                       ← RFC822-Entwurf bauen (korrekte Reply-Header)
email-agent/
  config.json                   ← Ordner, Kategorien, Zeitfenster
  knowledge/                    ← deine Wissensbasis + Style-Guide (Markdown)
  reports/                      ← Tages-Reports (gitignored)
```

Klassifikation und Draft sind einfache LLM-Calls (kein Agent-Framework nötig).
Die Wissensbasis wird als **gecachter System-Prefix** mitgeschickt — dadurch
sind alle Mails nach der ersten pro Lauf deutlich günstiger und schneller.

## Setup

### 1. Abhängigkeiten installieren
```bash
npm install
```

### 2. Umgebungsvariablen setzen
Trag die Werte aus `.env.email-agent.example` in deine `.env` ein:

```
ANTHROPIC_API_KEY=sk-ant-...
IMAP_HOST=imap.deinprovider.de
IMAP_USER=service@spoxhub.de
IMAP_PASSWORD=...
EMAIL_FROM=service@spoxhub.de
# optional:
# IMAP_PORT=993
# IMAP_SECURE=true
# IMAP_DRAFTS_FOLDER=Drafts
# EMAIL_AGENT_MODEL=claude-opus-4-8   # z.B. claude-haiku-4-5 für hohes Volumen
```

> 💡 Bei Gmail/Outlook brauchst du i.d.R. ein **App-Passwort**, nicht dein
> normales Passwort.

### 3. Wissensbasis füllen
Die Dateien in `email-agent/knowledge/` enthalten aktuell Platzhalter. Trag
eure echten Daten ein — besonders **`style-guide.md`** (Tonfall) und
**`company.md`** (Fakten). Siehe `knowledge/README.md`.

### 4. Trockenlauf
Klassifiziert und draftet, schreibt aber NICHTS ins Postfach:
```bash
npm run email-agent:dry
```

### 5. Echter Lauf
```bash
npm run email-agent
```

## Täglich automatisch (GitHub Action)

`.github/workflows/email-agent.yml` führt den Agenten täglich aus. Hinterlege
die Secrets unter **Repo → Settings → Secrets and variables → Actions**:

- `ANTHROPIC_API_KEY`, `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD`, `EMAIL_FROM`
- optional: `IMAP_PORT`, `IMAP_SECURE`, `IMAP_DRAFTS_FOLDER`, `EMAIL_AGENT_MODEL`

## Wie verhindert der Agent Doppel-Antworten?

Bearbeitete Mails werden mit dem IMAP-Keyword `$SpoxAgentDone` (konfigurierbar
in `config.json`) markiert. Beim nächsten Lauf werden markierte Mails
übersprungen. Falls dein Mailserver keine eigenen Keywords erlaubt, wird das im
Log gemeldet — dann ggf. das Zeitfenster (`lookbackDays`) auf 1 setzen.

## Anpassen

- **Welche Ordner?** → `config.json` → `imap.folders`
- **Welche Kategorien / wann Entwurf?** → `config.json` → `categories[].draftReply`
- **Zeitfenster?** → `config.json` → `lookbackDays`
- **Tonfall / Fakten?** → `email-agent/knowledge/*.md`
- **Modell / Kosten?** → `EMAIL_AGENT_MODEL` (Standard `claude-opus-4-8`)
