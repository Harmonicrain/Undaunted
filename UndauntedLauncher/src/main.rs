#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};
use undaunted_launcher::{core::Launcher, platform, updates};
#[cfg(feature = "local-tests")]
mod local_tests;
type Shared = Arc<Mutex<Launcher>>;
struct UpdateShared {
    manager: Mutex<Option<updates::Updater>>,
    status: Mutex<Value>,
}
fn trusted_url(url: &url::Url) -> bool {
    let origin = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"));
    origin
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && matches!(url.path(), "/" | "/index.html")
}

#[tauri::command]
async fn launcher(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    action: String,
    value: Value,
) -> Value {
    let trusted =
        window.label() == "main" && window.url().ok().is_some_and(|url| trusted_url(&url));
    if !trusted {
        return json!({"ok":false,"message":"Invalid launcher request."});
    }
    if action.starts_with("update") {
        if action == "updateState" {
            return json!({"ok":true,"result":app.state::<Arc<UpdateShared>>().status.lock().unwrap().clone()});
        }
        let updates = app.state::<Arc<UpdateShared>>().inner().clone();
        let core = app.state::<Shared>().inner().clone();
        return match tauri::async_runtime::spawn_blocking(move || -> Result<Value,String> {
            let mut manager = updates.manager.try_lock().map_err(|_| "Please wait for the current update operation.")?;
            let manager = manager.as_mut().ok_or("Automatic updates are not configured.")?;
            let notify = |state: Value| {
                *updates.status.lock().unwrap() = state.clone();
                let _ = app.emit("launcher:updateState", state);
            };
            match action.as_str() {
                "updateCheck" => manager.check(notify),
                "updateDownload" => manager.download(notify),
                "updateInstall" => {
                    let mut core = core.try_lock().map_err(|_| "Please wait for the current launcher operation.")?;
                    if core.running()? { return Err("Close Dauntless before updating the launcher.".into()); }
                    let installer = match manager.prepare_install() {
                        Ok(file) => file,
                        Err(message) => {manager.install_failed(message.clone(),notify);return Err(message);}
                    };
                    if core.running()? { return Err("Close Dauntless before updating the launcher.".into()); }
                    let directory = std::env::current_exe().map_err(|_| "Could not locate the installed launcher.")?
                        .parent().ok_or("Invalid launcher installation.")?.to_path_buf();
                    if let Err(message)=platform::launch_installer(&installer,&directory) {
                        manager.install_failed(message.clone(),notify);return Err(message);
                    }
                    app.exit(0);
                    Ok(json!({"phase":"installing","message":"Restarting the launcher to install the update…"}))
                },
                _ => Err("Invalid launcher request.".into()),
            }
        }).await {
            Ok(Ok(result)) => json!({"ok":true,"result":result}),
            Ok(Err(message)) => json!({"ok":false,"message":message}),
            Err(_) => json!({"ok":false,"message":"The update could not complete."}),
        };
    }
    let shared = app.state::<Shared>().inner().clone();
    match tauri::async_runtime::spawn_blocking(move || {
        let mut core = shared
            .lock()
            .map_err(|_| "The launcher could not complete this request.".to_string())?;
        if let Ok(Some(monitor)) = window.primary_monitor() {
            core.display_size = (monitor.size().width, monitor.size().height);
        }
        core.action(&action, value)
    })
    .await
    {
        Ok(Ok(result)) => json!({"ok":true,"result":result}),
        Ok(Err(message)) => json!({"ok":false,"message":message}),
        Err(_) => json!({"ok":false,"message":"The launcher could not complete this request."}),
    }
}
fn main() {
    let isolated_test = false;
    #[cfg(feature = "local-tests")]
    let isolated_test = isolated_test || local_tests::isolated();
    let builder = tauri::Builder::default();
    let builder = if isolated_test {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
    };
    #[cfg(feature = "local-tests")]
    let builder =
        builder.invoke_handler(tauri::generate_handler![launcher, local_tests::test_step]);
    #[cfg(not(feature = "local-tests"))]
    let builder = builder.invoke_handler(tauri::generate_handler![launcher]);
    builder.setup(move |app| {
            let resources=if cfg!(debug_assertions) {PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")} else {
                // Portable and NSIS builds keep resources next to their executable.
                let adjacent=std::env::current_exe()?.parent().unwrap().join("launcher");
                if adjacent.join("server.json").is_file() {adjacent} else {app.path().resource_dir()?.join("launcher")}
            };
            let profile=app.path().app_data_dir()?;
            let settings=PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("Could not locate game settings.")?).join("Archon/Saved/Config/WindowsClient/GameUserSettings.ini");
            #[cfg(feature="local-tests")]
            let (resources,profile,settings)=local_tests::paths(resources,profile,settings).map_err(std::io::Error::other)?;
            let roaming=std::env::var_os("APPDATA").map(PathBuf::from);
            if !isolated_test && let Some(roaming)=roaming {
                // Failed legacy data must never prevent opening the sign-in screen.
                let _=undaunted_launcher::profile::Profile::migrate_from_roaming(&roaming,&profile);
            }
            let webview_profile=profile.join("webview");
            let core=Launcher::new(resources,profile,settings).map_err(std::io::Error::other)?;
            let updater=updates::Updater::new(&core.resources,&core.profile.root).ok();
            let status=updater.as_ref().map(|u|u.status.clone()).unwrap_or_else(updates::disabled_state);
            app.manage(Arc::new(UpdateShared{manager:Mutex::new(updater),status:Mutex::new(status)}));
            app.manage(Arc::new(Mutex::new(core)));
            let builder=tauri::WebviewWindowBuilder::from_config(app,&app.config().app.windows[0])?
                .data_directory(webview_profile)
                .theme(Some(tauri::Theme::Dark))
                .on_navigation(trusted_url)
                .on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny);
            #[cfg(feature="local-tests")]
            let builder=if std::env::var_os("UNDAUNTED_RUST_SMOKE_OPTIONS").is_some() {builder.position(-16000.0,-16000.0).focused(false)} else {builder};
            builder.build()?;
            {
                let app=app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(750));
                    let shared=app.state::<Arc<UpdateShared>>();
                    if let Ok(mut manager)=shared.manager.try_lock() && let Some(manager)=manager.as_mut() {
                        let notify=|state:Value| { *shared.status.lock().unwrap()=state.clone(); let _=app.emit("launcher:updateState",state); };
                        if manager.check(notify).ok().is_some_and(|state|state["phase"]=="available") {let _=manager.download(notify);}
                    }
                });
            }
            #[cfg(feature="local-tests")]
            local_tests::setup(app)?;
            Ok(())
        })
        .on_page_load(|webview,payload| {
            // A local UI is the only document allowed to keep access to commands.
            if payload.event()==tauri::webview::PageLoadEvent::Finished && !trusted_url(payload.url()) {let _=webview.close();}
            #[cfg(feature="local-tests")]
            if payload.event()==tauri::webview::PageLoadEvent::Finished && std::env::var_os("UNDAUNTED_RUST_SMOKE_OPTIONS").is_some() {let _=webview.eval(include_str!("../test/smoke.js"));}
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|_| {
            rfd::MessageDialog::new().set_title("Undaunted Launcher").set_level(rfd::MessageLevel::Error)
                .set_description("The launcher could not start. Reinstall the launcher and ensure Microsoft Edge WebView2 is installed.").show();
        });
}
