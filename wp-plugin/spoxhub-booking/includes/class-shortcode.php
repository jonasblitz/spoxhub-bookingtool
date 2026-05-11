<?php
/**
 * Shortcode [spoxhub_booking] — rendert den Wizard.
 *
 *   [spoxhub_booking]                          — Standard
 *   [spoxhub_booking refresh="1"]              — Cache-Bypass (Debug)
 *
 * @package SpoxHubBooking
 */

namespace SpoxHub\Booking;

if ( ! defined( 'ABSPATH' ) ) { exit; }

class Shortcode {

    /** @var Api_Client */
    private $api;

    /** @var Asset_Loader */
    private $assets;

    public function __construct( Api_Client $api, Asset_Loader $assets ) {
        $this->api    = $api;
        $this->assets = $assets;
    }

    public function register(): void {
        add_shortcode( 'spoxhub_booking', [ $this, 'render' ] );
    }

    public function render( $atts = [], $content = null ): string {
        $atts = shortcode_atts(
            [
                'refresh' => '0', // "1" → Cache umgehen (für Debug)
            ],
            $atts,
            'spoxhub_booking'
        );

        $force = ( '1' === (string) $atts['refresh'] );
        $markup = $this->api->get_markup( $force );

        if ( is_wp_error( $markup ) ) {
            return $this->render_error( $markup );
        }

        // Assets erst jetzt enqueuen — wir wissen, dass der Shortcode tatsächlich rendert
        $this->assets->enqueue();

        // Markup ist HTML-Fragment vom Backend (bereits in <div class="spoxhub-booking">…</div> gewrappt).
        // Kein zusätzliches Wrapping nötig. Das Markup ist trusted (eigenes Backend),
        // daher KEIN wp_kses() — würde Attribute wie data-step zerstören.
        return (string) $markup;
    }

    /**
     * Fehler-UI für Admins. Frontend-User sehen einen schlanken Hinweis.
     */
    private function render_error( \WP_Error $error ): string {
        $is_admin = current_user_can( 'manage_options' );
        $msg      = esc_html( $error->get_error_message() );

        if ( $is_admin ) {
            return sprintf(
                '<div class="notice notice-error" style="padding:16px;border-left:4px solid #d63638;background:#fff;">' .
                '<p><strong>SpoxHub Booking:</strong> Backend nicht erreichbar.</p>' .
                '<p><code>%s</code></p>' .
                '<p>Prüfe die <a href="%s">Plugin-Einstellungen</a> oder ob das Backend auf <code>%s</code> läuft.</p>' .
                '</div>',
                $msg,
                esc_url( admin_url( 'options-general.php?page=spoxhub-booking' ) ),
                esc_html( $this->api->api_base() )
            );
        }

        // Frontend-User
        return '<div style="padding:24px;text-align:center;color:#666;">'
             . esc_html__( 'Das Buchungstool ist gerade nicht erreichbar. Bitte versuche es in wenigen Minuten erneut.', 'spoxhub-booking' )
             . '</div>';
    }
}
