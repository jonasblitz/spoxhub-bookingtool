<?php
/**
 * Lädt CSS und JS vom spoxhub-Backend, sobald der Shortcode auf einer Seite ist.
 *
 * @package SpoxHubBooking
 */

namespace SpoxHub\Booking;

if ( ! defined( 'ABSPATH' ) ) { exit; }

class Asset_Loader {

    private const HANDLE_PREFIX = 'spoxhub-booking-';
    private const PAYPAL_HANDLE = 'spoxhub-booking-paypal-sdk';

    /** @var Api_Client */
    private $api;

    /** @var bool — true sobald enqueue() lief, damit nicht doppelt enqueued wird */
    private $enqueued = false;

    public function __construct( Api_Client $api ) {
        $this->api = $api;
    }

    public function register(): void {
        // Wir enqueuen lazy: erst wenn der Shortcode wirklich rendert.
        // Das vermeidet Asset-Bloat auf Seiten, die das Booking nicht zeigen.
    }

    /**
     * Wird vom Shortcode aufgerufen, wenn er rendert.
     * Idempotent — mehrfacher Aufruf macht nichts kaputt.
     */
    public function enqueue(): void {
        if ( $this->enqueued ) {
            return;
        }
        $this->enqueued = true;

        $config = $this->api->get_config();
        if ( is_wp_error( $config ) ) {
            // Asset-Loading überspringen — Shortcode zeigt seine eigene Fehler-UI
            return;
        }

        $api_base   = $this->api->api_base();
        $version    = isset( $config['version'] ) ? sanitize_text_field( $config['version'] ) : SPOXHUB_BOOKING_VERSION;

        // ─── Styles ────────────────────────────────────────────────────────
        $styles = isset( $config['styles'] ) && is_array( $config['styles'] ) ? $config['styles'] : [];
        $first_style_handle = null;
        foreach ( $styles as $i => $rel_path ) {
            $handle = self::HANDLE_PREFIX . 'style-' . $i;
            wp_enqueue_style(
                $handle,
                $this->resolve_url( $api_base, $rel_path ),
                [],
                $version
            );
            if ( null === $first_style_handle ) {
                $first_style_handle = $handle;
            }
        }

        // ─── Critical Inline-CSS ───────────────────────────────────────────
        // Display-Regeln für den Wizard-Flow direkt im Plugin liefern, nicht
        // nur via output.embed.css. Schützt gegen Caches/Minifier (z.B. WPO-Minify
        // auf radblitz.de) die !important-Regeln strippen, und gegen PageBuilder
        // wie Elementor die mit höherer Spezifität überschreiben.
        // Triple-Selektor (`html body.spoxhub-booking-active …`) sorgt für
        // hohe Specificity, falls nötig.
        $critical = <<<CSS
.spoxhub-booking .step-panel.is-hidden,
.spoxhub-booking .step-panel[hidden],
.spoxhub-booking .screen-panel.is-hidden,
.spoxhub-booking .screen-panel[hidden],
html body .spoxhub-booking .step-panel.is-hidden,
html body .spoxhub-booking .step-panel[hidden],
html body .spoxhub-booking .screen-panel.is-hidden,
html body .spoxhub-booking .screen-panel[hidden] {
  display: none !important;
}
.spoxhub-booking .hidden,
html body .spoxhub-booking .hidden {
  display: none !important;
}
CSS;
        if ( $first_style_handle ) {
            wp_add_inline_style( $first_style_handle, $critical );
        }

        // ─── Inline-Bootstrap (vor dem ersten JS) ──────────────────────────
        // Setzt globale Variablen, die das Frontend-JS auswertet.
        // Namespace = Site-URL-Hash, damit mehrere Seiten oder Multi-Site nicht
        // ihre sessionStorage-States überschreiben.
        //
        // KRITISCH: das Standalone (booking.ejs) definiert `const API_BASE = …`
        // als Inline-Script. embed.ejs hat das nicht — wir müssen es hier
        // duplizieren, sonst sind ALLE fetch()-Calls (geo, catalog, booking, …)
        // mit `undefined`-Prefix kaputt.
        $namespace = substr( md5( home_url() ), 0, 8 );
        $supabase_url      = isset( $config['supabaseUrl'] )      ? (string) $config['supabaseUrl']      : '';
        $supabase_anon_key = isset( $config['supabaseAnonKey'] )  ? (string) $config['supabaseAnonKey']  : '';
        $bootstrap = sprintf(
            "window.SPOXHUB_API_BASE = %s;\n" .
            "window.SPOXHUB_STATE_NAMESPACE = %s;\n" .
            // const + window-Property — Frontend-Code referenziert teilweise
            // `API_BASE` direkt (lexikalisch erreichbar zwischen <script>-Tags),
            // teilweise `window.API_BASE`. Beides setzen.
            "const API_BASE = window.SPOXHUB_API_BASE.replace(/\\/\$/, '');\n" .
            "window.API_BASE = API_BASE;\n" .
            // Supabase Public-Werte für OAuth (auth.js). Anon-Key ist absichtlich
            // öffentlich, RLS-Policies regeln die DB-Sicht.
            "window.SUPABASE_URL = %s;\n" .
            "window.SUPABASE_ANON_KEY = %s;\n",
            wp_json_encode( $api_base ),
            wp_json_encode( $namespace ),
            wp_json_encode( $supabase_url ),
            wp_json_encode( $supabase_anon_key )
        );

        // ─── Vendor-Scripts (z.B. supabase-js CDN) ────────────────────────
        // Müssen VOR den Booking-Tool-Scripts geladen werden, weil auth.js
        // `window.supabase.createClient(...)` aufruft.
        $vendor_scripts = isset( $config['vendorScripts'] ) && is_array( $config['vendorScripts'] )
            ? $config['vendorScripts'] : [];
        $vendor_handles = [];
        foreach ( $vendor_scripts as $i => $vendor_url ) {
            $handle = self::HANDLE_PREFIX . 'vendor-' . $i;
            wp_enqueue_script( $handle, $vendor_url, [], $version, true );
            $vendor_handles[] = $handle;
        }

        // ─── Scripts (in der vom Backend vorgegebenen Reihenfolge) ────────
        $scripts = isset( $config['scripts'] ) && is_array( $config['scripts'] ) ? $config['scripts'] : [];
        $previous_handle = null;
        foreach ( $scripts as $i => $rel_path ) {
            $handle = self::HANDLE_PREFIX . 'js-' . $i;
            // Erstes Booking-Tool-Script hängt an den vendor-handles (damit
            // supabase-js zuerst geladen ist), Folgescripts an dem vorigen.
            $deps   = $previous_handle ? [ $previous_handle ] : $vendor_handles;
            wp_enqueue_script(
                $handle,
                $this->resolve_url( $api_base, $rel_path ),
                $deps,
                $version,
                true // im Footer laden
            );
            // Bootstrap nur einmal: vor dem ALLERERSTEN Script
            if ( null === $previous_handle ) {
                wp_add_inline_script( $handle, $bootstrap, 'before' );
            }
            $previous_handle = $handle;
        }

        // ─── PayPal-SDK (optional) ─────────────────────────────────────────
        // Lädt direkt vom paypal.com — kein CORS, weil Browser-natives Script-Tag.
        // Muss VOR payment.js laufen, daher als Dependency davor einhängen.
        //
        // Backend liefert die fertige SDK-URL via /embed/config → paypalSdkUrl
        // (inkl. disable-funding etc.). Damit ist Standalone und Plugin sicher
        // synchron, weil beide dieselbe URL-Quelle nutzen.
        // Fallback: falls das Backend (alte Version) nur paypalClientId schickt,
        // bauen wir eine minimal-URL — ohne disable-funding!
        if ( ! empty( $config['paypalSdkUrl'] ) ) {
            $sdk_url = $config['paypalSdkUrl'];
        } elseif ( ! empty( $config['paypalClientId'] ) ) {
            $sdk_url = sprintf(
                'https://www.paypal.com/sdk/js?client-id=%s&currency=EUR&intent=capture',
                rawurlencode( $config['paypalClientId'] )
            );
        } else {
            $sdk_url = '';
        }

        if ( ! empty( $sdk_url ) ) {
            wp_enqueue_script( self::PAYPAL_HANDLE, $sdk_url, [], null, true );

            // Namespace-Attribut anhängen — entspricht dem Standalone-Verhalten
            // (siehe booking.ejs:75: data-namespace="paypal_sdk")
            add_filter( 'script_loader_tag', function ( $tag, $handle ) {
                if ( $handle === self::PAYPAL_HANDLE ) {
                    $tag = str_replace( ' src=', ' data-namespace="paypal_sdk" src=', $tag );
                }
                return $tag;
            }, 10, 2 );
        }
    }

    /**
     * Wandelt einen relativen Asset-Pfad ('js/state.js') in eine absolute URL um.
     * Erlaubt auch absolute URLs in der Backend-Config (z.B. CDN).
     */
    private function resolve_url( string $api_base, string $rel_path ): string {
        if ( preg_match( '#^https?://#i', $rel_path ) ) {
            return $rel_path;
        }
        return $api_base . '/' . ltrim( $rel_path, '/' );
    }
}
