'use strict';
// Generates the documented Chromium v10 format using Windows DPAPI and AES-GCM.
// Actual legacy Electron compatibility is also exercised by installed-update.cjs.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
async function create(file) {
 const key=crypto.randomBytes(32),nonce=crypto.randomBytes(12);
 const wrapped=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  "Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String($env:UNDAUNTED_SYNTHETIC_AES_KEY); $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($protected))"],{encoding:'utf8',windowsHide:true,env:{...process.env,UNDAUNTED_SYNTHETIC_AES_KEY:key.toString('base64')}}).trim();
 const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);
 const encrypted=Buffer.concat([cipher.update(JSON.stringify({marker:'synthetic-electron-compatibility'})),cipher.final(),cipher.getAuthTag()]);
 await fs.writeFile(file,Buffer.concat([Buffer.from('v10'),nonce,encrypted]));
 const profile=path.join(path.dirname(file),'electron-profile');await fs.mkdir(profile,{recursive:true});
 await fs.writeFile(path.join(profile,'Local State'),JSON.stringify({os_crypt:{encrypted_key:Buffer.concat([Buffer.from('DPAPI'),Buffer.from(wrapped,'base64')]).toString('base64')}}));
}
module.exports={create};
