<?php
/**
 * Plugin-Orchestrator (Singleton).
 * Initialisiert die anderen Klassen und hängt sie in WordPress-Hooks ein.
 *
 * @package SpoxHubBooking
 */

namespace SpoxHub\Booking;

if ( ! defined( 'ABSPATH' ) ) { exit; }

class Plugin {

    /** @var Plugin|null */
    private static $instance = null;

    /** @var Api_Client */
    public $api;

    /** @var Settings */
    public $settings;

    /** @var Asset_Loader */
    public $assets;

    /** @var Shortcode */
    public $shortcode;

    public static function instance() {
        if ( null === self::$instance ) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        $this->api       = new Api_Client();
        $this->settings  = new Settings( $this->api );
        $this->assets    = new Asset_Loader( $this->api );
        $this->shortcode = new Shortcode( $this->api, $this->assets );

        $this->settings->register();
        $this->assets->register();
        $this->shortcode->register();
    }
}
