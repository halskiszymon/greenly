// genkeys.js — prints a fresh VAPID key pair plus random secrets to paste into config.js.
import crypto from 'node:crypto';
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log('Paste into config.js:\n');
console.log(`  vapid: {
    subject: 'mailto:you@example.com',
    publicKey: '${publicKey}',
    privateKey: '${privateKey}',
  },
  inviteCode: '${crypto.randomBytes(6).toString('base64url')}',
  secretKey: '${crypto.randomBytes(32).toString('hex')}',`);
