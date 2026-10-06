'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),repo=path.dirname(root);
const {publishRelease}=require('./publish-updates.cjs');
const {trustedConfig,verifyManifest,verifyInstaller}=require('./lib/update-feed.cjs');
const {loadConfig}=require('./lib/config.cjs');
function argument(name) {const at=process.argv.indexOf(name);if(at<0||!process.argv[at+1])throw new Error('Missing '+name);return process.argv[at+1];}
function artifact(value) {const file=path.resolve(value);if(!file.startsWith(path.join(repo,'artifacts')+path.sep))throw new Error('A checked local artifact is required.');return file;}
async function main() {
 if(!process.argv.includes('--publish'))throw new Error('Publication requires an explicit --publish argument.');
 const directory=artifact(argument('--artifact')),test=artifact(argument('--upgrade-test'));
 const metadata=JSON.parse(await fs.readFile(path.join(directory,'BUILD-METADATA.json'),'utf8'));
 const result=JSON.parse(await fs.readFile(path.join(test,'result.json'),'utf8'));
 const local=await loadConfig();
 const config=trustedConfig(local.updateFeed);
 if(!local.keyFile||!local.publishDir)throw new Error('Configure keyFile and publishDir before publishing.');
 const installer=path.join(directory,`Undaunted-Launcher-${metadata.version}-Setup.exe`);
 if(!metadata.testsPassed||metadata.localTestHooks!==false||metadata.automaticUpdates!==true||!result.passed||result.via!==`Rust ${metadata.version}`||!result.preservedLogin||!result.tamperedInstallerRejected)throw new Error('Release checks are incomplete.');
 await verifyInstaller(installer,{url:path.basename(installer),sha512:metadata.sha512,size:metadata.size});
 if(metadata.runtimeHashes['UndauntedInternalServer.dll']!==result.creditsDllSha256)throw new Error('The tested credits DLL differs from the release.');
 const notes=await fs.readFile(path.join(root,'CHANGELOG.md'),'utf8');
 if(!notes.includes('rewritten in Rust'))throw new Error('The changelog must describe the Rust rewrite.');
 await fs.copyFile(path.join(local.publishDir,'latest.json'),path.join(directory,'previous-latest.json'));
 if(metadata.sourceArchive!==`Undaunted-Launcher-${metadata.version}-Source.zip`)throw new Error('Invalid source archive name.');
 await fs.copyFile(path.join(directory,metadata.sourceArchive),path.join(local.publishDir,metadata.sourceArchive+'.tmp'));
 await fs.rename(path.join(local.publishDir,metadata.sourceArchive+'.tmp'),path.join(local.publishDir,metadata.sourceArchive));
 await publishRelease({installer,version:metadata.version,output:local.publishDir,config,keyFile:local.keyFile,notes});
 // Verify exactly what existing launchers discover, over the actual HTTPS feed.
 const response=await fetch(config.url+'latest.json',{cache:'no-store'});
 if(!response.ok)throw new Error('Published metadata could not be read back over HTTPS.');
 const manifest=verifyManifest(await response.json(),config);
 if(manifest.version!==metadata.version)throw new Error('The live feed did not return the new version.');
 const download=await fetch(config.url+manifest.files[0].url,{cache:'no-store'});
 if(!download.ok)throw new Error('Published installer could not be downloaded over HTTPS.');
 const digest=crypto.createHash('sha512');let size=0;
 for await(const chunk of download.body){digest.update(chunk);size+=chunk.length;}
 if(size!==metadata.size||digest.digest('base64')!==metadata.sha512)throw new Error('Published installer verification failed.');
 metadata.published=true;metadata.publishedUtc=new Date().toISOString();metadata.liveHttpsVerified=true;metadata.installedUpgradeTest=test;
 await fs.writeFile(path.join(directory,'BUILD-METADATA.json'),JSON.stringify(metadata,null,2));
 console.log(`Published launcher ${metadata.version}. Verified signed metadata and complete installer through the live HTTPS feed.`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
