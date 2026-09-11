module.exports = {
  apps: [{
    name: 'bermuda-epass',
    script: '/var/www/bermuda-epass/server.js',
    cwd: '/var/www/bermuda-epass',
    env: {
      PORT: 3040, PAYPAL_CLIENT_ID: 'AecaBlDFvV72uBbQcW6HA-KNb4N-VpGHEjnu6GmKFeR57cIUbkPH6YqnqN8aR0zuVGyqlY5MIo2GT4bq', PAYPAL_CLIENT_SECRET: 'EMgifFohbv0PaDwal5FxwbjvPPEyyyyPb7C9iC4jBMKggBWW2sEp2FkjLtLPy2X0vIJuiLf91yK_6TPA', PAYPAL_MODE: 'live', APP_URL: 'https://bermudaepass.com',
      ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY,
    }
  }]
};
