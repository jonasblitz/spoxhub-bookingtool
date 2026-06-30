<?php
/**
 * Plugin Name:       SpoxHub Booking
 * Plugin URI:        https://spoxhub.io/
 * Description:       Bindet das SpoxHub Fahrrad-Service-Buchungstool als Shortcode [spoxhub_booking] in WordPress ein. Backend läuft auf spoxhub.io, dieses Plugin ist nur die Frontend-Hülle.
 * Version:           1.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            SpoxHub
 * Author URI:        https://spoxhub.io/
 * License:           Proprietary
 * Text Domain:       spoxhub-booking
 *
 * @package SpoxHubBooking
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit; // Direkter Aufruf verboten.
}

// ─── Konstanten ─────────────────────────────────────────────────────────
define( 'SPOXHUB_BOOKING_VERSION', '1.1.0' );
define( 'SPOXHUB_BOOKING_FILE',    __FILE__ );
define( 'SPOXHUB_BOOKING_DIR',     plugin_dir_path( __FILE__ ) );
define( 'SPOXHUB_BOOKING_URL',     plugin_dir_url( __FILE__ ) );
define( 'SPOXHUB_BOOKING_DEFAULT_API_BASE', 'https://spoxhub.io/booking' );

// ─── Includes ───────────────────────────────────────────────────────────
require_once SPOXHUB_BOOKING_DIR . 'includes/class-api-client.php';
require_once SPOXHUB_BOOKING_DIR . 'includes/class-settings.php';
require_once SPOXHUB_BOOKING_DIR . 'includes/class-asset-loader.php';
require_once SPOXHUB_BOOKING_DIR . 'includes/class-shortcode.php';
require_once SPOXHUB_BOOKING_DIR . 'includes/class-plugin.php';

// ─── Bootstrap ──────────────────────────────────────────────────────────
add_action( 'plugins_loaded', [ \SpoxHub\Booking\Plugin::class, 'instance' ] );

// ─── Activation / Deactivation ──────────────────────────────────────────
register_activation_hook( __FILE__, function () {
    // Beim Aktivieren: Default-Optionen setzen, falls noch nicht vorhanden
    if ( false === get_option( 'spoxhub_booking_api_base' ) ) {
        update_option( 'spoxhub_booking_api_base', SPOXHUB_BOOKING_DEFAULT_API_BASE );
    }
} );

register_deactivation_hook( __FILE__, function () {
    // Caches löschen, damit nach Re-Aktivierung frische Config geladen wird
    delete_transient( 'spoxhub_booking_config' );
    delete_transient( 'spoxhub_booking_markup' );
} );
