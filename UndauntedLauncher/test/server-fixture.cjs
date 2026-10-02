'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const stage = process.env.UNDAUNTED_TEST_STAGE;
if (!stage || !path.resolve(stage).startsWith(path.resolve(__dirname, '../../artifacts') + path.sep)) {
  throw new Error('The smoke test must use a staged backend under artifacts.');
}
process.env.AUTH_MODE = 'APIKEY'; process.env.REGISTRATION_MODE = 'OPEN'; process.env.LOG_LEVEL = 'silent';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(keys.privateKey).toString('base64');
process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(keys.publicKey).toString('base64');
const context = require(path.join(stage, 'test/harness.js')).CreateDisposableDatabase();
const { app } = require(path.join(stage, 'dist/app.js'));
const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('message', message => {
  if (message === 'close') server.close(() => { context.Cleanup(); process.exit(0); });
});
