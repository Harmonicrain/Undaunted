// Compiled only into the disposable local test binary. No hook in the release.
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};
use tauri::Manager;
use undaunted_launcher::Result;
use webview2_com::{
    CapturePreviewCompletedHandler,
    Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
};
use windows::{Win32::UI::Shell::SHCreateStreamOnFileEx, core::PCWSTR};
fn directory() -> Result<PathBuf> {
    let path =
        std::env::var_os("UNDAUNTED_RUST_SMOKE_OPTIONS").ok_or("No local test configuration.")?;
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "Missing local test configuration.")?;
    let artifacts = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("artifacts")
        .canonicalize()
        .map_err(|_| "Missing local artifacts.")?;
    if !path.starts_with(artifacts)
        || path.file_name().unwrap_or_default() != "rust-smoke-options.json"
    {
        return Err("Local tests require an isolated artifacts folder.".into());
    }
    Ok(path.parent().unwrap().into())
}
pub fn isolated() -> bool {
    std::env::var_os("UNDAUNTED_RUST_SMOKE_OPTIONS").is_some() && directory().is_ok()
}
pub fn paths(
    resources: PathBuf,
    profile: PathBuf,
    settings: PathBuf,
) -> Result<(PathBuf, PathBuf, PathBuf)> {
    if std::env::var_os("UNDAUNTED_RUST_SMOKE_OPTIONS").is_none() {
        return Ok((resources, profile, settings));
    }
    let root = directory()?;
    let config: Value = serde_json::from_slice(
        &std::fs::read(root.join("rust-smoke-options.json"))
            .map_err(|_| "Invalid test options.")?,
    )
    .map_err(|_| "Invalid test options.")?;
    let origin = config["server"].as_str().ok_or("Invalid test server.")?;
    if !origin.starts_with("http://127.0.0.1:") {
        return Err("Tests may only use loopback.".into());
    }
    let resources = root.join("resources");
    std::fs::create_dir_all(&resources).map_err(|_| "Could not create test resources.")?;
    std::fs::write(
        resources.join("server.json"),
        serde_json::to_vec(&json!({"server":origin})).unwrap(),
    )
    .map_err(|_| "Could not create test resources.")?;
    Ok((
        resources,
        root.join("profile"),
        root.join("GameUserSettings.ini"),
    ))
}
pub fn setup(app: &tauri::App) -> std::result::Result<(), Box<dyn std::error::Error>> {
    if std::env::var_os("UNDAUNTED_RUST_SMOKE_OPTIONS").is_none() {
        return Ok(());
    }
    directory().map_err(std::io::Error::other)?;
    let window = app
        .get_webview_window("main")
        .ok_or("Missing test window.")?;
    window.set_position(tauri::PhysicalPosition::new(-16000, -16000))?;
    Ok(())
}
#[tauri::command]
pub async fn test_step(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    name: String,
    passed: bool,
) -> std::result::Result<Value, String> {
    let root = directory()?;
    if window.label() != "main"
        || !window
            .url()
            .ok()
            .is_some_and(|url| super::trusted_url(&url))
    {
        return Err("Invalid test window.".into());
    }
    if name == "finish" || name == "failed" {
        std::fs::write(
            root.join("ui-result.json"),
            serde_json::to_vec(&json!({"passed":passed && name=="finish"})).unwrap(),
        )
        .map_err(|_| "Could not save test result.")?;
        app.exit(if passed && name == "finish" { 0 } else { 1 });
        return Ok(Value::Null);
    }
    if name == "resize-minimum" {
        window
            .set_size(tauri::LogicalSize::new(900.0, 690.0))
            .map_err(|_| "Could not resize the test window.")?;
        return Ok(Value::Null);
    }
    if ![
        "login",
        "register",
        "claim",
        "settings",
        "news",
        "signed-in",
        "signed-out",
        "register-bottom",
        "settings-server",
        "news-fixes",
        "minimum-login",
        "claim-bottom",
    ]
    .contains(&name.as_str())
    {
        return Err("Invalid screenshot name.".into());
    }
    if !passed {
        return Err("UI assertion failed.".into());
    }
    let file = root.join(format!("{name}.png"));
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .with_webview(move |platform| {
            let result = (|| -> windows::core::Result<()> {
                let wide: Vec<u16> = file
                    .as_os_str()
                    .to_string_lossy()
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let stream = unsafe {
                    SHCreateStreamOnFileEx(PCWSTR(wide.as_ptr()), 0x1001, 0, true, None)
                }?;
                let callback_stream = stream.clone();
                let callback = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                    let result = result
                        .and_then(|_| unsafe {
                            callback_stream.Commit(windows::Win32::System::Com::STGC(0))
                        })
                        .map_err(|_| "Could not capture WebView2.".to_string());
                    let _ = tx.send(result);
                    Ok(())
                }));
                unsafe {
                    platform.controller().CoreWebView2()?.CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                        &stream,
                        &callback,
                    )
                }?;
                Ok(())
            })();
            // If starting capture fails, the receiver disconnects and reports failure.
            let _ = result;
        })
        .map_err(|_| "Could not access WebView2.")?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(15))
            .map_err(|_| "Screenshot timed out.".to_string())?
    })
    .await
    .map_err(|_| "Screenshot failed.")??;
    Ok(Value::Null)
}
