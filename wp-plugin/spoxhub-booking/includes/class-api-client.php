<?php
/**
 * Wrapper um wp_remote_get() für Calls gegen das spoxhub-Backend.
 * Caches /embed/config und /embed/markup über WP-Transients (5 Min).
 *
 * @package SpoxHubBooking
 */

namespace SpoxHub\Booking;

if ( ! defined( 'ABSPATH' ) ) { exit; }

class Api_Client {

    const CACHE_TTL = 300; // 5 Minuten — Markup/Config ändern sich selten

    /**
     * "Public" API-Base — diese URL wird in den Browser geschickt
     * (Asset-URLs für wp_enqueue_*, window.SPOXHUB_API_BASE im JS-Bootstrap).
     * In Production: identisch mit api_base_internal().
     */
    public function api_base(): string {
        $base = get_option( 'spoxhub_booking_api_base', SPOXHUB_BOOKING_DEFAULT_API_BASE );
        return untrailingslashit( $base );
    }

    /**
     * "Internal" API-Base — wird für serverseitige wp_remote_get-Calls genutzt
     * (z.B. /embed/markup, /embed/config, /embed/version).
     * Falls leer: fällt auf api_base() zurück.
     *
     * Sinn: Im Docker-Dev-Setup zeigt Public auf 'http://localhost:3001'
     * (Browser-erreichbar), Internal auf 'http://host.docker.internal:3001'
     * (Container-erreichbar). In Prod identisch.
     */
    public function api_base_internal(): string {
        $internal = (string) get_option( 'spoxhub_booking_api_base_internal', '' );
        if ( '' === trim( $internal ) ) {
            return $this->api_base();
        }
        return untrailingslashit( $internal );
    }

    /** Optionaler Shared-Secret für X-Plugin-Key-Header */
    public function api_key(): string {
        return (string) get_option( 'spoxhub_booking_api_key', '' );
    }

    /**
     * Holt /embed/config (gecached).
     * @return array|\WP_Error
     */
    public function get_config( bool $force_refresh = false ) {
        $cache_key = 'spoxhub_booking_config';
        if ( ! $force_refresh ) {
            $cached = get_transient( $cache_key );
            if ( false !== $cached ) {
                return $cached;
            }
        }

        $res = $this->request( '/embed/config' );
        if ( is_wp_error( $res ) ) {
            return $res;
        }
        $body = json_decode( wp_remote_retrieve_body( $res ), true );
        if ( ! is_array( $body ) ) {
            return new \WP_Error( 'spoxhub_invalid_config', 'Ungültige Config-Antwort vom Backend.' );
        }
        set_transient( $cache_key, $body, self::CACHE_TTL );
        return $body;
    }

    /**
     * Holt /embed/markup (gecached).
     * @return string|\WP_Error
     */
    public function get_markup( bool $force_refresh = false ) {
        $cache_key = 'spoxhub_booking_markup';
        if ( ! $force_refresh ) {
            $cached = get_transient( $cache_key );
            if ( false !== $cached ) {
                return $cached;
            }
        }

        $res = $this->request( '/embed/markup' );
        if ( is_wp_error( $res ) ) {
            return $res;
        }
        $body = wp_remote_retrieve_body( $res );
        if ( empty( $body ) ) {
            return new \WP_Error( 'spoxhub_empty_markup', 'Leere Markup-Antwort vom Backend.' );
        }
        set_transient( $cache_key, $body, self::CACHE_TTL );
        return $body;
    }

    /**
     * Healthcheck — wird von der Settings-Page aufgerufen.
     * @return array|\WP_Error
     */
    public function ping() {
        $res = $this->request( '/embed/version', 5 );
        if ( is_wp_error( $res ) ) {
            return $res;
        }
        $body = json_decode( wp_remote_retrieve_body( $res ), true );
        if ( ! is_array( $body ) || empty( $body['ok'] ) ) {
            return new \WP_Error( 'spoxhub_bad_ping', 'Backend antwortet, aber unerwartetes Format.' );
        }
        return $body;
    }

    /** Cache invalidieren — von Settings-Save-Hook getriggert */
    public function flush_cache(): void {
        delete_transient( 'spoxhub_booking_config' );
        delete_transient( 'spoxhub_booking_markup' );
    }

    /**
     * Interner HTTP-Request.
     * @param string $path z.B. '/embed/config'
     * @param int    $timeout Sekunden
     * @return array|\WP_Error
     */
    private function request( string $path, int $timeout = 8 ) {
        // Server-seitig immer die interne URL nutzen — entscheidend für Docker
        $url  = $this->api_base_internal() . $path;
        $args = [
            'timeout' => $timeout,
            'headers' => [
                'Accept'     => $path === '/embed/markup' ? 'text/html' : 'application/json',
                'User-Agent' => 'SpoxHub-Booking-WP/' . SPOXHUB_BOOKING_VERSION,
            ],
        ];
        $key = $this->api_key();
        if ( ! empty( $key ) ) {
            $args['headers']['X-Plugin-Key'] = $key;
        }

        $res = wp_remote_get( $url, $args );
        if ( is_wp_error( $res ) ) {
            return $res;
        }
        $code = wp_remote_retrieve_response_code( $res );
        if ( $code < 200 || $code >= 300 ) {
            return new \WP_Error(
                'spoxhub_http_' . $code,
                sprintf( 'HTTP %d von %s', $code, esc_url_raw( $url ) )
            );
        }
        return $res;
    }
}
