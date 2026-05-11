/**
 * Tailwind-Config für den Embed-Build (WordPress-Plugin).
 *
 * Unterschiede zum Standalone-Build:
 *  - important: '.spoxhub-booking'  → alle Utilities sind unter .spoxhub-booking gescoped,
 *                                     keine Kollision mit WP-Theme.
 *  - corePlugins.preflight: false   → kein globaler Reset (würde body/h1/ul vom WP-Theme
 *                                     überschreiben). Wir resetten manuell innerhalb
 *                                     des Wrappers via embed-reset.css.
 *
 * Build:  npx tailwindcss -c tailwind.embed.config.js \
 *           -i ./src/input.embed.css \
 *           -o ./public/css/output.embed.css --minify
 */
const baseConfig = require('./tailwind.config.js');

module.exports = {
  ...baseConfig,
  important: '.spoxhub-booking',
  corePlugins: {
    ...(baseConfig.corePlugins || {}),
    preflight: false,
  },
  content: [
    './src/views/**/*.ejs',
    './public/**/*.html',
  ],
};
