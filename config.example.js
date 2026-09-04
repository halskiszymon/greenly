// Copy to config.js and fill in. config.js is gitignored — never commit it.
export default {
  // Single shared password for the app UI. Token = sha256("greenly|" + password).
  password: '',

  // Pl@ntNet API key (my.plantnet.org → Settings). Free tier: 500 requests/day.
  // Leave empty to disable photo identification — manual name entry still works.
  plantnetApiKey: '',
  // Language for common names returned by Pl@ntNet. Falls back to "en" if rejected.
  plantnetLang: 'pl',

  // VAPID keys for web push. Generate with: node genkeys.js
  vapid: {
    subject: 'mailto:you@example.com',
    publicKey: '',
    privateKey: '',
  },

  // Shared secret for triggering the daily reminder over HTTP
  // (GET /api/cron?secret=...) when CLI cron is not available. Leave empty to disable.
  cronSecret: '',

  // Public URL of the app; opened when a push notification is tapped.
  appUrl: 'https://plants.example.com/',

  // Used for "today" in watering math and for the cron cutoff.
  timezone: 'Europe/Warsaw',

  // Local port. Under Plesk/Passenger the PORT env var takes precedence.
  port: 8080,
};
