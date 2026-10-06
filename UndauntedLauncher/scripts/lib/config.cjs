'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
async function loadConfig() {
 const file=path.resolve(process.env.UNDAUNTED_LAUNCHER_CONFIG || path.join(root,'launcher.local.json'));
 let config={};try {config=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('Invalid local launcher configuration.');}
 const resolve=value=>value?path.resolve(path.dirname(file),value):undefined;
 const tool=value=>/[\\/]/.test(value)?resolve(value):value;
 return {...config,server:process.env.UNDAUNTED_LAUNCHER_SERVER||config.server,
  gameDirectory:resolve(process.env.UNDAUNTED112_GAME_DIR||config.gameDirectory),
  assetsDirectory:resolve(process.env.UNDAUNTED_LAUNCHER_ASSETS||config.assetsDirectory||'assets/art'),
  nsisCompiler:tool(process.env.UNDAUNTED_NSIS_COMPILER||config.nsisCompiler||'makensis.exe'),
  openssl:tool(process.env.UNDAUNTED_OPENSSL||config.openssl||'openssl.exe'),
  keyFile:resolve(config.keyFile),publishDir:resolve(config.publishDir),legacyElectronSource:resolve(process.env.UNDAUNTED_LEGACY_LAUNCHER_SOURCE||config.legacyElectronSource)};
}
function serverOrigin(value) {
 let url;try{url=new URL(value);}catch{throw new Error('Configure the launcher server address.');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Invalid launcher server address.');
 const host=url.hostname,parts=host.split('.').map(Number);
 const privateHost=host==='localhost'||host==='[::1]'||(parts.length===4&&parts.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&
  (parts[0]===127||parts[0]===10||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168)||(parts[0]===100&&parts[1]>=64&&parts[1]<=127)));
 if(url.protocol==='http:'&&!privateHost)throw new Error('Public launcher servers require HTTPS.');
 return url.origin;
}
module.exports={loadConfig,serverOrigin,root};
