use crate::{Result, network, platform};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, VerifyingKey, pkcs8::DecodePublicKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha512};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};
pub const APP_ID: &str = "community.undaunted.launcher112";
pub const MAX_MANIFEST: u64 = 64 * 1024;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    pub url: String,
    pub requires_tailscale: bool,
}
impl Feed {
    pub fn validate(&self) -> Result<url::Url> {
        let url = url::Url::parse(&self.url).map_err(|_| "Invalid update configuration.")?;
        if self.url.len() > 2048
            || url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.path().ends_with('/')
            || (self.requires_tailscale && !url.host_str().is_some_and(|h| h.ends_with(".ts.net")))
        {
            return Err("Updates require a trusted HTTPS folder address.".into());
        }
        Ok(url)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trust {
    #[serde(flatten)]
    pub feed: Feed,
    pub public_key: String,
    #[serde(default = "app_id")]
    pub app_id: String,
}
fn app_id() -> String {
    APP_ID.into()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    pub app_id: String,
    pub channel: String,
    pub version: String,
    pub release_date: String,
    pub release_notes: String,
    pub files: Vec<Installer>,
    pub next_feed: Option<Feed>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Installer {
    pub url: String,
    pub sha512: String,
    pub size: u64,
}
fn canonical_base64(value: &str) -> Result<Vec<u8>> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| "The update release signature is invalid.")?;
    if STANDARD.encode(&bytes) != value {
        return Err("The update release signature is invalid.".into());
    }
    Ok(bytes)
}
pub fn verify_manifest(envelope: &Value, trust: &Trust) -> Result<Manifest> {
    trust.feed.validate()?;
    let payload = envelope["payload"]
        .as_str()
        .filter(|s| s.len() <= MAX_MANIFEST as usize)
        .ok_or("The update release signature is invalid.")?;
    let signature = canonical_base64(
        envelope["signature"]
            .as_str()
            .ok_or("The update release signature is invalid.")?,
    )?;
    let bytes = canonical_base64(payload)?;
    let key = VerifyingKey::from_public_key_pem(&trust.public_key)
        .map_err(|_| "Invalid update verification key.")?;
    let sig = Signature::from_slice(&signature)
        .map_err(|_| "The update release signature is invalid.")?;
    key.verify_strict(&bytes, &sig)
        .map_err(|_| "The update release signature is invalid.")?;
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|_| "The signed update release is not compatible with this launcher.")?;
    let version =
        semver::Version::parse(&manifest.version).map_err(|_| "Invalid release version.")?;
    if manifest.schema != 1
        || manifest.app_id != trust.app_id
        || manifest.channel != "stable"
        || version.to_string() != manifest.version
        || !version.pre.is_empty()
        || !version.build.is_empty()
        || chrono::DateTime::parse_from_rfc3339(&manifest.release_date).is_err()
        || manifest.release_notes.chars().count() > 4000
        || manifest.files.len() != 1
    {
        return Err("The signed update release is not compatible with this launcher.".into());
    }
    let file = &manifest.files[0];
    if file.url != format!("Undaunted-Launcher-{}-Setup.exe", manifest.version)
        || canonical_base64(&file.sha512)?.len() != 64
        || file.size == 0
        || file.size > 512 * 1024 * 1024
    {
        return Err("Invalid signed installer details.".into());
    }
    if let Some(next) = &manifest.next_feed {
        next.validate()?;
    }
    Ok(manifest)
}
pub fn verify_installer(path: &Path, info: &Installer) -> Result<()> {
    let bad = "The downloaded installer failed verification.";
    let meta = fs::symlink_metadata(path).map_err(|_| bad)?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() != info.size {
        return Err(bad.into());
    }
    let mut file = fs::File::open(path).map_err(|_| bad)?;
    let mut hash = Sha512::new();
    let mut buffer = [0u8; 65536];
    loop {
        let size = file.read(&mut buffer).map_err(|_| bad)?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    if STANDARD.encode(hash.finalize()) != info.sha512 {
        return Err(bad.into());
    }
    Ok(())
}
// The native updater shares the signed protocol used by the Electron launcher.
pub fn fetch_manifest(network: &mut network::Network, trust: &Trust) -> Result<(Manifest, Value)> {
    let base = trust.feed.validate()?;
    network.tailnet(&trust.feed.url, trust.feed.requires_tailscale)?;
    let response = network
        .client
        .get(
            base.join("latest.json")
                .map_err(|_| "Invalid update URL.")?,
        )
        .header("Cache-Control", "no-cache")
        .send()
        .map_err(|_| "The update server is unavailable.")?;
    if !response.status().is_success() {
        return Err("The update server is unavailable.".into());
    }
    let envelope = network::bounded_json(response, MAX_MANIFEST)?;
    let manifest = verify_manifest(&envelope, trust)?;
    Ok((manifest, envelope))
}
pub fn download_installer(
    network: &mut network::Network,
    trust: &Trust,
    info: &Installer,
    cache: &Path,
    mut progress: impl FnMut(u64, u64),
) -> Result<()> {
    let base = trust.feed.validate()?;
    // Validate local filename independently; callers cannot introduce remote paths or arguments.
    if !info.url.starts_with("Undaunted-Launcher-")
        || !info.url.ends_with("-Setup.exe")
        || info.url.contains(['/', '\\', ':'])
        || info.size == 0
        || info.size > 512 * 1024 * 1024
    {
        return Err("Invalid installer download.".into());
    }
    network.tailnet(&trust.feed.url, trust.feed.requires_tailscale)?;
    let response = network
        .client
        .get(base.join(&info.url).map_err(|_| "Invalid update URL.")?)
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .map_err(|_| "Update download failed.")?;
    if !response.status().is_success() || response.content_length().is_some_and(|n| n != info.size)
    {
        return Err("Update download failed.".into());
    }
    let parent = cache.parent().ok_or("Invalid update cache.")?;
    fs::create_dir_all(parent).map_err(|_| "Could not prepare the update cache.")?;
    let temp = parent.join(format!("download-{}.tmp", platform::unique_tag()));
    let result = (|| -> Result<()> {
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|_| "Could not prepare download.")?;
        let mut input = response.take(info.size + 1);
        let mut buffer = [0u8; 65536];
        let mut size = 0;
        loop {
            let n = input
                .read(&mut buffer)
                .map_err(|_| "Download interrupted.")?;
            if n == 0 {
                break;
            }
            size += n as u64;
            if size > info.size {
                return Err("Download exceeded signed size.".into());
            }
            output
                .write_all(&buffer[..n])
                .map_err(|_| "Could not save download.")?;
            progress(size, info.size);
        }
        output.sync_all().map_err(|_| "Could not save download.")?;
        drop(output);
        verify_installer(&temp, info)?;
        fs::rename(&temp, cache).map_err(|_| "Could not cache verified download.")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn disabled_state() -> Value {
    serde_json::json!({"phase":"disabled","message":"Automatic updates are not configured.","percent":0})
}

// Installed upgrades use the same signed feed as the Electron launcher.
pub struct Updater {
    trust: Trust,
    network: network::Network,
    profile: std::path::PathBuf,
    manifest: Option<Manifest>,
    envelope: Option<Value>,
    pub status: Value,
}
impl Updater {
    pub fn new(resources: &Path, profile: &Path) -> Result<Self> {
        let bytes = fs::read(resources.join("updates.json"))
            .map_err(|_| "Automatic updates are not configured.")?;
        if bytes.len() > MAX_MANIFEST as usize {
            return Err("Invalid update configuration.".into());
        }
        let mut trust: Trust =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid update configuration.")?;
        trust.feed.validate()?;
        VerifyingKey::from_public_key_pem(&trust.public_key)
            .map_err(|_| "Invalid update verification key.")?;
        // A changed feed must carry a signature from the packaged trust key.
        if let Ok(bytes) = fs::read(profile.join("update-feed-migration.json"))
            && bytes.len() <= MAX_MANIFEST as usize
            && let Ok(envelope) = serde_json::from_slice::<Value>(&bytes)
            && let Ok(manifest) = verify_manifest(&envelope, &trust)
            && semver::Version::parse(crate::VERSION).ok()
                >= semver::Version::parse(&manifest.version).ok()
            && let Some(feed) = manifest.next_feed
        {
            trust.feed = feed;
        }
        let transport = if trust.feed.requires_tailscale {
            "tailscale"
        } else {
            "https"
        };
        Ok(Self {
            trust,
            network: network::Network::new()?,
            profile: profile.into(),
            manifest: None,
            envelope: None,
            status: serde_json::json!({"phase":"idle","message":"Check for launcher updates.","percent":0,"transport":transport}),
        })
    }
    fn emit(&mut self, phase: &str, message: String, percent: u64, notify: &mut impl FnMut(Value)) {
        self.status["phase"] = phase.into();
        self.status["message"] = message.into();
        self.status["percent"] = percent.into();
        if let Some(manifest) = &self.manifest {
            self.status["version"] = manifest.version.clone().into();
        }
        notify(self.status.clone());
    }
    pub fn check(&mut self, mut notify: impl FnMut(Value)) -> Result<Value> {
        if self.status["phase"] == "ready" {
            return Ok(self.status.clone());
        }
        self.manifest = None;
        self.envelope = None;
        self.status.as_object_mut().unwrap().remove("version");
        self.emit("checking", "Checking for updates…".into(), 0, &mut notify);
        match fetch_manifest(&mut self.network, &self.trust) {
            Ok((manifest, envelope)) => {
                let newer = semver::Version::parse(&manifest.version)
                    .map_err(|_| "Invalid release version.")?
                    > semver::Version::parse(crate::VERSION)
                        .map_err(|_| "Invalid launcher version.")?;
                let message = format!("Launcher {} is available.", manifest.version);
                self.manifest = Some(manifest);
                self.envelope = Some(envelope);
                self.emit(
                    if newer { "available" } else { "current" },
                    if newer {
                        message
                    } else {
                        "Your launcher is up to date.".into()
                    },
                    0,
                    &mut notify,
                );
            }
            Err(_) => self.emit(
                "error",
                "Could not check for updates. Check your connection and try again.".into(),
                0,
                &mut notify,
            ),
        }
        Ok(self.status.clone())
    }
    fn cache(&self) -> std::path::PathBuf {
        self.profile
            .join("updates")
            .join(self.manifest.as_ref().unwrap().files[0].url.clone())
    }
    pub fn download(&mut self, mut notify: impl FnMut(Value)) -> Result<Value> {
        if self.status["phase"] != "available" {
            return Err("Check for a new launcher version first.".into());
        }
        let manifest = self
            .manifest
            .as_ref()
            .ok_or("Check for a new launcher version first.")?
            .clone();
        let cache = self.cache();
        self.emit(
            "downloading",
            format!("Downloading launcher {}…", manifest.version),
            0,
            &mut notify,
        );
        let mut progress_state = self.status.clone();
        let result = download_installer(
            &mut self.network,
            &self.trust,
            &manifest.files[0],
            &cache,
            |size, total| {
                progress_state["percent"] = (size * 100 / total).into();
                notify(progress_state.clone());
            },
        );
        match result {
            Ok(()) => self.emit(
                "ready",
                format!("Launcher {} is ready. Restart to update.", manifest.version),
                100,
                &mut notify,
            ),
            Err(_) => self.emit(
                "error",
                "Download failed verification or was interrupted. Check for updates and try again."
                    .into(),
                0,
                &mut notify,
            ),
        }
        Ok(self.status.clone())
    }
    pub fn prepare_install(&mut self) -> Result<std::path::PathBuf> {
        if self.status["phase"] != "ready" {
            return Err("Download an update first.".into());
        }
        let manifest = self.manifest.as_ref().ok_or("Download an update first.")?;
        let cache = self.cache();
        verify_installer(&cache, &manifest.files[0])?;
        let envelope = self.envelope.as_ref().ok_or("Invalid update release.")?;
        let verified = verify_manifest(envelope, &self.trust)?;
        if serde_json::to_value(&verified).ok() != serde_json::to_value(manifest).ok() {
            return Err("Update release changed.".into());
        }
        if manifest.next_feed.is_some() {
            platform::atomic_write(
                &self.profile.join("update-feed-migration.json"),
                &serde_json::to_vec(envelope).map_err(|_| "Invalid update release.")?,
            )?;
        }
        Ok(cache)
    }
    pub fn install_failed(&mut self, message: String, mut notify: impl FnMut(Value)) {
        self.emit("error", message, 0, &mut notify);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey, pkcs8::EncodePublicKey};
    #[test]
    fn installer_handoff_reverifies_cache_and_signed_envelope() {
        let root = tempfile::tempdir().unwrap();
        let keys = SigningKey::from_bytes(&[37; 32]);
        let trust = serde_json::json!({"url":"https://localhost/","requiresTailscale":false,"publicKey":keys.verifying_key().to_public_key_pem(Default::default()).unwrap()});
        fs::write(
            root.path().join("updates.json"),
            serde_json::to_vec(&trust).unwrap(),
        )
        .unwrap();
        let mut updater = Updater::new(root.path(), root.path()).unwrap();
        let bytes = b"synthetic installer";
        let manifest = Manifest {
            schema: 1,
            app_id: APP_ID.into(),
            channel: "stable".into(),
            version: "1.0.9".into(),
            release_date: "2026-10-06T00:00:00Z".into(),
            release_notes: "Local test".into(),
            next_feed: None,
            files: vec![Installer {
                url: "Undaunted-Launcher-1.0.9-Setup.exe".into(),
                size: bytes.len() as u64,
                sha512: STANDARD.encode(Sha512::digest(bytes)),
            }],
        };
        let payload = serde_json::to_vec(&manifest).unwrap();
        updater.envelope = Some(
            serde_json::json!({"payload":STANDARD.encode(&payload),"signature":STANDARD.encode(keys.sign(&payload).to_bytes())}),
        );
        updater.manifest = Some(manifest);
        updater.status["phase"] = "ready".into();
        let cache = updater.cache();
        fs::create_dir_all(cache.parent().unwrap()).unwrap();
        fs::write(&cache, bytes).unwrap();
        assert_eq!(updater.prepare_install().unwrap(), cache);
        fs::write(&cache, b"modified installer").unwrap();
        assert!(updater.prepare_install().is_err());
        fs::write(&cache, bytes).unwrap();
        updater.envelope.as_mut().unwrap()["signature"] = STANDARD.encode([0u8; 64]).into();
        assert!(updater.prepare_install().is_err());
        // A rejected installer must allow a fresh check/download in the UI.
        let mut emitted = None;
        updater.install_failed(
            "The downloaded installer failed verification.".into(),
            |state| emitted = Some(state),
        );
        assert_eq!(emitted.unwrap()["phase"], "error");
        assert_eq!(updater.status["phase"], "error");
    }
}
