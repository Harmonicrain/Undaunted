'use strict';
// Real NSIS upgrades, isolated identity/profile/backend/feed/key. Nothing is
// published; TLS test trust and probe commands exist only in copied source.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,fork}=require('node:child_process');
const https=require('node:https'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),repo=path.resolve(root,'..');
const {publishRelease}=require('../scripts/publish-updates.cjs');
const {loadConfig}=require('../scripts/lib/config.cjs');
const {compareVersions}=require('../scripts/lib/update-feed.cjs');
const via=require('../tauri.conf.json').version;
compareVersions(via,via);
const to=via.split('.').map((part,index)=>index===2?String(Number(part)+1):part).join('.');
compareVersions(to,via);
const {packageNative}=require(path.join(root,'scripts/package-release.cjs'));
const identity='community.undaunted.launcher112.rust-upgrade-test',product='Undaunted Rust Upgrade Test';
let artifact,fixture,server,browser,cdp,installed,checkpoint='preparation';
const processes=new Set();
async function run(exe,args,cwd,log,env=process.env) {
 const handle=await fs.open(log,'w');
 const child=spawn(exe,args,{cwd,env,windowsHide:true,stdio:['ignore',handle.fd,handle.fd],shell:false});processes.add(child);
 try {await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Subprocess failed at ${checkpoint}; inspect ${path.basename(log)}.`)));});}
 finally {processes.delete(child);await handle.close();}
}
async function until(read,predicate,timeout=90000) {
 const end=Date.now()+timeout;let last;
 do {try{last=await read();if(predicate(last))return last;}catch{}await new Promise(resolve=>setTimeout(resolve,300));}while(Date.now()<end);
 if(last?.phase)console.error(`Last phase: ${last.phase}: ${last.message}`);
 throw new Error(`Local upgrade timed out at ${checkpoint}.`);
}
async function connect(port) {
 const tabs=await until(async()=>(await fetch(`http://127.0.0.1:${port}/json`)).json(),x=>x.some(t=>t.type==='page'));
 const socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 let id=0;const pending=new Map();
 socket.addEventListener('message',event=>{const r=JSON.parse(event.data),p=pending.get(r.id);if(p){pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(new Error('Test browser failed.')):p.resolve(r.result);}});
 return {close:()=>socket.close(),js:async expression=>{
  const n=++id,r=await new Promise((resolve,reject)=>{pending.set(n,{resolve,reject,timer:setTimeout(()=>reject(new Error('Test browser timed out.')),20000)});socket.send(JSON.stringify({id:n,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});
  if(r.exceptionDetails)throw new Error('Test renderer failed.');return r.result.value;
 }};
}
async function control(version,action,name) {
 await fs.writeFile(path.join(artifact,'control.json'),JSON.stringify({version,action,name,id:String(Date.now())}));
}
async function report(version,predicate) {
 return until(async()=>JSON.parse(await fs.readFile(path.join(artifact,`probe-${version}.json`),'utf8')),predicate);
}
async function main() {
 if(process.platform!=='win32')throw new Error('This installer check requires Windows.');
 const local=await loadConfig(),electron=local.legacyElectronSource;
 if(!electron)throw new Error('Configure legacyElectronSource with an archived Electron checkout and its test dependencies. Only this migration test requires Electron.');
 artifact=process.env.UNDAUNTED_UPGRADE_ARTIFACT || path.join(repo,'artifacts','launcher-rust-installed-update-'+Date.now());
 artifact=path.resolve(artifact);
 if(!artifact.startsWith(path.join(repo,'artifacts')+path.sep)||!path.basename(artifact).startsWith('launcher-rust-installed-update-'))throw new Error('Tests require an isolated artifact directory.');
 await fs.mkdir(artifact,{recursive:true});console.log('Local upgrade artifacts: '+artifact);
 const app=path.join(artifact,'electron-app'),rust=path.join(artifact,'rust-app'),feed=path.join(artifact,'feed');
 const roaming=path.join(artifact,'roaming'),oldProfile=path.join(roaming,'Undaunted Launcher'),newProfile=path.join(artifact,'rust-profile');
 installed=path.join(artifact,'installed launcher');
 for(const dir of [app,rust,feed,oldProfile])await fs.mkdir(dir,{recursive:true});
 const candidates=[];
 for(const name of await fs.readdir(path.join(repo,'artifacts'))){try{const m=JSON.parse((await fs.readFile(path.join(repo,'artifacts',name,'manifest.json'),'utf8')).replace(/^\uFEFF/,''));if(m.testsPassed)candidates.push({name,time:Date.parse(m.createdUtc)});}catch{}}
 candidates.sort((a,b)=>b.time-a.time);
 const stage=process.env.UNDAUNTED_TEST_STAGE || path.join(repo,'artifacts',candidates[0]?.name||'','UndauntedMetagame');
 if(!path.resolve(stage).startsWith(path.join(repo,'artifacts')+path.sep))throw new Error('Disposable backend stage required.');
 fixture=fork(path.join(root,'test/server-fixture.cjs'),[],{cwd:stage,env:{...process.env,UNDAUNTED_TEST_STAGE:stage,NODE_PATH:path.join(repo,'UndauntedMetagame/node_modules')},windowsHide:true,silent:true});
 const backend=await new Promise((resolve,reject)=>{fixture.once('message',resolve);fixture.once('exit',()=>reject(new Error('Disposable backend failed.')));});
 const origin=`http://127.0.0.1:${backend.port}`;
 const cert=path.join(artifact,'test-cert.pem'),tlsKey=path.join(artifact,'test-tls-key.pem');
 const caCert=path.join(artifact,'test-ca.pem'),caKey=path.join(artifact,'test-ca-key.pem');
 const csr=path.join(artifact,'test-server.csr'),extensions=path.join(artifact,'test-server-extensions.txt');
 const openssl=local.openssl;
 checkpoint='test certificate';
 const caConfig=path.join(artifact,'test-ca-config.cnf');
 await fs.writeFile(caConfig,'[req]\ndistinguished_name=req_dn\nx509_extensions=v3_ca\n[req_dn]\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n');
 await run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-config',caConfig,'-keyout',caKey,'-out',caCert,'-days','2','-subj','/CN=Undaunted Disposable Test CA'],artifact,path.join(artifact,'certificate-ca.log'));
 await run(openssl,['req','-new','-newkey','rsa:2048','-nodes','-keyout',tlsKey,'-out',csr,'-subj','/CN=localhost'],artifact,path.join(artifact,'certificate-request.log'));
 await fs.writeFile(extensions,'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n');
 await run(openssl,['x509','-req','-in',csr,'-CA',caCert,'-CAkey',caKey,'-CAcreateserial','-out',cert,'-days','2','-extfile',extensions],artifact,path.join(artifact,'certificate-server.log'));
 await run(openssl,['verify','-CAfile',caCert,'-purpose','sslserver','-verify_hostname','localhost',cert],artifact,path.join(artifact,'certificate-verify.log'));
 server=https.createServer({key:await fs.readFile(tlsKey),cert:await fs.readFile(cert)},async(req,res)=>{
  const name=new URL(req.url,'https://localhost').pathname.slice(1);
  const allowed=new Set(['latest.json',...[via,to].flatMap(version=>[`Undaunted-Launcher-${version}-Setup.exe`,`Undaunted-Launcher-${version}-Setup.exe.blockmap`])]);
  if(!allowed.has(name)){res.writeHead(404);res.end();return;}
  try{const file=path.join(feed,name),stat=await fs.stat(file);res.writeHead(200,{'Content-Length':stat.size,'Cache-Control':'no-store'});require('node:fs').createReadStream(file).pipe(res);}catch{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 await new Promise((resolve,reject)=>{
  https.get(`https://localhost:${server.address().port}/latest.json`,{ca:require('node:fs').readFileSync(caCert)},response=>{response.resume();response.once('end',resolve);}).once('error',reject);
 });
 console.log('Verified local HTTPS certificate chain.');
 const keys=crypto.generateKeyPairSync('ed25519'),keyFile=path.join(artifact,'test-signing-key.pem');
 await fs.writeFile(keyFile,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 const trust={appId:identity,url:`https://localhost:${server.address().port}/`,requiresTailscale:false,publicKey:keys.publicKey.export({type:'spki',format:'pem'})};
 for(const name of ['src','scripts','resources','build','LICENSE.txt','NOTICE.md','ADDITIONAL_TERMS.md'])await fs.cp(path.join(electron,name),path.join(app,name),{recursive:true});
 const modules=path.join(app,'node_modules');
 if((await fs.lstat(modules).catch(()=>null))?.isSymbolicLink())await fs.unlink(modules);
 await fs.cp(path.join(electron,'node_modules'),modules,{recursive:true,dereference:true});
 await fs.writeFile(path.join(app,'resources/updates.json'),JSON.stringify(trust));
 await fs.writeFile(path.join(app,'resources/server.json'),JSON.stringify({server:origin}));
 await fs.writeFile(path.join(oldProfile,'config.json'),JSON.stringify({server:origin,gameDirectory:'kept-test-game-folder',language:'fr'}));
 const debug=require('node:net').createServer();await new Promise(resolve=>debug.listen(0,'127.0.0.1',resolve));const debugPort=debug.address().port;await new Promise(resolve=>debug.close(resolve));
 let main=await fs.readFile(path.join(app,'src/main.cjs'),'utf8');
 main=main.replace("const game = require('./game.cjs');",`const game = require('./game.cjs');\napp.setPath('userData',${JSON.stringify(oldProfile)});\napp.commandLine.appendSwitch('remote-debugging-port','${debugPort}');\napp.commandLine.appendSwitch('ignore-certificate-errors');`)
  .replace('window = await createLauncher();','window = await createLauncher({visible:false});');
 await fs.writeFile(path.join(app,'src/main.cjs'),main);
 const pkg=JSON.parse(await fs.readFile(path.join(electron,'package.json'),'utf8'));
 pkg.name='undaunted-rust-upgrade-test';pkg.productName=product;pkg.version='1.0.6';pkg.build.appId=identity;
 Object.assign(pkg.build.nsis,{runAfterFinish:false,createDesktopShortcut:false,createStartMenuShortcut:false});
 await fs.writeFile(path.join(app,'package.json'),JSON.stringify(pkg,null,2));
 const builder=require.resolve(path.join(electron,'node_modules/electron-builder/out/cli/cli.js'));
 checkpoint='Electron installer build';
 await run(process.execPath,[builder,'--win','--x64','--publish','never','--config.publish.provider=generic',`--config.publish.url=${trust.url}`],app,path.join(artifact,'build-electron.log'));
 console.log('Built isolated Electron 1.0.6 installer.');
 for(const name of ['src','ui','resources','test','Cargo.toml','Cargo.lock','build.rs','tauri.conf.json','CHANGELOG.json','LICENSE.txt','NOTICE.md','ADDITIONAL_TERMS.md'])await fs.cp(path.join(root,name),path.join(rust,name),{recursive:true});
 await fs.copyFile(caCert,path.join(rust,'test-cert.pem'));
 await fs.writeFile(path.join(rust,'resources/updates.json'),JSON.stringify(trust));
 await fs.writeFile(path.join(rust,'resources/server.json'),JSON.stringify({server:origin}));
 let network=await fs.readFile(path.join(rust,'src/network.rs'),'utf8');network=network.replace('reqwest::blocking::Client::builder()','reqwest::blocking::Client::builder().add_root_certificate(reqwest::Certificate::from_pem(include_bytes!("../test-cert.pem")).map_err(|_| "Invalid local TLS certificate.")?)');await fs.writeFile(path.join(rust,'src/network.rs'),network);
 let rustMain=await fs.readFile(path.join(rust,'src/main.rs'),'utf8');
 rustMain=rustMain.replace('mod local_tests;','mod local_tests;\nmod upgrade_probe;')
  .replace('launcher, local_tests::test_step','launcher, local_tests::test_step, upgrade_probe::upgrade_probe')
  .replace('let profile=app.path().app_data_dir()?;',`let profile=PathBuf::from(${JSON.stringify(newProfile)});`)
  .replace('let roaming=std::env::var_os("APPDATA").map(PathBuf::from);',`let roaming=Some(PathBuf::from(${JSON.stringify(roaming)}));`)
  .replace(/let settings=PathBuf::from\(std::env::var_os\("LOCALAPPDATA"\).*?;/,`let settings=PathBuf::from(${JSON.stringify(path.join(artifact,'GameUserSettings.ini'))});`)
  .replaceAll('std::env::var_os("UNDAUNTED_RUST_SMOKE_OPTIONS").is_some()','true')
  .replace('../test/smoke.js','../test/upgrade-smoke.js');
 await fs.writeFile(path.join(rust,'src/main.rs'),rustMain);
 // This command and fixed artifact path exist only in copied test source.
 await fs.writeFile(path.join(rust,'src/upgrade_probe.rs'),`use serde_json::Value;\n#[tauri::command]\npub fn upgrade_probe(app:tauri::AppHandle,window:tauri::WebviewWindow,report:Value)->Result<Value,String>{
 if window.label()!="main" || !window.url().ok().is_some_and(|u|super::trusted_url(&u)){return Err("Invalid test window.".into());}
 if report["close"]==true {app.exit(0);return Ok(Value::Null);}
 let root=std::path::Path::new(${JSON.stringify(artifact)});
 let file=root.join(format!("probe-{}.json",undaunted_launcher::VERSION));
 undaunted_launcher::platform::atomic_write(&file,&serde_json::to_vec(&report).map_err(|_|"Invalid probe.")?).map_err(|_|"Probe write failed.")?;
 Ok(std::fs::read(root.join("control.json")).ok().and_then(|b|serde_json::from_slice(&b).ok()).unwrap_or(Value::Null))
}`);
 let hooks=await fs.readFile(path.join(rust,'src/local_tests.rs'),'utf8');
 const begin=hooks.indexOf('fn directory()'),end=hooks.indexOf('pub fn paths(');
 assert.ok(begin>=0&&end>begin);hooks=hooks.slice(0,begin)+`fn directory()->Result<PathBuf>{Ok(PathBuf::from(${JSON.stringify(artifact)}))}\npub fn isolated()->bool{false}\n`+hooks.slice(end);
 hooks=hooks.replace('"minimum-login",','"minimum-login", "updater-ready", "updater-current",');
 await fs.writeFile(path.join(rust,'src/local_tests.rs'),hooks);
 const tauri=JSON.parse(await fs.readFile(path.join(rust,'tauri.conf.json'),'utf8'));tauri.identifier=identity;tauri.productName=product;tauri.app.windows[0].title=product;
 const cargoTemplate=await fs.readFile(path.join(rust,'Cargo.toml'),'utf8');
 const expectedDll=crypto.createHash('sha256').update(await fs.readFile(path.join(rust,'resources/UndauntedInternalServer.dll'))).digest('hex');
 const runtime=JSON.parse(await fs.readFile(path.join(rust,'resources/runtime.json'),'utf8'));assert.equal(runtime.files['UndauntedInternalServer.dll'],expectedDll);
 assert.ok((await fs.readFile(path.join(rust,'resources/UndauntedInternalServer.dll'))).includes(Buffer.from('Undaunted Private Server Credits','utf16le')),'Credits section is absent from the bundled DLL.');
 const installerFiles={};
 for(const version of [via,to]){
  checkpoint=`Rust ${version} build`;tauri.version=version;await fs.writeFile(path.join(rust,'tauri.conf.json'),JSON.stringify(tauri));
  await fs.writeFile(path.join(rust,'Cargo.toml'),cargoTemplate.replace(/^version = "[^"]+"/m,`version = "${version}"`));
  await run('cargo.exe',['build','--release','--features','local-tests'],rust,path.join(artifact,`build-rust-${version}.log`),{...process.env,CARGO_TARGET_DIR:path.join(root,'target')});
  const payload=path.join(artifact,'payload-'+version);await fs.mkdir(payload,{recursive:true});
  await fs.mkdir(path.join(payload,'resources'),{recursive:true});
  await fs.copyFile(path.join(root,'target/release/undaunted-launcher.exe'),path.join(payload,product+'.exe'));
  await fs.cp(path.join(rust,'resources'),path.join(payload,'launcher'),{recursive:true});
  for(const name of ['LICENSE.txt','NOTICE.md','ADDITIONAL_TERMS.md'])await fs.copyFile(path.join(rust,name),path.join(payload,name));
  checkpoint=`Rust ${version} NSIS packaging`;
  installerFiles[version]=await packageNative({payload,version,output:path.join(artifact,'package-'+version),identity,product,name:'undaunted-rust-upgrade-test',runAfterFinish:false});
  console.log(`Built isolated Rust ${version} installer with credits DLL.`);
 }
 await publishRelease({installer:installerFiles[via],version:via,output:feed,config:trust,keyFile,notes:'Local Electron to Rust upgrade check.'});
 checkpoint='initial installation';
 await run(path.join(app,'release/Undaunted-Launcher-1.0.6-Setup.exe'),['/S',`/D=${installed}`],artifact,path.join(artifact,'install-electron.log'));
 const launchEnv={...process.env,NODE_EXTRA_CA_CERTS:caCert};delete launchEnv.ELECTRON_RUN_AS_NODE;
 browser=spawn(path.join(installed,product+'.exe'),[],{env:launchEnv,windowsHide:true,stdio:'ignore'});
 checkpoint='Electron login';cdp=await connect(debugPort);
 await until(()=>cdp.js('window.launcher.state()'),x=>x?.ok&&x.result.connected);
 const registered=await cdp.js("window.launcher.register({username:'RustUpgradeTest',password:'disposable upgrade test password'})");assert.equal(registered.ok,true);const userId=registered.result.user.userId;
 checkpoint='Electron update download';await until(()=>cdp.js('window.launcher.updateState()'),x=>x?.ok&&x.result.phase==='ready',120000);
 await until(()=>cdp.js("document.getElementById('update-action').disabled"),x=>x===false);
 const oldSession=await fs.readFile(path.join(oldProfile,'session.bin'));assert.equal(oldSession.subarray(0,3).toString(),'v10');
 await cdp.js("document.getElementById('update-action').click()");cdp.close();cdp=undefined;
 checkpoint='Electron to Rust relaunch and profile migration';
 const first=await report(via,x=>x.connected&&x.userId===userId&&x.phase==='current');assert.equal(first.gameDirectory,'kept-test-game-folder');
 assert.equal(JSON.parse(await fs.readFile(path.join(newProfile,'config.json'),'utf8')).language,'fr');
 assert.deepEqual(await fs.readFile(path.join(oldProfile,'session.bin')),oldSession,'Old encrypted profile changed during migration.');
 assert.notEqual((await fs.readFile(path.join(newProfile,'session.bin'))).subarray(0,3).toString(),'v10');
 await assert.rejects(fs.stat(path.join(installed,'resources/app.asar')),'Electron runtime remained installed.');
 assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(installed,'launcher/UndauntedInternalServer.dll'))).digest('hex'),expectedDll);
 console.log('Electron -> Rust passed: real update button, signed HTTPS download, NSIS replacement/relaunch, login/folder/language preserved.');
 // Tampered signed metadata must be refused by the installed Rust updater.
 checkpoint='invalid release signature';const good=await fs.readFile(path.join(feed,'latest.json'));const invalid=JSON.parse(good);invalid.signature='A'.repeat(86)+'==';await fs.writeFile(path.join(feed,'latest.json'),JSON.stringify(invalid));
 await control(via,'check');await report(via,x=>x.phase==='error');await fs.writeFile(path.join(feed,'latest.json'),good);
 await publishRelease({installer:installerFiles[to],version:to,output:feed,config:trust,keyFile,notes:'Local Rust to Rust upgrade check.'});
 checkpoint='Rust download';await control(via,'check');await report(via,x=>x.phase==='available'&&x.updateVersion===to);
 await control(via,'download');await report(via,x=>x.phase==='ready'&&x.button==='Restart to update');
 await control(via,'capture','updater-ready');await until(()=>fs.stat(path.join(artifact,'updater-ready.png')),x=>x.size>0);
 checkpoint='cached installer tamper rejection';
 const cached=path.join(newProfile,'updates/Undaunted-Launcher-'+to+'-Setup.exe');
 const cachedBytes=await fs.readFile(cached);await fs.writeFile(cached,Buffer.alloc(cachedBytes.length));
 await control(via,'install');await report(via,x=>x.phase==='error'&&x.visibleMessage==='The downloaded installer failed verification.');
 await control(via,'check');await report(via,x=>x.phase==='available');
 await control(via,'download');await report(via,x=>x.phase==='ready');
 checkpoint='Rust installer relaunch';await control(via,'install');
 const second=await report(to,x=>x.connected&&x.userId===userId&&x.phase==='current');assert.equal(second.gameDirectory,'kept-test-game-folder');
 assert.equal(JSON.parse(await fs.readFile(path.join(newProfile,'config.json'),'utf8')).language,'fr');
 assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(installed,'launcher/UndauntedInternalServer.dll'))).digest('hex'),expectedDll);
 assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(installed,product+'.exe'))).digest('hex'),crypto.createHash('sha256').update(await fs.readFile(path.join(artifact,'payload-'+to,product+'.exe'))).digest('hex'));
 await control(to,'capture','updater-current');await until(()=>fs.stat(path.join(artifact,'updater-current.png')),x=>x.size>0);
 await fs.writeFile(path.join(artifact,'result.json'),JSON.stringify({passed:true,from:'Electron 1.0.6',via:'Rust '+via,to:'Rust '+to,preservedLogin:true,preservedGameFolder:true,preservedLanguage:true,oldProfileRetained:true,invalidSignatureRejected:true,tamperedInstallerRejected:true,verifiedRedownloadAfterTamper:true,creditsDllSha256:expectedDll,published:false},null,2));
 console.log('Rust -> Rust passed: download/install/relaunch and encrypted session preserved; invalid signature rejected.');
 await control(to,'close');await new Promise(resolve=>setTimeout(resolve,1200));
 const uninstall=(await fs.readdir(installed)).find(x=>/^Uninstall.*\.exe$/.test(x));
 if(uninstall){checkpoint='isolated uninstall';await run(path.join(installed,uninstall),['/S'],artifact,path.join(artifact,'uninstall.log'));}
 console.log('Isolated installation removed; results and screenshots retained in '+artifact);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{
 if(cdp){try{await cdp.js('window.close()');}catch{}cdp.close();}
 if(browser&&browser.exitCode===null)browser.kill();
 if(installed)await run(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',"Get-Process -Name 'Undaunted Rust Upgrade Test' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:UNDAUNTED_TEST_EXE } | Stop-Process -Force"],root,path.join(artifact,'cleanup.log'),{...process.env,UNDAUNTED_TEST_EXE:path.join(installed,product+'.exe')}).catch(()=>{});
 if(installed){
  const uninstaller=(await fs.readdir(installed).catch(()=>[])).find(name=>/^Uninstall.*\.exe$/.test(name));
  if(uninstaller)await run(path.join(installed,uninstaller),['/S'],artifact,path.join(artifact,'cleanup-uninstall.log')).catch(()=>{});
 }
 for(const child of processes)child.kill();
 if(fixture?.connected){fixture.send('close');await new Promise(resolve=>{fixture.once('exit',resolve);setTimeout(resolve,3000);});if(fixture.exitCode===null)fixture.kill();}
 if(server)await new Promise(resolve=>server.close(resolve));
});
