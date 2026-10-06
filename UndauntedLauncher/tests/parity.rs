use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey, pkcs8::EncodePublicKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha512};
use std::fs;
use undaunted_launcher::{
    game, network, platform,
    profile::{Profile, Session},
    updates,
};

#[test]
fn electron_profile_migration_is_explicit_preserves_settings_and_never_overwrites() {
    let directory = tempfile::tempdir().unwrap();
    let old = directory.path().join("electron");
    let new = directory.path().join("rust");
    fs::create_dir_all(&old).unwrap();
    let config =
        json!({"server":"http://127.0.0.1:61000","gameDirectory":"kept-folder","language":"fr"});
    fs::write(
        old.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let token = format!("ULR_{}", "a".repeat(64));
    let plain =
        serde_json::to_vec(&json!({"server":config["server"],"refreshToken":token})).unwrap();
    let encrypted = platform::protect(&plain).unwrap();
    fs::write(old.join("session.bin"), &encrypted).unwrap();
    assert!(Profile::migrate_electron(&old, &new).unwrap());
    let migrated: Value =
        serde_json::from_slice(&fs::read(new.join("config.json")).unwrap()).unwrap();
    assert_eq!(migrated, config);
    assert_eq!(
        platform::unprotect(&fs::read(new.join("session.bin")).unwrap()).unwrap(),
        plain
    );
    assert_eq!(fs::read(old.join("session.bin")).unwrap(), encrypted);
    fs::write(old.join("config.json"), b"invalid").unwrap();
    assert!(!Profile::migrate_electron(&old, &new).unwrap());
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(new.join("config.json")).unwrap()).unwrap(),
        config
    );
}

#[test]
fn invalid_electron_profile_migration_does_not_write_partial_rust_profile() {
    let directory = tempfile::tempdir().unwrap();
    let old = directory.path().join("electron");
    let new = directory.path().join("rust");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("config.json"),serde_json::to_vec(&json!({"server":"http://127.0.0.1:61000","gameDirectory":"kept-folder","language":"fr"})).unwrap()).unwrap();
    fs::write(old.join("session.bin"), b"corrupt encrypted session").unwrap();
    assert!(Profile::migrate_electron(&old, &new).is_err());
    assert!(!new.join("config.json").exists());
    assert!(!new.join("session.bin").exists());
}

#[test]
fn default_profile_migration_keeps_settings_when_old_login_is_corrupt() {
    let directory = tempfile::tempdir().unwrap();
    let old = directory.path().join("Undaunted Launcher");
    let new = directory.path().join("community.undaunted.launcher112");
    fs::create_dir_all(&old).unwrap();
    let config = json!({"server":"http://127.0.0.1:61000","gameDirectory":"kept-folder","language":"fr"});
    fs::write(old.join("config.json"), serde_json::to_vec(&config).unwrap()).unwrap();
    fs::write(old.join("session.bin"), b"invalid encrypted login").unwrap();
    fs::write(old.join("update-feed-migration.json"), b"public signed metadata").unwrap();
    assert!(Profile::migrate_from_roaming(directory.path(), &new).unwrap());
    assert_eq!(serde_json::from_slice::<Value>(&fs::read(new.join("config.json")).unwrap()).unwrap(), config);
    assert!(!new.join("session.bin").exists());
    assert_eq!(fs::read(new.join("update-feed-migration.json")).unwrap(), b"public signed metadata");
    assert_eq!(fs::read(old.join("session.bin")).unwrap(), b"invalid encrypted login");
    fs::write(old.join("config.json"), b"invalid settings").unwrap();
    assert!(!Profile::migrate_from_roaming(directory.path(), &new).unwrap());
}

#[test]
fn launcher_changelog_is_readable_when_the_server_is_offline() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("server.json"), b"{\"server\":\"http://127.0.0.1:9\"}").unwrap();
    let mut launcher = undaunted_launcher::core::Launcher::new(directory.path().into(), directory.path().join("profile"), directory.path().join("settings.ini")).unwrap();
    let notes = launcher.action("patchNotes", Value::Null).unwrap();
    assert_eq!(notes["categories"][0]["title"], "Launcher 1.0.8");
    assert!(notes["categories"][0]["sections"][0]["description"].as_str().unwrap().contains("rewritten in Rust"));
}

#[test]
#[ignore = "requires the disposable NSIS fixture; run test/run-local.cjs"]
fn native_update_handoff_installs_to_a_directory_containing_spaces() {
    let installer = std::path::PathBuf::from(std::env::var_os("UNDAUNTED_RUST_NSIS_FIXTURE").expect("Disposable NSIS fixture required"));
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("launcher directory with spaces");
    platform::launch_installer(&installer, &target).unwrap();
    let marker = target.join("installed.txt");
    for _ in 0..100 {
        if marker.is_file() { return; }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    panic!("NSIS did not use the requested directory containing spaces");
}

#[test]
fn origins_reject_public_http_and_url_injection() {
    for url in [
        "https://example.org",
        "http://127.0.0.1:61000",
        "http://10.0.0.1:61000",
        "http://172.16.1.2:61000",
        "http://100.64.1.2:61000",
        "http://100.127.255.254:61000",
    ] {
        assert_eq!(network::server_origin(url).unwrap(), url);
    }
    for url in [
        "http://example.org",
        "http://8.8.8.8",
        "http://100.63.255.255",
        "http://100.128.0.1",
        "https://user:pass@example.org",
        "https://example.org/api",
        "file:///test",
        "https://example.org/?token=abc",
    ] {
        assert!(network::server_origin(url).is_err());
    }
    assert!(network::is_tailscale("http://100.64.1.2:61000"));
    assert!(!network::is_tailscale("http://192.168.1.2:61000"));
}
#[test]
fn arguments_only_accept_valid_one_time_details() {
    let user = json!({"userId":"UID-11111111-2222-3333-4444-555555555555","username":"TestSlayer"});
    let code = format!("ULX_{}", "a".repeat(64));
    let args = game::launch_args("http://127.0.0.1:61000", &user, &code, "fr").unwrap();
    assert!(args.contains(&format!("-AUTH_PASSWORD={code}")));
    assert!(args.contains(&"-UndauntedMetagame=127.0.0.1:61000".into()));
    assert!(args.contains(&"-culture=fr".into()));
    assert!(args.contains(&"-NoEAC".into()));
    assert!(
        game::launch_args(
            "http://127.0.0.1:61000",
            &json!({"userId":user["userId"],"username":"Bad -server"}),
            &code,
            ""
        )
        .is_err()
    );
    assert!(
        game::launch_args(
            "http://127.0.0.1:61000",
            &user,
            &format!("UUK_{}", "a".repeat(48)),
            ""
        )
        .is_err()
    );
    assert!(
        !game::launch_args("http://127.0.0.1:61000", &user, &code, "fr -server")
            .unwrap()
            .iter()
            .any(|s| s.starts_with("-culture"))
    );
}
#[test]
fn settings_preserve_other_sections_duplicate_keys_and_line_endings() {
    let original = "[ScalabilityGroups]\r\nsg.ShadowQuality=3\r\n\r\n[/Script/Archon.ArchonGameUserSettings]\r\nMasterVolume=1.000000\r\nVersion=5\r\nFrameRateLimit=90.000000\r\nLastGPUBenchmarkSteps=100\r\nLastGPUBenchmarkSteps=100\r\n\r\n[/Script/Engine.GameUserSettings]\r\nbUseDesiredScreenHeight=False\r\n";
    let display = game::Display {
        mode: 2,
        width: 2560,
        height: 1440,
        fps: 0,
        vsync: true,
    };
    let updated = game::update_display(original, &display).unwrap();
    assert_eq!(game::read_display(&updated).unwrap(), display);
    for keep in [
        "sg.ShadowQuality=3",
        "MasterVolume=1.000000",
        "Version=5",
        "bUseDesiredScreenHeight=False",
    ] {
        assert!(updated.contains(keep));
    }
    assert_eq!(updated.matches("LastGPUBenchmarkSteps=").count(), 2);
    assert!(!updated.replace("\r\n", "").contains('\n'));
    assert!(game::update_display("[Other]\n", &display).is_err());
    assert!(game::Display { fps: 59, ..display }.validate().is_err());
}
#[test]
fn notes_are_bounded_and_never_include_remote_markup_fields() {
    let value = json!({"title":"x".repeat(5000),"notes":[{"title":"New","sections":[{"title":"Launcher","description":"Safe text","url":"javascript:alert(1)","changes":[{"comment":"Go","list":["One",2,"","x".repeat(5000)]}]}]},{"title":"Empty","sections":[]}]});
    let notes = game::patch_notes(&value);
    assert_eq!(notes["title"].as_str().unwrap().len(), 80);
    assert_eq!(notes["categories"].as_array().unwrap().len(), 1);
    assert!(notes["categories"][0]["sections"][0].get("url").is_none());
    assert_eq!(
        notes["categories"][0]["sections"][0]["changes"][0]["list"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
fn runtime_fixture() -> (tempfile::TempDir, tempfile::TempDir, Value) {
    let resources = tempfile::tempdir().unwrap();
    let game = tempfile::tempdir().unwrap();
    let mut files = json!({});
    for name in game::RUNTIME_FILES {
        fs::write(resources.path().join(name), format!("new {name}")).unwrap();
        files[name] = game::hash_file(&resources.path().join(name))
            .unwrap()
            .into();
        fs::write(game.path().join(name), format!("old {name}")).unwrap();
    }
    let manifest = json!({"files":files});
    fs::write(
        resources.path().join("runtime.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    (resources, game, manifest)
}
#[test]
fn runtime_repair_verifies_both_files_and_preserves_backups() {
    let (resources, folder, manifest) = runtime_fixture();
    game::verify_resources(resources.path()).unwrap();
    game::replace_runtime(folder.path(), resources.path(), &manifest).unwrap();
    assert!(game::runtime_status(folder.path(), resources.path()).unwrap());
    let names = fs::read_dir(folder.path())
        .unwrap()
        .map(|f| f.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(names.iter().filter(|n| n.ends_with(".bak")).count(), 2);
    assert!(!names.iter().any(|n| n.ends_with(".tmp")));
}
#[test]
fn corrupt_runtime_cannot_replace_installed_dlls() {
    let (resources, folder, manifest) = runtime_fixture();
    fs::write(
        resources.path().join("UndauntedInternalServer.dll"),
        "tampered",
    )
    .unwrap();
    assert!(game::verify_resources(resources.path()).is_err());
    assert!(game::replace_runtime(folder.path(), resources.path(), &manifest).is_err());
    assert_eq!(
        fs::read_to_string(folder.path().join("winmm.dll")).unwrap(),
        "old winmm.dll"
    );
    assert!(
        !fs::read_dir(folder.path()).unwrap().any(|f| f
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp"))
    );
}
#[test]
fn failed_second_replacement_rolls_first_dll_back() {
    let (resources, folder, manifest) = runtime_fixture();
    // Windows refuses renaming a DLL held without FILE_SHARE_DELETE.
    use std::os::windows::fs::OpenOptionsExt;
    let _lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(folder.path().join("UndauntedInternalServer.dll"))
        .unwrap();
    assert!(game::replace_runtime(folder.path(), resources.path(), &manifest).is_err());
    for name in game::RUNTIME_FILES {
        assert_eq!(
            fs::read_to_string(folder.path().join(name)).unwrap(),
            format!("old {name}")
        );
    }
}
#[test]
fn game_discovery_accepts_root_and_rejects_wrong_build() {
    let temp = tempfile::tempdir().unwrap();
    let binaries = temp.path().join("Dauntless/Archon/Binaries/Win64");
    fs::create_dir_all(&binaries).unwrap();
    fs::write(binaries.join(game::EXE), "wrong executable").unwrap();
    assert_eq!(
        game::locate_game(temp.path()).unwrap(),
        binaries.canonicalize().unwrap()
    );
    assert!(game::verify_game(&binaries).is_err());
}
#[test]
fn dpapi_profile_survives_reopening_without_plaintext_tokens() {
    let resources = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    fs::write(
        resources.path().join("server.json"),
        b"{\"server\":\"http://127.0.0.1:61000\"}",
    )
    .unwrap();
    let profile = Profile::open(root.path().into(), resources.path()).unwrap();
    let token = format!("ULR_{}", "b".repeat(64));
    let session=Session::parse(json!({"accessToken":format!("ULA_{}","a".repeat(64)),"refreshToken":token,"expiresIn":900,"user":{"userId":"UID-11111111-2222-3333-4444-555555555555","username":"TestSlayer"}})).unwrap();
    profile.save_session(&session).unwrap();
    let bytes = fs::read(root.path().join("session.bin")).unwrap();
    assert!(!bytes.windows(4).any(|s| s == b"ULR_"));
    assert_eq!(
        Profile::open(root.path().into(), resources.path())
            .unwrap()
            .refresh_token()
            .unwrap(),
        Some(token)
    );
    assert!(platform::unprotect(b"plaintext").is_err());
    profile.forget().unwrap();
    assert_eq!(profile.refresh_token().unwrap(), None);
}
#[test]
#[ignore = "requires an isolated Electron fixture; run test/run-local.cjs"]
fn electron_saved_login_format_is_readable_by_rust() {
    let Some(file) = std::env::var_os("UNDAUNTED_RUST_ELECTRON_SESSION") else {
        return;
    };
    let file = std::path::PathBuf::from(file);
    let bytes = undaunted_launcher::profile::decrypt_electron_session(
        &fs::read(&file).unwrap(),
        &fs::read(file.parent().unwrap().join("electron-profile/Local State")).unwrap(),
    )
    .expect("Electron DPAPI compatibility");
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["marker"], "synthetic-electron-compatibility");
}
fn signed_release() -> (updates::Trust, Value) {
    let key = SigningKey::from_bytes(&[42; 32]);
    let trust = updates::Trust {
        feed: updates::Feed {
            url: "https://updates.example.org/launcher/".into(),
            requires_tailscale: false,
        },
        public_key: key
            .verifying_key()
            .to_public_key_pem(Default::default())
            .unwrap(),
        app_id: updates::APP_ID.into(),
    };
    let value = json!({"schema":1,"appId":updates::APP_ID,"channel":"stable","version":"1.0.9","releaseDate":"2026-10-05T00:00:00Z","releaseNotes":"Local test","files":[{"url":"Undaunted-Launcher-1.0.9-Setup.exe","sha512":STANDARD.encode(Sha512::digest(b"test installer")),"size":14}]});
    let bytes = serde_json::to_vec(&value).unwrap();
    (
        trust,
        json!({"payload":STANDARD.encode(&bytes),"signature":STANDARD.encode(key.sign(&bytes).to_bytes())}),
    )
}
#[test]
fn signed_protocol_rejects_tampered_payload_key_and_wrong_app() {
    let (trust, mut envelope) = signed_release();
    assert_eq!(
        updates::verify_manifest(&envelope, &trust).unwrap().version,
        "1.0.9"
    );
    envelope["payload"] = STANDARD.encode(b"{}").into();
    assert!(updates::verify_manifest(&envelope, &trust).is_err());
    let (mut trust, envelope) = signed_release();
    trust.public_key = SigningKey::from_bytes(&[43; 32])
        .verifying_key()
        .to_public_key_pem(Default::default())
        .unwrap();
    assert!(updates::verify_manifest(&envelope, &trust).is_err());
    let (mut trust, envelope) = signed_release();
    trust.app_id = "other.app".into();
    assert!(updates::verify_manifest(&envelope, &trust).is_err());
}
#[test]
fn installer_size_and_hash_are_reverified() {
    let (trust, envelope) = signed_release();
    let manifest = updates::verify_manifest(&envelope, &trust).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("installer.exe");
    fs::write(&path, b"test installer").unwrap();
    updates::verify_installer(&path, &manifest.files[0]).unwrap();
    fs::write(&path, b"fake installer").unwrap();
    assert!(updates::verify_installer(&path, &manifest.files[0]).is_err());
}
#[test]
fn stable_release_enables_updates_and_invalid_feeds_are_rejected() {
    assert!(semver::Version::parse(undaunted_launcher::VERSION).unwrap().pre.is_empty());
    assert_eq!(updates::disabled_state()["phase"], "disabled");
    for url in [
        "http://example.org/",
        "https://user:pass@example.org/",
        "https://example.org/no-slash",
        "https://example.org/?token=x",
    ] {
        assert!(
            updates::Feed {
                url: url.into(),
                requires_tailscale: false
            }
            .validate()
            .is_err()
        );
    }
}
#[test]
#[ignore = "requires a disposable staged backend; run test/run-local.cjs"]
fn actual_backend_account_refresh_logout_and_server_binding() {
    let Some(origin) = std::env::var("UNDAUNTED_RUST_TEST_BACKEND").ok() else {
        return;
    };
    assert!(origin.starts_with("http://127.0.0.1:"));
    let resources = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    fs::write(
        resources.path().join("server.json"),
        serde_json::to_vec(&json!({"server":origin})).unwrap(),
    )
    .unwrap();
    let mut launcher = undaunted_launcher::core::Launcher::new(
        resources.path().into(),
        root.path().into(),
        root.path().join("GameUserSettings.ini"),
    )
    .unwrap();
    let name = format!("R{}", platform::now() % 10000000000);
    let creds = json!({"username":name,"password":"local-test-password-2026"});
    let registered = launcher.action("register", creds.clone()).unwrap();
    assert_eq!(registered["user"]["username"], name);
    let mut reopened = undaunted_launcher::core::Launcher::new(
        resources.path().into(),
        root.path().into(),
        root.path().join("GameUserSettings.ini"),
    )
    .unwrap();
    assert_eq!(
        reopened.action("state", Value::Null).unwrap()["user"]["username"],
        name
    );
    assert!(reopened.action("logout", Value::Null).unwrap()["user"].is_null());
    assert_eq!(
        reopened.action("login", creds).unwrap()["user"]["username"],
        name
    );
    assert_eq!(
        reopened.action("updateState", Value::Null).unwrap()["phase"],
        "disabled"
    );
    assert!(reopened.action("updateInstall", Value::Null).is_err());
    let mut network = network::Network::new().unwrap();
    let session = network
        .request(
            &origin,
            "login",
            Some(json!({"username":name,"password":"local-test-password-2026"})),
            None,
        )
        .map_err(|e| e.message)
        .unwrap();
    let session = Session::parse(session).unwrap();
    let exchange = network
        .request(&origin, "exchange", Some(json!({})), Some(&session.access))
        .map_err(|e| e.message)
        .unwrap();
    assert!(
        exchange["exchangeCode"]
            .as_str()
            .is_some_and(|code| game::token(code, "ULX_", 64))
    );
    let account_file = std::path::PathBuf::from(
        std::env::var_os("UNDAUNTED_RUST_TEST_ACCOUNT").expect("Synthetic legacy account required"),
    );
    let account: Value = serde_json::from_slice(&fs::read(&account_file).unwrap()).unwrap();
    let imported = reopened.import_account(&account_file).unwrap();
    assert_eq!(imported["username"], "LegacyVeteran");
    assert!(imported.get("UUK").is_none());
    let claimed = reopened
        .action("claim", json!({"password":"local-test-password-2026"}))
        .unwrap();
    assert_eq!(claimed["user"]["userId"], account["userId"]);
    let switched = reopened
        .action("server", json!("http://127.0.0.1:9"))
        .unwrap();
    assert!(switched["user"].is_null());
    assert!(!root.path().join("session.bin").exists());
}
