# OAuth Provider Setup — Google + Apple

Schritt-für-Schritt-Anleitung für „Mit Google fortfahren" / „Mit Apple
fortfahren" im Booking-Tool. Nach dem Setup übernimmt Supabase die OAuth-
Handshakes; unser Code (`public/js/auth.js → signInWithProvider`) macht
nur den Anstoß.

## Konstanten, die du gleich brauchst

| Wert | Inhalt |
|---|---|
| Supabase Project Ref | `kqzotzmbuxwucrybfnqw` |
| **Supabase Auth Callback** (Provider-Redirect-Ziel) | `https://kqzotzmbuxwucrybfnqw.supabase.co/auth/v1/callback` |
| Booking-Tool Public URL | `https://spoxhub.io/booking/` |
| Booking-Tool Auth-Callback (Browser-Landing) | `https://spoxhub.io/booking/api/auth/callback` |

Die **Supabase Auth Callback** ist die wichtige — diese URL gibst du bei
beiden Providern als „Redirect URI" / „Return URL" an. Supabase empfängt
da den OAuth-Code, tauscht ihn gegen ein Token und schickt den User
dann automatisch weiter zu deiner Booking-Tool-Callback-Page.

---

# Teil A: Google

**Aufwand:** ~15 Min. Kostenlos.

## A1. Google Cloud Console öffnen

https://console.cloud.google.com/ — falls du noch nie Cloud-Projekt
hattest, oben links **„Select project" → „New Project"**:
- Project name: `Radblitz Booking`
- Location: leer lassen
- → Create
- Im Reiter „Notifications" das Projekt auswählen, sobald es da ist.

## A2. OAuth Consent Screen konfigurieren

Linkes Menü → **APIs & Services → OAuth consent screen**:

1. **User Type: External** → Create
2. **App information:**
   - App name: `Radblitz`
   - User support email: deine
   - App logo: optional (PNG, max 1MB) — wenn du eins hochlädst, müssen
     manche Felder verifiziert werden, was Tage dauert. Empfehlung:
     **erstmal kein Logo**, dann später nachschieben.
3. **App domain:**
   - Application home page: `https://radblitz.de`
   - Application privacy policy link: `https://radblitz.de/datenschutz` (oder andere URL deiner Privacy-Policy)
   - Application terms of service link: `https://radblitz.de/agb`
4. **Authorized domains** (drücke Enter zwischen den Einträgen):
   - `radblitz.de`
   - `spoxhub.io`
   - **NICHT** `supabase.co` — Google blockt das, weil die Domain dir
     nicht gehört (Domain-Verification fehlt). Supabase wird erst in der
     Client-ID-Config bei den Redirect URIs gebraucht (siehe A3), das ist
     OK ohne Verifikation.
5. **Developer contact information**: deine Email
6. → Save and Continue

**Scopes**: nichts hinzufügen → Save and Continue.
**Test users**: nichts hinzufügen → Save and Continue.
**Summary** → Back to Dashboard.

→ **Wichtig:** auf dem Dashboard oben siehst du jetzt „Publishing status:
Testing". Drück **„Publish App"** und bestätige „Confirm". Sonst können
sich nur Test-User einloggen.

## A3. OAuth Client ID anlegen

Linkes Menü → **APIs & Services → Credentials → + Create credentials →
OAuth client ID**:

1. **Application type: Web application**
2. **Name:** `Radblitz Booking — Web`
3. **Authorized JavaScript origins** (über „Add URI" hinzufügen):
   - `https://spoxhub.io`
4. **Authorized redirect URIs**:
   - `https://kqzotzmbuxwucrybfnqw.supabase.co/auth/v1/callback`
5. → Create

Es erscheint ein Dialog mit **Client ID** und **Client Secret**.
**Beide kopieren** (Client Secret siehst du später nur noch durchs
Bleistift-Icon, aber besser jetzt sichern).

## A4. In Supabase eintragen

[Supabase Dashboard → Auth → Sign In / Up](https://supabase.com/dashboard/project/kqzotzmbuxwucrybfnqw/auth/sign-in-up-providers):

1. **Google** suchen → aufklappen
2. **„Enable Sign in with Google"** anschalten
3. **Client ID (for OAuth)**: einfügen
4. **Client Secret (for OAuth)**: einfügen
5. Skip nonce checks: aus lassen (Default)
6. → **Save**

## A5. Test

In einem **Incognito-Fenster** https://spoxhub.io/booking/ öffnen →
„Einloggen" → „Mit Google fortfahren". Es sollte:
1. Zu Google weiterleiten (Account-Auswahl)
2. Nach Auswahl deines Accounts kurz zur Supabase-Callback-URL
3. Dann zurück auf `https://spoxhub.io/booking/api/auth/callback`
4. Dann zur Booking-Tool-Startseite, mit Banner „Eingeloggt als ..."

Wenn beim ersten Mal Google sagt „This app isn't verified" — das ist OK,
es passiert in den ersten Tagen jeder externen App. Klick „Advanced" →
„Go to Radblitz (unsafe)". Nach ein paar Tagen Production-Nutzung
verschwindet das.

---

# Teil B: Apple

**Aufwand:** ~45-60 Min. **Voraussetzung: Apple Developer Membership** ($99/Jahr).
Falls du keine hast, überspring diesen Teil — Google-only reicht für viele Kunden.

## B1. App ID anlegen

https://developer.apple.com/account/resources/identifiers/list →
**+ Plus-Knopf** → **App IDs** → Continue → **App** → Continue:

1. **Description:** `Radblitz Booking`
2. **Bundle ID** (Explicit): `de.radblitz.booking`
   (frei wählbar, aber muss eindeutig sein — Reverse-Domain-Stil)
3. Im Abschnitt „Capabilities" → **„Sign In with Apple"** ankreuzen
4. → Continue → Register

## B2. Services ID anlegen

Resources → Identifiers → **+ Plus** → **Services IDs** → Continue:

1. **Description:** `Radblitz Booking Web`
2. **Identifier:** `de.radblitz.booking.web`
   (anders als die App ID — Konvention ist die App ID mit Suffix `.web`)
3. → Continue → Register

Zurück zur Identifiers-Liste → die neue Services ID anklicken:

1. **„Sign In with Apple"** ankreuzen
2. **Configure** (rechts daneben) klicken
3. **Primary App ID**: `de.radblitz.booking` (die aus B1)
4. **Domains and Subdomains**:
   - `kqzotzmbuxwucrybfnqw.supabase.co`
5. **Return URLs**:
   - `https://kqzotzmbuxwucrybfnqw.supabase.co/auth/v1/callback`
6. → Next → Done → Save

> **Wichtig:** Apple zeigt bei „Domains" einen „Download" / „Verify"-Button.
> Du musst **nichts auf einer Domain hosten** — die Domain ist `supabase.co`,
> und Apple akzeptiert diese auch ohne dass du sie verifizierst, weil
> Supabase als Service-Provider den OAuth-Flow handhabt. Trotzdem zeigt
> Apple bei der Konfiguration manchmal einen Verifizierungs-Status
> „Pending". Den ignorieren.

## B3. Auth Key erstellen + .p8 herunterladen

Resources → Keys → **+ Plus**:

1. **Key Name:** `Radblitz Booking Sign In with Apple`
2. **„Sign In with Apple"** ankreuzen → **Configure**:
   - Primary App ID: `de.radblitz.booking`
   - → Save
3. → Continue → Register
4. **„Download"** — du bekommst eine `.p8`-Datei. **Sie kann nur EINMAL
   heruntergeladen werden** — sicher speichern (z.B. 1Password).
5. **Key ID** (10-stelliger Code, z.B. `A1B2C3D4E5`) — kopieren.

## B4. Team ID notieren

Oben rechts im Apple Developer Portal → dein Name → **Membership**. Da
steht die **Team ID** (z.B. `ABCDE12345`).

## B5. In Supabase eintragen

[Supabase Dashboard → Auth → Sign In / Up](https://supabase.com/dashboard/project/kqzotzmbuxwucrybfnqw/auth/sign-in-up-providers):

1. **Apple** suchen → aufklappen
2. **„Enable Sign in with Apple"** anschalten
3. **Client ID (for OAuth):** `de.radblitz.booking.web` (die Services ID
   aus B2 — NICHT die App ID!)
4. **Secret Key (for OAuth):** hier müssen alle drei in der Reihenfolge
   sein:
   - **Team ID** (aus B4)
   - **Key ID** (aus B3)
   - **Private Key** (Inhalt der `.p8`-Datei — Textfile öffnen und
     komplett kopieren, **inkl.** `-----BEGIN PRIVATE KEY-----` und
     `-----END PRIVATE KEY-----`)

   Supabase hat zwei Felder dafür (Team ID, Key ID, Secret/p8) — falls
   im Dashboard separat: alle drei einfügen. Falls ein einzelnes Feld
   „Generated Secret": Supabase macht dann selbst den JWT-Generierung
   aus Team ID + Key ID + .p8.

5. → **Save**

## B6. Test

Wie bei A5, aber „Mit Apple fortfahren". Apple öffnet einen ID-Dialog mit
deinem Apple ID Login → Auth-Anfrage „Radblitz Booking Web möchte deinen
Namen und E-Mail teilen" → Confirm → zurück zum Booking-Tool, eingeloggt.

**Subtilität: Apple gibt die Email nur beim ersten Login zurück** — danach
gibt Apple einen relay-Token (anonyme Privacy-Email). Unsere Profil-
Bridge nutzt aber die Email als Identifier; das funktioniert weil
Supabase die echte Email beim ersten Login speichert und in folgenden
Logins als `auth.user.email` wieder zurückgibt.

---

# Was bei Problemen tun

## „This app isn't verified" (Google)

Erwartet bei externen OAuth-Apps in den ersten Tagen. „Advanced" → „Go
to Radblitz (unsafe)" klicken. Für unverdächtige Domains verschwindet
das nach ein paar erfolgreichen Logins automatisch. Wenn dauerhaft ein
Verification-Banner stört: bei Google die formelle „Brand Verification"
machen (Logo + Datenschutz-Verifizierung, dauert 5-7 Tage).

## „redirect_uri_mismatch" (Google)

Die Redirect-URI in Google Cloud passt nicht exakt mit der von Supabase
gesendeten überein. Stelle sicher, dass in Google Cloud bei „Authorized
redirect URIs" **exakt** `https://kqzotzmbuxwucrybfnqw.supabase.co/auth/v1/callback`
steht (kein Slash am Ende, kein `www`, keine Subpfade).

## „invalid_client" (Apple)

Meist falscher Service-Identifier in Supabase. Doppelcheck: Du brauchst
die **Services ID** (z.B. `de.radblitz.booking.web`), NICHT die **App ID**
(`de.radblitz.booking`).

## Apple Login funktioniert nicht beim zweiten User

Apple-User mit „Email verbergen"-Option geben uns eine
`<random>@privaterelay.appleid.com`-Email. Profil-Bridge legt für jede
dieser Random-Emails einen separaten Customer-Row in `public.customers`
an — das ist OK, aber bedeutet: keine Bestandsdaten-Übernahme, weil
diese Email in eTermin/Airtable nicht existiert.

Falls du das vermeiden willst: im Apple-Setup eine „App Group" mit
„Allow real email" anbieten. Standard.

---

# Reihenfolge-Empfehlung

1. **Google zuerst** — schnell durch, sofort testen. Bestätigt dass
   unser Code-Setup korrekt ist.
2. **Apple danach** — sobald Google läuft und du Apple Developer ready
   hast.
3. Bei beiden den **ersten Login mit deiner eigenen Email** machen, die
   identisch zur Bestandskunden-Email in Airtable ist — dann siehst du,
   dass die Profil-Bridge auch via OAuth deine alten Daten findet.

Sag Bescheid sobald A4 (Google in Supabase eingetragen) fertig ist,
dann teste ich gleich Teil A. Apple kannst du auf einen späteren Tag
schieben, wenn dir der Aufwand zu groß ist.
