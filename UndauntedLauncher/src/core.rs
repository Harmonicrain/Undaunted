use crate::{
    Result, VERSION, game,
    network::{Network, server_origin},
    platform,
    profile::{Profile, Session},
    updates,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Child,
};

pub struct Launcher {
    pub profile: Profile,
    pub resources: PathBuf,
    pub settings_path: PathBuf,
    pub network: Network,
    session: Option<Session>,
    imported_key: Option<String>,
    child: Option<Child>,
    pub display_size: (u32, u32),
}
impl Launcher {
    pub fn new(resources: PathBuf, profile: PathBuf, settings_path: PathBuf) -> Result<Self> {
        Ok(Self {
            profile: Profile::open(profile, &resources)?,
            resources,
            settings_path,
            network: Network::new()?,
            session: None,
            imported_key: None,
            child: None,
            display_size: (1920, 1080),
        })
    }
    fn store_session(&mut self, value: Value) -> Result<()> {
        let session = Session::parse(value)?;
        // Retain a rotated token in memory even if disk persistence fails.
        self.session = Some(session);
        self.profile.save_session(self.session.as_ref().unwrap())
    }
    fn forget(&mut self) -> Result<()> {
        self.session = None;
        self.profile.forget()
    }
    fn restore(&mut self) -> Result<()> {
        let token = match &self.session {
            Some(s) => Some(s.refresh.clone()),
            None => self.profile.refresh_token()?,
        };
        let Some(refresh) = token else {
            return Ok(());
        };
        match self.network.request(
            &self.profile.config.server,
            "refresh",
            Some(json!({"refreshToken":refresh})),
            None,
        ) {
            Ok(value) => self.store_session(value),
            Err(error) => {
                if error.status == Some(401) {
                    self.forget()?;
                }
                Err(error.message)
            }
        }
    }
    fn request(&mut self, route: &str, body: Option<Value>, authenticated: bool) -> Result<Value> {
        if authenticated
            && self
                .session
                .as_ref()
                .is_none_or(|s| s.expires_at <= platform::now() + 5000)
        {
            self.restore()?;
        }
        if authenticated && self.session.is_none() {
            return Err("Please sign in again.".into());
        }
        self.network
            .request(
                &self.profile.config.server,
                route,
                body,
                if authenticated {
                    self.session.as_ref().map(|s| s.access.as_str())
                } else {
                    None
                },
            )
            .map_err(|e| e.message)
    }
    pub fn running(&mut self) -> Result<bool> {
        if let Some(child) = &mut self.child {
            match child.try_wait() {
                Ok(None) => return Ok(true),
                Ok(Some(_)) => self.child = None,
                Err(_) => return Err("Could not confirm Dauntless is closed.".into()),
            }
        }
        // The game settings file is shared across installations, so protect against any client.
        platform::game_running(None)
    }
    fn require_closed(&mut self) -> Result<()> {
        if self.running()? {
            return Err(
                "Close Dauntless before changing the game installation or settings.".into(),
            );
        }
        Ok(())
    }
    pub fn state(&mut self) -> Result<Value> {
        let status = self.request("status", None, false);
        let connected = status.is_ok();
        let mut error = status.as_ref().err().cloned().unwrap_or_default();
        if self.session.is_none()
            && connected
            && let Err(e) = self.restore()
        {
            error = e;
        }
        let running = self.running()?;
        Ok(
            json!({"server":self.profile.config.server,"registrationMode":status.ok().and_then(|v|v["registrationMode"].as_str().map(str::to_owned)).unwrap_or("NONE".into()),
            "connected":connected,"serverError":error,"user":self.session.as_ref().map(|s|&s.user),"gameDirectory":self.profile.config.game_directory,
            "running":running,"version":VERSION,"hasImportedAccount":self.imported_key.is_some()}),
        )
    }
    fn settings(&mut self) -> Result<Value> {
        let display = fs::read_to_string(&self.settings_path)
            .ok()
            .and_then(|s| game::read_display(&s));
        let (width, height) = self.display_size;
        let mut resolutions = vec![
            (1280, 720),
            (1366, 768),
            (1600, 900),
            (1920, 1080),
            (2560, 1080),
            (2560, 1440),
            (3440, 1440),
            (3840, 2160),
        ];
        resolutions.retain(|(w, h)| *w <= width && *h <= height);
        resolutions.push((width, height));
        if let Some(d) = &display {
            resolutions.push((d.width, d.height));
        }
        resolutions.sort();
        resolutions.dedup();
        Ok(
            json!({"language":self.profile.config.language,"languages":game::languages(),"display":display,"windowModes":{"0":"Fullscreen","1":"Borderless window","2":"Windowed"},
            "frameRates":game::FRAME_RATES,"resolutions":resolutions.into_iter().map(|(w,h)|json!({"width":w,"height":h})).collect::<Vec<_>>(),"running":self.running()?}),
        )
    }
    fn save_settings(&mut self, value: Value) -> Result<Value> {
        let language = value["language"]
            .as_str()
            .ok_or("Choose one of the listed languages.")?;
        if !language.is_empty() && game::languages().get(language).is_none() {
            return Err("Choose one of the listed languages.".into());
        }
        if let Some(display) = value.get("display") {
            self.require_closed()?;
            let display: game::Display = serde_json::from_value(display.clone())
                .map_err(|_| "Those display settings are not valid.")?;
            let text = fs::read_to_string(&self.settings_path)
                .map_err(|_| "Start Dauntless once before changing its display settings.")?;
            let updated = game::update_display(&text, &display)?;
            let backup = self
                .settings_path
                .with_file_name("GameUserSettings.ini.launcher-backup");
            if !backup.exists() {
                platform::copy_new(&self.settings_path, &backup)?;
            }
            self.require_closed()?;
            platform::atomic_write(&self.settings_path, updated.as_bytes())?;
        }
        self.profile.config.language = language.into();
        self.profile.save_config()?;
        self.settings()
    }
    pub fn action(&mut self, action: &str, value: Value) -> Result<Value> {
        match action {
            "state" => self.state(),
            "server" => {
                let origin = server_origin(value.as_str().ok_or("Enter a valid server address.")?)?;
                if origin != self.profile.config.server {
                    if let Some(session) = &self.session {
                        let token = session.refresh.clone();
                        let _ = self.request("logout", Some(json!({"refreshToken":token})), false);
                    }
                    self.forget()?;
                    self.imported_key = None;
                    self.profile.config.server = origin;
                    self.profile.save_config()?;
                }
                self.state()
            }
            "login" | "register" => {
                let username = value["username"]
                    .as_str()
                    .filter(|s| s.len() <= 16)
                    .ok_or("Enter a Slayer name.")?;
                let password = value["password"]
                    .as_str()
                    .filter(|s| s.chars().count() <= 128)
                    .ok_or("Enter your password.")?;
                let body = if action == "register" {
                    json!({"username":username,"password":password,"inviteCode":value["inviteCode"]})
                } else {
                    json!({"username":username,"password":password})
                };
                let result = self.request(action, Some(body), false)?;
                self.store_session(result)?;
                self.state()
            }
            "claim" => {
                let key = value["accountKey"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or(self.imported_key.as_deref())
                    .ok_or("Choose your account file or paste your existing account key.")?;
                if !game::token(key, "UUK_", 48) {
                    return Err("The account key is invalid.".into());
                }
                let password = value["password"]
                    .as_str()
                    .filter(|s| s.chars().count() <= 128)
                    .ok_or("Enter your password.")?;
                let result = self.request(
                    "claim",
                    Some(json!({"accountKey":key,"password":password})),
                    false,
                )?;
                self.store_session(result)?;
                self.imported_key = None;
                self.state()
            }
            "importAccount" => {
                let Some(file) = rfd::FileDialog::new()
                    .set_title("Choose your existing account file")
                    .add_filter("Account file", &["json"])
                    .pick_file()
                else {
                    return Ok(json!({"canceled":true}));
                };
                self.import_account(&file)
            }
            "logout" => {
                if let Some(s) = &self.session {
                    let refresh = s.refresh.clone();
                    self.request("logout", Some(json!({"refreshToken":refresh})), false)?;
                }
                self.forget()?;
                self.imported_key = None;
                self.state()
            }
            "selectGame" => {
                self.require_closed()?;
                let Some(folder) = rfd::FileDialog::new()
                    .set_title("Select your Dauntless 1.12.0 folder")
                    .pick_folder()
                else {
                    return self.state();
                };
                let folder = game::locate_game(&folder)?;
                game::verify_game(&folder)?;
                self.require_closed()?;
                game::install_runtime(&folder, &self.resources)?;
                // Windows extended-length paths are preserved on disk but removed in the UI.
                self.profile.config.game_directory = folder
                    .to_string_lossy()
                    .trim_start_matches("\\\\?\\")
                    .into();
                self.profile.save_config()?;
                self.state()
            }
            "repair" => {
                self.require_closed()?;
                if self.profile.config.game_directory.is_empty() {
                    return Err("Select the game folder first.".into());
                }
                game::install_runtime(
                    Path::new(&self.profile.config.game_directory),
                    &self.resources,
                )?;
                self.state()
            }
            "play" => {
                self.require_closed()?;
                let folder = PathBuf::from(&self.profile.config.game_directory);
                if folder.as_os_str().is_empty() {
                    return Err("Select your Dauntless 1.12.0 folder first.".into());
                }
                game::verify_game(&folder)?;
                if !game::runtime_status(&folder, &self.resources)? {
                    game::install_runtime(&folder, &self.resources)?;
                }
                let details = self.request("exchange", Some(json!({})), true)?;
                let args = game::launch_args(
                    &self.profile.config.server,
                    &details["user"],
                    details["exchangeCode"].as_str().unwrap_or_default(),
                    &self.profile.config.language,
                )?;
                self.require_closed()?;
                self.child = Some(platform::launch_game(&folder, &args)?);
                self.state()
            }
            "settings" => self.settings(),
            "saveSettings" => self.save_settings(value),
            "patchNotes" => {
                let changelog: Value = serde_json::from_str(include_str!("../CHANGELOG.json"))
                    .map_err(|_| "Could not load the launcher changelog.")?;
                let release_date = changelog["date"].as_str().unwrap_or_default().to_owned();
                let mut notes = self.network.notes(&self.profile.config.server).unwrap_or_else(|_| json!({
                    "date":release_date,"title":"Undaunted","version":"1.12.0",
                    "description":"Community updates and information for Dauntless 1.12.0.","categories":[]
                }));
                if let Some(categories) = notes["categories"].as_array_mut()
                    && !categories.iter().any(|c| c["title"] == changelog["title"])
                {
                    categories.insert(0, changelog);
                }
                if notes["date"].as_str().unwrap_or_default() < release_date.as_str() {
                    notes["date"] = release_date.into();
                }
                Ok(notes)
            },
            "discord" => {
                platform::open_discord()?;
                Ok(Value::Null)
            }
            "updateState" | "updateCheck" => Ok(updates::disabled_state()),
            "updateDownload" | "updateInstall" => Err(
                "Automatic updates are not configured.".into(),
            ),
            _ => Err("Invalid launcher request.".into()),
        }
    }
    pub fn import_account(&mut self, file: &Path) -> Result<Value> {
        let bad = "Choose the account JSON file supplied by the server owner.";
        if fs::metadata(file).map_err(|_| bad)?.len() > 8192 {
            return Err(bad.into());
        }
        let account: Value =
            serde_json::from_slice(&fs::read(file).map_err(|_| bad)?).map_err(|_| bad)?;
        let key = account["UUK"]
            .as_str()
            .filter(|s| game::token(s, "UUK_", 48))
            .ok_or(bad)?;
        self.imported_key = Some(key.into());
        Ok(
            json!({"username":account["Username"].as_str().unwrap_or("Existing player").chars().take(16).collect::<String>()}),
        )
    }
}
