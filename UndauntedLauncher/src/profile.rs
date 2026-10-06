use crate::{Result, game, network, platform};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

// Compatibility reader for the original Electron launcher's encrypted sessions.
// Chromium protects an AES-GCM key with DPAPI in Local State, then stores v10+nonce+ciphertext.
pub fn decrypt_electron_session(session: &[u8], local_state: &[u8]) -> Result<Vec<u8>> {
    let bad = "The Electron login could not be migrated. Please sign in again.";
    if session.len() > 65536 || local_state.len() > 1024 * 1024 {
        return Err(bad.into());
    }
    if !session.starts_with(b"v10") {
        return platform::unprotect(session);
    }
    if session.len() < 3 + 12 + 16 {
        return Err(bad.into());
    }
    let state: Value = serde_json::from_slice(local_state).map_err(|_| bad)?;
    let wrapped = STANDARD
        .decode(state["os_crypt"]["encrypted_key"].as_str().ok_or(bad)?)
        .map_err(|_| bad)?;
    let key = platform::unprotect(wrapped.strip_prefix(b"DPAPI").ok_or(bad)?).map_err(|_| bad)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| bad)?;
    cipher
        .decrypt(Nonce::from_slice(&session[3..15]), &session[15..])
        .map_err(|_| bad.into())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub server: String,
    #[serde(default)]
    pub game_directory: String,
    #[serde(default)]
    pub language: String,
}
pub struct Profile {
    pub root: PathBuf,
    pub config: Config,
}
pub struct Session {
    pub access: String,
    pub refresh: String,
    pub user: Value,
    pub expires_at: u64,
}
impl Session {
    pub fn parse(value: Value) -> Result<Self> {
        let access = value["accessToken"].as_str().unwrap_or_default();
        let refresh = value["refreshToken"].as_str().unwrap_or_default();
        let expires = value["expiresIn"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 86400)
            .ok_or("The server returned an invalid session.")?;
        if !game::token(access, "ULA_", 64)
            || !game::token(refresh, "ULR_", 64)
            || !game::valid_user(&value["user"])
        {
            return Err("The server returned an invalid session.".into());
        }
        Ok(Self {
            access: access.into(),
            refresh: refresh.into(),
            user: value["user"].clone(),
            expires_at: platform::now() + expires * 1000,
        })
    }
}
impl Profile {
    pub fn migrate_from_roaming(roaming: &Path, new: &Path) -> Result<bool> {
        if new.join("config.json").exists() || new.join("session.bin").exists() {
            return Ok(false);
        }
        // Electron's packaged productName defines its original userData folder.
        let old = roaming.join("Undaunted Launcher");
        if !old.join("config.json").is_file() || old == new {
            return Ok(false);
        }
        if Self::migrate_electron(&old, new).is_err() {
            // A stale/corrupt saved login still keeps valid settings. Signing in
            // again is possible, and the complete Electron profile stays intact.
            let file = old.join("config.json");
            if fs::metadata(&file).map_err(|_| "Missing Electron settings.")?.len() > 8192 {
                return Err("Invalid Electron settings.".into());
            }
            let mut config: Config = serde_json::from_slice(&fs::read(file).map_err(|_| "Could not read Electron settings.")?)
                .map_err(|_| "Invalid Electron settings.")?;
            config.server = network::server_origin(&config.server)?;
            platform::atomic_write(&new.join("config.json"), &serde_json::to_vec(&config).map_err(|_| "Invalid Electron settings.")?)?;
        }
        // This is public signed metadata. The updater verifies it against the
        // packaged key before accepting a migrated feed address.
        let migration = old.join("update-feed-migration.json");
        if fs::metadata(&migration).is_ok_and(|m| m.len() <= 65536) {
            let bytes = fs::read(migration).map_err(|_| "Could not read update settings.")?;
            platform::atomic_write(&new.join("update-feed-migration.json"), &bytes)?;
        }
        Ok(true)
    }
    // Called explicitly by a migration build before opening the new profile.
    // Leaves the old profile intact; an existing Rust profile is never replaced.
    pub fn migrate_electron(old: &Path, new: &Path) -> Result<bool> {
        if new.join("config.json").exists() || new.join("session.bin").exists() {
            return Ok(false);
        }
        let read = |name: &str, limit: u64| -> Result<Vec<u8>> {
            let file = old.join(name);
            if fs::metadata(&file)
                .map_err(|_| "Missing Electron profile.")?
                .len()
                > limit
            {
                return Err("Invalid Electron profile.".into());
            }
            fs::read(file).map_err(|_| "Could not read Electron profile.".into())
        };
        let bytes = read("config.json", 8192)?;
        let mut config: Config =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid Electron settings.")?;
        config.server = network::server_origin(&config.server)?;
        let encrypted = if old.join("session.bin").exists() {
            let session = read("session.bin", 65536)?;
            let state = if session.starts_with(b"v10") {
                read("Local State", 1024 * 1024)?
            } else {
                vec![]
            };
            let plain = decrypt_electron_session(&session, &state)?;
            let value: Value =
                serde_json::from_slice(&plain).map_err(|_| "Invalid Electron login.")?;
            if value["server"] != config.server
                || !game::token(
                    value["refreshToken"].as_str().unwrap_or_default(),
                    "ULR_",
                    64,
                )
            {
                return Err("Invalid Electron login.".into());
            }
            Some(platform::protect(&plain)?)
        } else {
            None
        };
        // Config is the completion marker; retry is safe if a write fails.
        let wrote_session = encrypted.is_some();
        if let Some(session) = encrypted {
            platform::atomic_write(&new.join("session.bin"), &session)?;
        }
        let result = platform::atomic_write(
            &new.join("config.json"),
            &serde_json::to_vec(&config).map_err(|_| "Invalid Electron settings.")?,
        );
        if let Err(error) = result {
            if wrote_session {
                let _ = fs::remove_file(new.join("session.bin"));
            }
            return Err(error);
        }
        Ok(true)
    }
    pub fn open(root: PathBuf, resources: &Path) -> Result<Self> {
        let defaults: Value = serde_json::from_slice(
            &fs::read(resources.join("server.json"))
                .map_err(|_| "The launcher bundle is incomplete.")?,
        )
        .map_err(|_| "The launcher bundle is incomplete.")?;
        let server = network::server_origin(
            defaults["server"]
                .as_str()
                .ok_or("The default server is invalid.")?,
        )?;
        let mut config = Config {
            server,
            game_directory: String::new(),
            language: String::new(),
        };
        if let Ok(bytes) = fs::read(root.join("config.json"))
            && bytes.len() <= 8192
            && let Ok(mut stored) = serde_json::from_slice::<Config>(&bytes)
        {
            stored.server = network::server_origin(&stored.server)?;
            config = stored;
        }
        Ok(Self { root, config })
    }
    pub fn save_config(&self) -> Result<()> {
        platform::atomic_write(
            &self.root.join("config.json"),
            &serde_json::to_vec(&self.config).map_err(|_| "Could not save launcher settings.")?,
        )
    }
    pub fn save_session(&self, session: &Session) -> Result<()> {
        let data = serde_json::to_vec(
            &json!({"server":self.config.server,"refreshToken":session.refresh}),
        )
        .map_err(|_| "Could not protect your login.")?;
        platform::atomic_write(&self.root.join("session.bin"), &platform::protect(&data)?)
    }
    pub fn refresh_token(&self) -> Result<Option<String>> {
        let file = self.root.join("session.bin");
        if !file.exists() {
            return Ok(None);
        }
        if fs::metadata(&file)
            .map_err(|_| "Could not read the saved login.")?
            .len()
            > 65536
        {
            return Err("The saved login is invalid.".into());
        }
        let bytes =
            platform::unprotect(&fs::read(file).map_err(|_| "Could not read the saved login.")?)?;
        let data: Value =
            serde_json::from_slice(&bytes).map_err(|_| "The saved login is invalid.")?;
        if data["server"] != self.config.server {
            return Ok(None);
        }
        let refresh = data["refreshToken"]
            .as_str()
            .ok_or("The saved login is invalid.")?;
        if !game::token(refresh, "ULR_", 64) {
            return Err("The saved login is invalid.".into());
        }
        Ok(Some(refresh.into()))
    }
    pub fn forget(&self) -> Result<()> {
        match fs::remove_file(self.root.join("session.bin")) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Could not remove the saved login.".into()),
        }
    }
}
