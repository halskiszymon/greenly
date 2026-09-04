// genkeys.js — prints a fresh VAPID key pair to paste into config.js.
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log('Paste into config.js:\n');
console.log(`  vapid: {
    subject: 'mailto:you@example.com',
    publicKey: '${publicKey}',
    privateKey: '${privateKey}',
  },`);
