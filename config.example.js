// Copy to config.js and fill in. config.js is gitignored — never commit it.
export default {
  // Password of the first account. On the first start the app creates this user (see adminLogin)
  // and assigns every existing plant to it. Later password changes happen in the app, not here.
  password: '',
  // Login of that first account.
  adminLogin: 'admin',
  // Code new users must enter to register. Leave empty to disable registration.
  inviteCode: '',
  // Secret used to encrypt users' Anthropic keys in the database. Optional: when empty the app
  // generates one into data/secret.key on first start. Changing it later makes stored keys unreadable.
  secretKey: '',

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

  // Anthropic keys are per user and set in the app (account settings). This one is only copied to
  // the first account when it is created on the first start; afterwards it is ignored.
  anthropicApiKey: '',
  // Defaults for new accounts (each user can change them in the app).
  // Model: 'claude-opus-5' or the cheaper 'claude-sonnet-5'. Effort: 'low' | 'medium' | 'high'.
  anthropicModel: 'claude-opus-5',
  anthropicEffort: 'medium',

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
