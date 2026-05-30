# Knowledge Base des Email-Agenten

Hier sammeln wir alle **wiederkehrenden Informationen**, die der Agent braucht,
um Mails zu verstehen und gute Antworten zu schreiben. Jede `.md`-Datei in
diesem Ordner (außer dieser README) wird beim Lauf automatisch geladen und
Claude als Kontext mitgegeben.

## So funktioniert es

- Alle `.md`-Dateien werden **alphabetisch** zu einem stabilen Wissensblock
  gebündelt und als gecachter System-Prompt an Claude geschickt
  (Prompt-Caching → ab der 2. Mail pro Lauf günstig & schnell).
- **Kein Code-Deploy nötig:** Datei bearbeiten, committen, fertig. Beim nächsten
  Lauf ist das neue Wissen aktiv.
- Halte die Dateien **knapp und faktisch**. Lieber kurze Stichpunkte als
  Fließtext — das spart Tokens und macht die Antworten präziser.

## Welche Datei wofür?

| Datei | Inhalt |
|---|---|
| `company.md` | Stammdaten: Standorte, Öffnungszeiten, Kontakt, Leistungen, Preise |
| `faq.md` | Häufige Kundenfragen + die kanonische Antwort darauf |
| `policies.md` | Regeln: Storno, Garantie, Zahlung, Abholung, DSGVO |
| `templates.md` | Wiederverwendbare Textbausteine für typische Antworten |
| `style-guide.md` | **Stil & Tonfall** — wie du klingst (siehe eigene Doku unten) |

## Neue Wissensdatei anlegen

1. Neue Datei `email-agent/knowledge/<thema>.md` anlegen.
2. Mit kurzen, faktischen Stichpunkten füllen.
3. Committen. Beim nächsten Lauf wird sie automatisch berücksichtigt.

## Pflege-Routine (Empfehlung)

Wenn du beim Gegenlesen eines Entwurfs merkst, dass der Agent etwas **nicht
wusste** oder etwas **falsch formuliert** hat:

- Faktisch falsch / fehlend → ergänze `company.md`, `faq.md` oder `policies.md`.
- Tonfall daneben → ergänze ein Beispiel oder eine Regel in `style-guide.md`.

So wird die Knowledge Base mit jeder Korrektur besser — sie ist das Gedächtnis
des Agenten.
