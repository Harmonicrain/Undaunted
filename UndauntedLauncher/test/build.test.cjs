'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {serverOrigin,loadConfig}=require('../scripts/lib/config.cjs');
const {installerGuid,nsisString}=require('../scripts/package-release.cjs');
const {compareVersions,trustedConfig,signManifest,verifyManifest}=require('../scripts/lib/update-feed.cjs');
const {publishRelease}=require('../scripts/publish-updates.cjs');
test('server origins refuse credentials, path injection and public plaintext',()=>{
 for(const value of ['https://example.org','http://127.0.0.1:61000','http://100.75.1.2:61000','http://[::1]:61000'])assert.equal(serverOrigin(value),new URL(value).origin);
 for(const value of ['http://example.org','https://user:password@example.org','https://example.org/path','https://example.org/?key=value','https://example.org/#fragment','file:///tmp/test'])assert.throws(()=>serverOrigin(value));
});
test('local resource paths resolve against the selected configuration',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'undaunted-config-'));
 const previous=process.env.UNDAUNTED_LAUNCHER_CONFIG;
 try {
  const file=path.join(directory,'launcher.json');await fs.writeFile(file,JSON.stringify({assetsDirectory:'art',keyFile:'private/key.pem',publishDir:'feed'}));
  process.env.UNDAUNTED_LAUNCHER_CONFIG=file;
  const config=await loadConfig();assert.equal(config.assetsDirectory,path.join(directory,'art'));assert.equal(config.keyFile,path.join(directory,'private/key.pem'));assert.equal(config.publishDir,path.join(directory,'feed'));
 } finally {if(previous===undefined)delete process.env.UNDAUNTED_LAUNCHER_CONFIG;else process.env.UNDAUNTED_LAUNCHER_CONFIG=previous;await fs.rm(directory,{recursive:true,force:true});}
});
test('NSIS metadata escapes variable syntax and rejects instruction injection',()=>{
 assert.equal(nsisString('folder/$name'),'folder/$$name');
 for(const value of ['name"','line\nnext','line\rnext',null])assert.throws(()=>nsisString(value));
 // Recorded from the original installer's builder; must never change for updates.
 assert.equal(installerGuid('community.undaunted.launcher112'),'c46991b8-1312-51b0-833a-f3ec26feeb9d');
});
test('stable versions order numerically and reject ambiguous releases',()=>{
 assert.equal(compareVersions('1.0.10','1.0.9'),1);assert.equal(compareVersions('1.0.8','1.0.8'),0);assert.equal(compareVersions('1.0.8','2.0.0'),-1);
 for(const value of ['01.0.8','1.0.8-beta','1.0','1.0.9007199254740992'])assert.throws(()=>compareVersions(value,'1.0.8'));
});
test('signed publication refuses tampering, mismatched keys, downgrades and version reuse',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'undaunted-feed-'));
 const keys=crypto.generateKeyPairSync('ed25519'),other=crypto.generateKeyPairSync('ed25519');
 const config=trustedConfig({url:'https://updates.example.org/launcher/',requiresTailscale:false,publicKey:keys.publicKey.export({type:'spki',format:'pem'})});
 assert.throws(()=>trustedConfig({...config,publicKey:keys.privateKey.export({type:'pkcs8',format:'pem'})}),/only the public/);
 const keyFile=path.join(directory,'key.pem'),output=path.join(directory,'feed');
 try {
  await fs.writeFile(keyFile,keys.privateKey.export({type:'pkcs8',format:'pem'}));
  const installer=path.join(directory,'Undaunted-Launcher-1.0.8-Setup.exe');await fs.writeFile(installer,'synthetic installer');
  await publishRelease({installer,version:'1.0.8',output,config,keyFile});
  const good=JSON.parse(await fs.readFile(path.join(output,'latest.json'),'utf8'));assert.equal(verifyManifest(good,config).version,'1.0.8');
  assert.throws(()=>verifyManifest({...good,signature:'A'.repeat(86)+'=='},config));
  const payload=JSON.parse(Buffer.from(good.payload,'base64'));payload.appId='different.app';assert.throws(()=>verifyManifest(signManifest(payload,keys.privateKey),config));
  const badKey=path.join(directory,'other.pem');await fs.writeFile(badKey,other.privateKey.export({type:'pkcs8',format:'pem'}));await assert.rejects(publishRelease({installer,version:'1.0.8',output,config,keyFile:badKey}));
  const older=path.join(directory,'Undaunted-Launcher-1.0.7-Setup.exe');await fs.writeFile(older,'old');await assert.rejects(publishRelease({installer:older,version:'1.0.7',output,config,keyFile}),/older version/);
  await fs.writeFile(installer,'changed installer');await assert.rejects(publishRelease({installer,version:'1.0.8',output,config,keyFile}),/Increment the version/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output,'latest.json'),'utf8')),good);
  await assert.rejects(publishRelease({installer,version:'1.0.8',output:directory,config,keyFile}),/public folder/);
 } finally {await fs.rm(directory,{recursive:true,force:true});}
});
