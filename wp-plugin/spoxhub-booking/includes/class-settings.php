<?php
/**
 * Settings-Page: Einstellungen → SpoxHub Booking
 *
 *   - API-Base-URL    (default https://spoxhub.io/booking)
 *   - API-Key         (X-Plugin-Key, optional)
 *   - "Verbindung testen"-Button → AJAX gegen /embed/version
 *   - "Cache leeren"-Button
 *
 * @package SpoxHubBooking
 */

namespace SpoxHub\Booking;

if ( ! defined( 'ABSPATH' ) ) { exit; }

class Settings {

    const OPTION_GROUP   = 'spoxhub_booking_options';
    const PAGE_SLUG      = 'spoxhub-booking';
    const NONCE_ACTION   = 'spoxhub_booking_admin';
    const AJAX_PING      = 'spoxhub_booking_ping';
    const AJAX_FLUSH     = 'spoxhub_booking_flush';

    /** @var Api_Client */
    private $api;

    public function __construct( Api_Client $api ) {
        $this->api = $api;
    }

    public function register(): void {
        add_action( 'admin_init',                       [ $this, 'register_settings' ] );
        add_action( 'admin_menu',                       [ $this, 'add_menu' ] );
        add_action( 'wp_ajax_' . self::AJAX_PING,       [ $this, 'ajax_ping' ] );
        add_action( 'wp_ajax_' . self::AJAX_FLUSH,      [ $this, 'ajax_flush' ] );
        // Cache invalidieren, sobald Settings gespeichert werden
        add_action( 'update_option_spoxhub_booking_api_base',           [ $this->api, 'flush_cache' ] );
        add_action( 'update_option_spoxhub_booking_api_base_internal',  [ $this->api, 'flush_cache' ] );
        add_action( 'update_option_spoxhub_booking_api_key',            [ $this->api, 'flush_cache' ] );
    }

    public function register_settings(): void {
        register_setting( self::OPTION_GROUP, 'spoxhub_booking_api_base', [
            'type'              => 'string',
            'sanitize_callback' => function ( $val ) {
                $val = trim( (string) $val );
                if ( '' === $val ) {
                    return SPOXHUB_BOOKING_DEFAULT_API_BASE;
                }
                return esc_url_raw( untrailingslashit( $val ) );
            },
            'default'           => SPOXHUB_BOOKING_DEFAULT_API_BASE,
        ] );

        register_setting( self::OPTION_GROUP, 'spoxhub_booking_api_base_internal', [
            'type'              => 'string',
            'sanitize_callback' => function ( $val ) {
                $val = trim( (string) $val );
                if ( '' === $val ) {
                    return ''; // leer = Public-URL nutzen
                }
                return esc_url_raw( untrailingslashit( $val ) );
            },
            'default'           => '',
        ] );

        register_setting( self::OPTION_GROUP, 'spoxhub_booking_api_key', [
            'type'              => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default'           => '',
        ] );

        add_settings_section(
            'spoxhub_booking_section_main',
            __( 'Backend-Verbindung', 'spoxhub-booking' ),
            function () {
                echo '<p>' . esc_html__( 'Das Plugin lädt Markup, CSS und Scripts vom konfigurierten Backend. Stelle sicher, dass die Domain dieser WP-Installation in der spoxhub-Whitelist (.env: PLUGIN_ORIGINS) eingetragen ist.', 'spoxhub-booking' ) . '</p>';
            },
            self::PAGE_SLUG
        );

        add_settings_field(
            'spoxhub_booking_api_base',
            __( 'API-Base-URL', 'spoxhub-booking' ),
            [ $this, 'field_api_base' ],
            self::PAGE_SLUG,
            'spoxhub_booking_section_main'
        );

        add_settings_field(
            'spoxhub_booking_api_base_internal',
            __( 'Interne API-URL (Docker-Dev only)', 'spoxhub-booking' ),
            [ $this, 'field_api_base_internal' ],
            self::PAGE_SLUG,
            'spoxhub_booking_section_main'
        );

        add_settings_field(
            'spoxhub_booking_api_key',
            __( 'API-Key (optional)', 'spoxhub-booking' ),
            [ $this, 'field_api_key' ],
            self::PAGE_SLUG,
            'spoxhub_booking_section_main'
        );
    }

    public function add_menu(): void {
        add_options_page(
            __( 'SpoxHub Booking', 'spoxhub-booking' ),
            __( 'SpoxHub Booking', 'spoxhub-booking' ),
            'manage_options',
            self::PAGE_SLUG,
            [ $this, 'render_page' ]
        );
    }

    // ─── Field Renderer ─────────────────────────────────────────────────

    public function field_api_base(): void {
        $value = esc_attr( get_option( 'spoxhub_booking_api_base', SPOXHUB_BOOKING_DEFAULT_API_BASE ) );
        printf(
            '<input type="url" name="spoxhub_booking_api_base" value="%s" class="regular-text" placeholder="%s" />',
            $value,
            esc_attr( SPOXHUB_BOOKING_DEFAULT_API_BASE )
        );
        echo '<p class="description">' . esc_html__( 'Ohne abschließenden Slash. Beispiel: https://spoxhub.io/booking', 'spoxhub-booking' ) . '</p>';
    }

    public function field_api_base_internal(): void {
        $value = esc_attr( get_option( 'spoxhub_booking_api_base_internal', '' ) );
        printf(
            '<input type="url" name="spoxhub_booking_api_base_internal" value="%s" class="regular-text" placeholder="(leer = wie oben)" />',
            $value
        );
        echo '<p class="description">' . esc_html__( 'Nur setzen, wenn WP in Docker läuft und das Backend auf dem Host. Beispiel: http://host.docker.internal:3001 . In Production leer lassen.', 'spoxhub-booking' ) . '</p>';
    }

    public function field_api_key(): void {
        $value = esc_attr( get_option( 'spoxhub_booking_api_key', '' ) );
        printf(
            '<input type="text" name="spoxhub_booking_api_key" value="%s" class="regular-text" autocomplete="off" />',
            $value
        );
        echo '<p class="description">' . esc_html__( 'Wird als X-Plugin-Key-Header gesendet. Leer lassen, wenn das Backend nur per Origin-Whitelist absichert.', 'spoxhub-booking' ) . '</p>';
    }

    // ─── Page Renderer ──────────────────────────────────────────────────

    public function render_page(): void {
        if ( ! current_user_can( 'manage_options' ) ) {
            return;
        }
        ?>
        <div class="wrap">
            <h1><?php esc_html_e( 'SpoxHub Booking', 'spoxhub-booking' ); ?></h1>

            <form method="post" action="options.php">
                <?php
                settings_fields( self::OPTION_GROUP );
                do_settings_sections( self::PAGE_SLUG );
                submit_button();
                ?>
            </form>

            <hr/>

            <h2><?php esc_html_e( 'Diagnose', 'spoxhub-booking' ); ?></h2>
            <p>
                <button type="button" class="button" id="spoxhub-ping">
                    <?php esc_html_e( 'Verbindung testen', 'spoxhub-booking' ); ?>
                </button>
                <button type="button" class="button" id="spoxhub-flush">
                    <?php esc_html_e( 'Cache leeren', 'spoxhub-booking' ); ?>
                </button>
                <span id="spoxhub-ping-result" style="margin-left:12px;"></span>
            </p>

            <h2><?php esc_html_e( 'Verwendung', 'spoxhub-booking' ); ?></h2>
            <p><?php esc_html_e( 'Füge den Wizard mit folgendem Shortcode in eine Seite oder einen Beitrag ein:', 'spoxhub-booking' ); ?></p>
            <p><code>[spoxhub_booking]</code></p>
            <p><?php esc_html_e( 'Bei Layout-Problemen einmalig den Cache leeren:', 'spoxhub-booking' ); ?></p>
            <p><code>[spoxhub_booking refresh="1"]</code></p>

            <script>
            (function () {
                const pingBtn  = document.getElementById('spoxhub-ping');
                const flushBtn = document.getElementById('spoxhub-flush');
                const result   = document.getElementById('spoxhub-ping-result');
                const nonce    = <?php echo wp_json_encode( wp_create_nonce( self::NONCE_ACTION ) ); ?>;

                function call(action, label) {
                    result.innerHTML = '<em><?php echo esc_js( __( 'Lädt…', 'spoxhub-booking' ) ); ?></em>';
                    const body = new URLSearchParams({ action, _ajax_nonce: nonce });
                    fetch(ajaxurl, { method: 'POST', body, credentials: 'same-origin' })
                        .then(r => r.json())
                        .then(json => {
                            if (json.success) {
                                result.innerHTML = '<span style="color:#1a7f37;">✓ ' + label + ': ' + (json.data.msg || 'OK') + '</span>';
                            } else {
                                result.innerHTML = '<span style="color:#cf222e;">✗ ' + (json.data || 'Fehler') + '</span>';
                            }
                        })
                        .catch(err => {
                            result.innerHTML = '<span style="color:#cf222e;">✗ ' + err.message + '</span>';
                        });
                }

                pingBtn.addEventListener('click', () => call(<?php echo wp_json_encode( self::AJAX_PING ); ?>,  '<?php echo esc_js( __( 'Backend erreichbar', 'spoxhub-booking' ) ); ?>'));
                flushBtn.addEventListener('click', () => call(<?php echo wp_json_encode( self::AJAX_FLUSH ); ?>, '<?php echo esc_js( __( 'Cache geleert', 'spoxhub-booking' ) ); ?>'));
            })();
            </script>
        </div>
        <?php
    }

    // ─── AJAX-Handler ───────────────────────────────────────────────────

    public function ajax_ping(): void {
        check_ajax_referer( self::NONCE_ACTION );
        if ( ! current_user_can( 'manage_options' ) ) {
            wp_send_json_error( __( 'Keine Berechtigung.', 'spoxhub-booking' ) );
        }
        $res = $this->api->ping();
        if ( is_wp_error( $res ) ) {
            wp_send_json_error( $res->get_error_message() );
        }
        wp_send_json_success( [
            'msg' => sprintf( '%s (v%s)', $res['name'] ?? '', $res['version'] ?? '?' ),
        ] );
    }

    public function ajax_flush(): void {
        check_ajax_referer( self::NONCE_ACTION );
        if ( ! current_user_can( 'manage_options' ) ) {
            wp_send_json_error( __( 'Keine Berechtigung.', 'spoxhub-booking' ) );
        }
        $this->api->flush_cache();
        wp_send_json_success( [ 'msg' => __( 'OK', 'spoxhub-booking' ) ] );
    }
}
