'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {root,loadConfig}=require('./lib/config.cjs');
async function run(exe,args,cwd,log,env=process.env) {
 const handle=await fs.open(log,'w');
 try {await new Promise((resolve,reject)=>{
  const child=spawn(exe,args,{cwd,env,windowsHide:true,stdio:['ignore',handle.fd,handle.fd],shell:false});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Build check failed; inspect ${path.basename(log)}.`)));
 });} finally {await handle.close();}
}
// Keep the Electron installer's UUID v5 namespace for installed-user compatibility.
// It is an application identity, not a machine path or deployment setting.
function installerGuid(identity) {
 const namespace=Buffer.from('50e065bc313411e69bab38c9862bdaf3','hex');
 const bytes=crypto.createHash('sha1').update(namespace).update(identity).digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
async function bootstrapper() {
 const cache=path.join(root,'packaging-cache');await fs.mkdir(cache,{recursive:true});
 const file=path.join(cache,'MicrosoftEdgeWebview2Setup.exe');
 if(!(await fs.stat(file).catch(()=>null))) {
  const response=await fetch('https://go.microsoft.com/fwlink/p/?LinkId=2124703',{signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error('Could not download the Microsoft WebView2 prerequisite.');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length<100000||bytes.length>10*1024*1024)throw new Error('Invalid WebView2 prerequisite.');
  await fs.writeFile(file,bytes);
 }
 await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1'); $signature=Get-AuthenticodeSignature -LiteralPath $env:UNDAUNTED_WEBVIEW_BOOTSTRAPPER; if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'WebView2 prerequisite signature is invalid.' }"],root,path.join(cache,'signature.log'),{...process.env,UNDAUNTED_WEBVIEW_BOOTSTRAPPER:file});
 return file;
}
function nsisString(value) {
 if(typeof value!=='string'||/["\r\n]/.test(value))throw new Error('Invalid installer metadata or path.');
 return value.replace(/\$/g,()=> '$$');
}
async function packageNative({payload,version,output,identity,product,runAfterFinish=true}) {
 const config=await loadConfig(),app=JSON.parse(await fs.readFile(path.join(root,'tauri.conf.json'),'utf8'));
 identity=identity||app.identifier;product=product||app.productName;
 if(!/^[\w.-]+$/.test(identity)||!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Invalid installer identity or version.');
 const installer=path.join(output,`Undaunted-Launcher-${version}-Setup.exe`);
 await fs.mkdir(output,{recursive:true});
 const values={APP_ID:identity,APP_GUID:installerGuid(identity),PRODUCT_NAME:product,VERSION:version,
  PAYLOAD_DIR:path.resolve(payload),INSTALLER_FILE:path.resolve(installer),WEBVIEW_BOOTSTRAPPER:await bootstrapper(),
  ICON_FILE:path.join(root,'ui/art/icon.ico'),SIDEBAR_FILE:path.join(root,'ui/art/installer-sidebar.bmp'),RUN_AFTER_FINISH:runAfterFinish?'1':'0',CREATE_SHORTCUTS:identity===app.identifier?'1':'0'};
 const args=['/V2','/WX',...Object.entries(values).map(([key,value])=>`/D${key}=${nsisString(value)}`),path.join(root,'build/installer.nsi')];
 await run(config.nsisCompiler,args,root,path.join(output,'package.log'));
 if((await fs.stat(installer)).size>25*1024*1024)throw new Error('The native installer unexpectedly contains a large payload.');
 return installer;
}
module.exports={packageNative,run,installerGuid,nsisString};
