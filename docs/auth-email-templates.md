# Auth-Email-Templates (Radblitz Branding)

Beim Login werden je nach Account-Status zwei verschiedene Templates aus
Supabase verschickt:

| Template | Wann | Variable |
|---|---|---|
| **Confirm signup** | beim ersten Login mit einer neuen Email (Account wird angelegt) | `{{ .ConfirmationURL }}` |
| **Magic Link** | bei Folge-Logins (Account existiert schon) | `{{ .ConfirmationURL }}` |

Beide pflegen wir im Supabase Dashboard:
[Authentication → Emails → Templates](https://supabase.com/dashboard/project/kqzotzmbuxwucrybfnqw/auth/templates)

**Subject** kannst du gleich oben anpassen, **Body** ist das HTML unten.

---

## 1. Magic Link

**Subject:**
```
Dein Login-Link für Radblitz
```

**Body (HTML):**

```html
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Radblitz — Login</title>
</head>
<body style="margin:0;padding:0;background:#3d0046;font-family:'Poppins',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#ffffff;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#3d0046;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;background:#5a0064;border-radius:16px;border:1px solid #7d3386;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 0;">
              <div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:#ffffff;">
                Radblitz<span style="color:#e8ff00;">.</span>
              </div>
              <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#d6b3db;margin-top:4px;">
                Mobile Cargo- &amp; E-Bike-Werkstatt Hamburg
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px;">
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#ffffff;line-height:1.2;">
                Willkommen zurück.
              </h1>
              <p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#d6b3db;">
                Klick auf den Button unten, um dich in deinem Radblitz-Buchungstool einzuloggen.
                Der Link ist 1 Stunde gültig und kann nur einmal verwendet werden.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 24px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="background:#e8ff00;border-radius:999px;">
                    <a href="{{ .ConfirmationURL }}"
                       style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#3d0046;text-decoration:none;font-family:inherit;">
                      Jetzt einloggen
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 24px;">
              <p style="margin:0;font-size:13px;line-height:1.55;color:#d6b3db;">
                Funktioniert der Button nicht? Kopier den Link in deinen Browser:<br>
                <span style="color:#e8ff00;word-break:break-all;">{{ .ConfirmationURL }}</span>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background:#3d0046;border-top:1px solid #7d3386;">
              <p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:#d6b3db;">
                Du hast diese E-Mail nicht angefordert? Dann kannst du sie ignorieren —
                ohne Klick auf den Link passiert nichts.
              </p>
              <p style="margin:0;font-size:12px;line-height:1.5;color:#d6b3db;">
                Radblitz GmbH · Hamburg ·
                <a href="https://radblitz.de" style="color:#e8ff00;text-decoration:none;">radblitz.de</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

---

## 2. Confirm Signup

**Subject:**
```
Willkommen bei Radblitz — dein Account-Setup
```

**Body (HTML):**

```html
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Radblitz — Account anlegen</title>
</head>
<body style="margin:0;padding:0;background:#3d0046;font-family:'Poppins',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#ffffff;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#3d0046;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;background:#5a0064;border-radius:16px;border:1px solid #7d3386;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 0;">
              <div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:#ffffff;">
                Radblitz<span style="color:#e8ff00;">.</span>
              </div>
              <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#d6b3db;margin-top:4px;">
                Mobile Cargo- &amp; E-Bike-Werkstatt Hamburg
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px;">
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#ffffff;line-height:1.2;">
                Schön, dass du dabei bist.
              </h1>
              <p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#d6b3db;">
                Bestätige kurz deine E-Mail-Adresse — danach ist dein Account fertig
                und du kannst deine Stammdaten beim nächsten Buchen vorausgefüllt
                übernehmen.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:0 32px 24px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="background:#e8ff00;border-radius:999px;">
                    <a href="{{ .ConfirmationURL }}"
                       style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#3d0046;text-decoration:none;font-family:inherit;">
                      Account bestätigen
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 24px;">
              <p style="margin:0;font-size:13px;line-height:1.55;color:#d6b3db;">
                Funktioniert der Button nicht? Kopier den Link in deinen Browser:<br>
                <span style="color:#e8ff00;word-break:break-all;">{{ .ConfirmationURL }}</span>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background:#3d0046;border-top:1px solid #7d3386;">
              <p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:#d6b3db;">
                Du hast diese E-Mail nicht angefordert? Einfach ignorieren — ohne
                Klick auf den Link passiert nichts.
              </p>
              <p style="margin:0;font-size:12px;line-height:1.5;color:#d6b3db;">
                Radblitz GmbH · Hamburg ·
                <a href="https://radblitz.de" style="color:#e8ff00;text-decoration:none;">radblitz.de</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

---

## Vorschau-Test

Nach dem Speichern jedes Templates: im Dashboard gibt es einen
„Send test email"-Button. Damit verschickst du dir die Mail an dein
Postfach und siehst die Darstellung in Apple Mail / Gmail / Outlook
direkt.

## Hinweise

- **Inline-CSS only.** Email-Clients (insbesondere Outlook) strippen
  externes CSS — alles ist daher direkt am Element. Sieht hässlich aus,
  ist aber stabil.
- **Poppins als Font** wird nur in den Clients verwendet, die es haben.
  Für Gmail/Outlook fallen wir auf `system-ui` / Helvetica zurück —
  immer noch lesbar.
- **Lime-CTA mit dunklem Text** ist Brand-Regel: Text auf Lime ist
  *immer* `#3d0046` (purple-950), nie weiß.
- **Reset Password / Reauthentication** sind unsere Auth-Flows aktuell
  nicht im Einsatz — der Klick auf „Einloggen" mit unbekannter Email
  triggert „Confirm signup". Die anderen Templates kannst du im Dashboard
  unverändert lassen.
