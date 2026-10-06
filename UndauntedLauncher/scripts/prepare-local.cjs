'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {root,loadConfig,serverOrigin}=require('./lib/config.cjs');
const {trustedConfig}=require('./lib/update-feed.cjs');
async function testIcon(file) {
 const dibSize=40+32*32*4+128,bytes=Buffer.alloc(22+dibSize);
 bytes.writeUInt16LE(1,2);bytes.writeUInt16LE(1,4);bytes[6]=32;bytes[7]=32;
 bytes.writeUInt16LE(1,10);bytes.writeUInt16LE(32,12);bytes.writeUInt32LE(dibSize,14);bytes.writeUInt32LE(22,18);
 bytes.writeUInt32LE(40,22);bytes.writeInt32LE(32,26);bytes.writeInt32LE(64,30);bytes.writeUInt16LE(1,34);bytes.writeUInt16LE(32,36);
 for(let i=62;i<62+4096;i+=4){bytes[i]=160;bytes[i+1]=90;bytes[i+2]=40;bytes[i+3]=255;}
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);
}
async function prepare({testAssets=false}={}) {
 const config=await loadConfig(),ui=path.join(root,'ui'),resources=path.join(root,'resources');
 await fs.mkdir(ui,{recursive:true});await fs.mkdir(resources,{recursive:true});
 for(const name of ['index.html','style.css','renderer.js','bridge.js','icons'])await fs.cp(path.join(root,'frontend',name),path.join(ui,name),{recursive:true});
 if(testAssets){await testIcon(path.join(ui,'art/icon.ico'));}
 else {
  if(!(await fs.stat(path.join(config.assetsDirectory,'icon.ico')).catch(()=>null)))throw new Error('Extract your game artwork first; configure assetsDirectory or run scripts/extract-art.py.');
  await fs.cp(config.assetsDirectory,path.join(ui,'art'),{recursive:true});
  let game=config.gameDirectory;
  if(!game){try{game=JSON.parse(await fs.readFile(path.join(root,'../tools/local112.json'),'utf8')).gameDirectory;}catch{}}
  if(!game)throw new Error('Configure gameDirectory or UNDAUNTED112_GAME_DIR to bundle the runtime.');
  const candidates=[game,path.join(game,'Archon/Binaries/Win64'),path.join(game,'Dauntless/Archon/Binaries/Win64')];
  const pinned=JSON.parse(await fs.readFile(path.join(root,'../tools/client112.json'),'utf8'));
  let folder;
  for(const candidate of candidates){if(await fs.stat(path.join(candidate,pinned.executable)).catch(()=>null)){folder=candidate;break;}}
  if(!folder)throw new Error('Could not locate the pinned game executable.');
  const executableHash=crypto.createHash('sha256');
  for await(const chunk of require('node:fs').createReadStream(path.join(folder,pinned.executable)))executableHash.update(chunk);
  if(executableHash.digest('hex').toLowerCase()!==pinned.sha256.toLowerCase())throw new Error('This is not the supported Dauntless build.');
  const files={};
  for(const name of ['winmm.dll','UndauntedInternalServer.dll']) {
   const bytes=await fs.readFile(path.join(folder,name));
   files[name]=crypto.createHash('sha256').update(bytes).digest('hex');await fs.writeFile(path.join(resources,name),bytes);
  }
  await fs.writeFile(path.join(resources,'runtime.json'),JSON.stringify({gameVersion:pinned.version,files},null,2));
 }
 await fs.writeFile(path.join(resources,'server.json'),JSON.stringify({server:serverOrigin(testAssets?'http://127.0.0.1:9':config.server)},null,2));
 if(!testAssets&&config.updateFeed)await fs.writeFile(path.join(resources,'updates.json'),JSON.stringify(trustedConfig(config.updateFeed),null,2));
 else await fs.rm(path.join(resources,'updates.json'),{force:true});
 console.log(testAssets?'Prepared generated test assets; game assets are not required.':'Prepared configured launcher assets and verified runtime files.');
}
module.exports={prepare};
if(require.main===module)prepare({testAssets:process.argv.includes('--test-assets')}).catch(error=>{console.error(error.message);process.exitCode=1;});
