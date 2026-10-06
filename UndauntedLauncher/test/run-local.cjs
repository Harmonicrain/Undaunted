'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn,fork}=require('node:child_process');
const root=path.resolve(__dirname,'..'),repo=path.resolve(root,'..');
const {loadConfig}=require('../scripts/lib/config.cjs');
let fixture;
async function run(executable,args,env=process.env,timeout=300000) {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd:root,env,windowsHide:true,stdio:'inherit',shell:false});
    const timer=setTimeout(()=>{child.kill();reject(new Error('Local test timed out.'));},timeout);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Local test could not start.'));});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(path.basename(executable)+' local test failed (exit '+code+').'));});
  });
}
async function main() {
  const candidates=[];
  for(const name of await fs.readdir(path.join(repo,'artifacts'))) {
    try {const manifest=JSON.parse((await fs.readFile(path.join(repo,'artifacts',name,'manifest.json'),'utf8')).replace(/^\uFEFF/,''));if(manifest.testsPassed)candidates.push({name,date:Date.parse(manifest.createdUtc)});}catch{}
  }
  candidates.sort((a,b)=>b.date-a.date);
  const stage=process.env.UNDAUNTED_TEST_STAGE || path.join(repo,'artifacts',candidates[0]?.name||'', 'UndauntedMetagame');
  if(!path.resolve(stage).startsWith(path.join(repo,'artifacts')+path.sep))throw new Error('Tests require a disposable staged backend.');
  const output=path.join(repo,'artifacts','launcher-rust-local-'+Date.now());await fs.mkdir(output);
  const env={...process.env,UNDAUNTED_TEST_STAGE:stage,NODE_PATH:path.join(repo,'UndauntedMetagame/node_modules')};
  fixture=fork(path.join(__dirname,'server-fixture.cjs'),[],{cwd:stage,env,windowsHide:true,silent:true});
  const fixtureDetails=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Disposable backend timed out.')),20000);
    fixture.once('message',value=>{clearTimeout(timer);resolve(value);});fixture.once('exit',()=>{clearTimeout(timer);reject(new Error('Disposable backend failed.'));});
  });
  const port=fixtureDetails.port,accountFile=path.join(output,'synthetic-legacy-account.json');
  await fs.writeFile(accountFile,JSON.stringify(fixtureDetails.legacyAccount));
  const session=path.join(output,'electron-synthetic.bin');
  await require('./fixture-session.cjs').create(session);
  const compiler=(await loadConfig()).nsisCompiler;
  const argumentInstaller=path.join(output,'argument-test.exe'),argumentScript=path.join(output,'argument-test.nsi');
  await fs.writeFile(argumentScript,`Unicode true\nName "Disposable directory argument test"\nOutFile "${argumentInstaller}"\nSilentInstall silent\nRequestExecutionLevel user\nInstallDir "${path.join(output,'incorrect-directory')}"\nSection\nCreateDirectory "$INSTDIR"\nFileOpen $0 "$INSTDIR\\installed.txt" w\nFileWrite $0 "Test completed"\nFileClose $0\nSectionEnd\n`);
  await run(compiler,['/V1',argumentScript]);
  await run('cargo.exe',['test','--locked','--test','parity','--','--include-ignored'],{...env,UNDAUNTED_RUST_TEST_BACKEND:`http://127.0.0.1:${port}`,UNDAUNTED_RUST_ELECTRON_SESSION:session,UNDAUNTED_RUST_TEST_ACCOUNT:accountFile,UNDAUNTED_RUST_NSIS_FIXTURE:argumentInstaller});
  await fs.writeFile(path.join(output,'rust-smoke-options.json'),JSON.stringify({server:`http://127.0.0.1:${port}`}));
  await fs.writeFile(path.join(output,'GameUserSettings.ini'),'[/Script/Archon.ArchonGameUserSettings]\r\nFullscreenMode=1\r\nResolutionSizeX=1920\r\nResolutionSizeY=1080\r\nFrameRateLimit=90.000000\r\nVersion=5\r\n');
  await run('cargo.exe',['build','--features','local-tests']);
  await run(path.join(root,'target/debug/undaunted-launcher.exe'),[],{...env,UNDAUNTED_RUST_SMOKE_OPTIONS:path.join(output,'rust-smoke-options.json')},90000);
  const result=JSON.parse(await fs.readFile(path.join(output,'ui-result.json'),'utf8'));if(!result.passed)throw new Error('WebView2 smoke failed.');
  console.log('Rust/WebView2 local smoke passed. Screenshots: '+output);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>{if(fixture?.connected)fixture.send('close');});
