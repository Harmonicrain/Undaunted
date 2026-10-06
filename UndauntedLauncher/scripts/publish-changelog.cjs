'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),repo=path.dirname(root);
async function main() {
 const at=process.argv.indexOf('--artifact');
 if(at<0||!process.argv.includes('--publish'))throw new Error('A published release artifact and --publish are required.');
 const artifact=path.resolve(process.argv[at+1]);
 if(!artifact.startsWith(path.join(repo,'artifacts')+path.sep))throw new Error('Invalid release artifact.');
 const metadata=JSON.parse(await fs.readFile(path.join(artifact,'BUILD-METADATA.json'),'utf8'));
 if(!metadata.published||!metadata.liveHttpsVerified)throw new Error('Publish and verify the installer before announcing it.');
 const file=path.join(repo,'data/1.12/patchnotes/en.json');
 const bytes=await fs.readFile(file),notes=JSON.parse(bytes);
 const category=JSON.parse(await fs.readFile(path.join(root,'CHANGELOG.json'),'utf8'));
 notes.date=new Date().toISOString();
 notes.description='The launcher has been rewritten in Rust. Community updates and information for Dauntless 1.12.0.';
 notes.notes=notes.notes.filter(n=>n.type!=='launcher');
 notes.notes.unshift({...category,type:'launcher',sections:category.sections.map(section=>({...section,type:'text'}))});
 require(path.join(repo,'UndauntedMetagame/dist/features/patchnotes/patchnotes.js')).ParsePatchNotes(notes,'en');
 await fs.writeFile(path.join(artifact,'previous-patchnotes-en.json'),bytes);
 const dataRoot=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  ". (Join-Path $env:UNDAUNTED_RELEASE_REPO 'tools/Local112Config.ps1'); $releaseConfiguration=Resolve-Local112Config -RequireDataRoot; [Console]::Write($releaseConfiguration.DataRoot)"],{encoding:'utf8',windowsHide:true,env:{...process.env,UNDAUNTED_RELEASE_REPO:repo}}).trim();
 const targets=[file];
 for(const candidate of [path.join(dataRoot,'data/1.12/patchnotes/en.json'),path.join(dataRoot,'data/patchnotes/en.json')]) {
  if(candidate.toLowerCase()!==file.toLowerCase()&&(await fs.stat(candidate).catch(()=>null)))targets.push(candidate);
 }
 for(let i=0;i<targets.length;i++) {
  if(i)await fs.copyFile(targets[i],path.join(artifact,`previous-patchnotes-copy-${i}.json`));
  await fs.writeFile(targets[i]+'.tmp',JSON.stringify(notes,null,2)+'\n');await fs.rename(targets[i]+'.tmp',targets[i]);
 }
 const server=JSON.parse(await fs.readFile(path.join(root,'resources/server.json'),'utf8')).server;
 const response=await fetch(server+'/patchnotes/en/392819');
 const live=await response.json();
 if(!response.ok||!live.payload?.notes?.some(n=>n.title===category.title&&n.sections.some(s=>s.description.includes('rewritten in Rust'))))throw new Error('The published changelog was not returned by the running server.');
 console.log('Published Rust launcher changelog; verified live reload without restarting the game servers.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
