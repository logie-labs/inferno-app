pub mod addons;
pub mod library;
pub mod settings_file;

use addons::inferno_service::{self, ServiceState};
use addons::soundpad::{commands, SoundpadRemoteControl, SoundpadState};
use library::LibraryState;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .manage(SoundpadState::new(SoundpadRemoteControl::new()))
    .invoke_handler(tauri::generate_handler![
      inferno_service::commands::inferno_service_endpoint,
      inferno_service::commands::inferno_service_status,
      inferno_service::files::inferno_open_path,
      inferno_service::files::inferno_open_url,
      inferno_service::files::inferno_reveal_path,
      inferno_service::files::inferno_existing_ancestor,
            inferno_service::files::inferno_place_download,
      inferno_service::directory::inferno_check_directory,
            inferno_service::directory::inferno_pick_directory,
      library::commands::library_record,
      library::commands::library_list,
      library::commands::library_summary,
      library::commands::library_verify,
      library::commands::library_forget,
      library::commands::library_delete,
      library::commands::library_locate,
      library::commands::library_relocate,
      addons::spotify::commands::spotify_survey,
      addons::spotify::commands::spotify_place,
      addons::spotify::commands::spotify_folder_tracks,
      addons::spotify::commands::spotify_pick_folder,
      settings_file::settings_export,
      settings_file::settings_import,
      commands::soundpad_play_sound,
      commands::soundpad_play_sound_from_category,
      commands::soundpad_play_previous_sound,
      commands::soundpad_play_next_sound,
      commands::soundpad_stop_sound,
      commands::soundpad_toggle_pause,
      commands::soundpad_jump_ms,
      commands::soundpad_seek_ms,
      commands::soundpad_play_random_sound,
      commands::soundpad_play_random_sound_from_category,
      commands::soundpad_play_selected_sound,
      commands::soundpad_play_current_sound_again,
      commands::soundpad_play_previously_played_sound,
      commands::soundpad_add_sound,
      commands::soundpad_remove_selected_entries,
      commands::soundpad_get_sound_file_count,
      commands::soundpad_search,
      commands::soundpad_reset_search,
      commands::soundpad_select_previous_hit,
      commands::soundpad_select_next_hit,
      commands::soundpad_select_row,
      commands::soundpad_scroll_by,
      commands::soundpad_scroll_to,
      commands::soundpad_undo,
      commands::soundpad_redo,
      commands::soundpad_add_category,
      commands::soundpad_select_category,
      commands::soundpad_select_previous_category,
      commands::soundpad_select_next_category,
      commands::soundpad_remove_category,
      commands::soundpad_get_volume,
      commands::soundpad_is_muted,
      commands::soundpad_toggle_mute,
      commands::soundpad_get_play_status,
      commands::soundpad_get_playback_position,
      commands::soundpad_get_playback_duration,
      commands::soundpad_get_sound_list,
      commands::soundpad_get_main_frame_title_text,
      commands::soundpad_get_status_bar_text,
      commands::soundpad_get_version,
      commands::soundpad_get_remote_control_version,
      commands::soundpad_is_compatible,
      commands::soundpad_is_alive,
      commands::soundpad_is_trial,
      commands::soundpad_start_recording,
      commands::soundpad_stop_recording,
      commands::soundpad_start_recording_speakers,
      commands::soundpad_start_recording_microphone,
      commands::soundpad_get_recording_position,
      commands::soundpad_get_recording_peak,
    ])
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Blocking on purpose: the Downloads screen is useless without a
      // service, so the window opens once there is one to talk to. A failure
      // here is not fatal - it is kept and handed to the frontend, which
      // renders its offline state with the actual reason rather than a shrug.
      let service = match inferno_service::launch(app.handle()) {
        Ok(handle) => ServiceState::Running(Box::new(handle)),
        Err(error) => {
          log::error!("{error}");
          ServiceState::Failed(error)
        }
      };
      app.manage(service);

      // The library is not load-bearing: without it the app still downloads,
      // it just cannot remember what it downloaded, so a failure here is
      // logged and the state left empty rather than taking the window down.
      let library: LibraryState = match app.path().app_data_dir() {
        Ok(directory) => match library::Library::open(&directory.join("library.sqlite3")) {
          Ok(library) => Some(library),
          Err(error) => {
            log::error!("{error}");
            None
          }
        },
        Err(error) => {
          log::error!("no data directory for the library: {error}");
          None
        }
      };
      app.manage(library);

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while running tauri application");

  app.run(|handle, event| {
    // A Windows child does not die with its parent. The job object in
    // `process.rs` is the unconditional guarantee; this is the tidy path that
    // also closes the port before the next launch asks for one.
    if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
      if let Some(service) = handle.try_state::<ServiceState>() {
        if let Some(service) = service.handle() {
          service.shutdown();
        }
      }
    }
  });
}
