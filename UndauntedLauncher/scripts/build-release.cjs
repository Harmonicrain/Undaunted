'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {packageNative,run}=require('./package-release.cjs');
const root=path.resolve(__dirname,'..'),repo=path.dirname(root);
async function main() {
 const config=JSON.parse(await fs.readFile(path.join(root,'tauri.conf.json'),'utf8'));
 const output=path.join(repo,'artifacts',`launcher-rust-release-${config.version}-${Date.now()}`);
 await fs.mkdir(output,{recursive:true});console.log('Release artifacts: '+output);
 await run(process.execPath,['scripts/prepare-local.cjs'],root,path.join(output,'prepare.log'));
 const unitTests=(await fs.readdir(path.join(root,'test'))).filter(name=>name.endsWith('.test.cjs')).map(name=>'test/'+name);
 await run(process.execPath,['--test',...unitTests],root,path.join(output,'build-tests.log'));
 await run('cargo.exe',['test','--locked','--lib'],root,path.join(output,'unit-tests.log'));
 await run(process.execPath,['test/run-local.cjs'],root,path.join(output,'local-tests.log'));
 await run('cargo.exe',['build','--release','--locked'],root,path.join(output,'build.log'));
 const payload=path.join(output,'payload');await fs.mkdir(path.join(payload,'resources'),{recursive:true});
 await fs.copyFile(path.join(root,'target/release/undaunted-launcher.exe'),path.join(payload,config.productName+'.exe'));
 await fs.cp(path.join(root,'resources'),path.join(payload,'launcher'),{recursive:true});
 for(const name of ['LICENSE.txt','NOTICE.md','ADDITIONAL_TERMS.md','CHANGELOG.md'])await fs.copyFile(path.join(root,name),path.join(payload,name));
 const trust=JSON.parse(await fs.readFile(path.join(root,'resources/updates.json'),'utf8'));
 const sourceName=`Undaunted-Launcher-${config.version}-Source.zip`;
 const source=path.join(output,'source');await fs.mkdir(source,{recursive:true});
 for(const name of ['src','frontend','build','tests','test','scripts','Cargo.toml','Cargo.lock','tauri.conf.json','build.rs','launcher.local.example.json','CHANGELOG.json','CHANGELOG.md','README.md','LICENSE.txt','NOTICE.md','ADDITIONAL_TERMS.md'])await fs.cp(path.join(root,name),path.join(source,'UndauntedLauncher',name),{recursive:true});
 // Include authored runtime source, never the generated game SDK or local settings.
 const runtimeFiles=execFileSync('git.exe',['ls-files','-z'],{cwd:repo,encoding:'utf8',windowsHide:true}).split('\0').filter(name=>name&&!name.startsWith('UndauntedLauncher/'));
 for(const name of runtimeFiles){const destination=path.join(source,name);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(path.join(repo,name),destination);}
 const commit=execFileSync('git.exe',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim();
 const notice=`Corresponding launcher and runtime source: ${trust.url}${sourceName}\r\nBuild instructions: UndauntedLauncher/README.md and tools/Build-Local112.ps1 in the source archive.\r\nRuntime source revision: ${commit}; game-derived SDK and assets must be generated locally.\r\nSee LICENSE.txt, NOTICE.md and ADDITIONAL_TERMS.md for attribution and license terms.\r\n`;
 await fs.writeFile(path.join(payload,'SOURCE.txt'),notice);
 await fs.writeFile(path.join(source,'SOURCE.txt'),notice);
 await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Archive/Microsoft.PowerShell.Archive.psd1'); Compress-Archive -Path (Join-Path $env:UNDAUNTED_RELEASE_SOURCE '*') -DestinationPath $env:UNDAUNTED_RELEASE_SOURCE_ZIP -CompressionLevel Optimal"],root,path.join(output,'source.log'),{...process.env,UNDAUNTED_RELEASE_SOURCE:source,UNDAUNTED_RELEASE_SOURCE_ZIP:path.join(output,sourceName)});
 const runtime=JSON.parse(await fs.readFile(path.join(payload,'launcher/runtime.json'),'utf8'));
 const hashes={};
 for(const [name,expected] of Object.entries(runtime.files)) {
  hashes[name]=crypto.createHash('sha256').update(await fs.readFile(path.join(payload,'launcher',name))).digest('hex');
  if(hashes[name]!==expected)throw new Error('Bundled runtime integrity check failed.');
 }
 if(!(await fs.readFile(path.join(payload,'launcher/UndauntedInternalServer.dll'))).includes(Buffer.from('Undaunted Private Server Credits','utf16le')))throw new Error('Bundled credits DLL is missing.');
 const installer=await packageNative({payload,version:config.version,output});
 const sha512=crypto.createHash('sha512').update(await fs.readFile(installer)).digest('base64');
 await fs.writeFile(path.join(output,'BUILD-METADATA.json'),JSON.stringify({version:config.version,installer,sha512,size:(await fs.stat(installer)).size,sourceArchive:sourceName,localTestHooks:false,automaticUpdates:true,testsPassed:true,runtimeHashes:hashes,published:false},null,2));
 console.log('Verified stable installer: '+installer);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
