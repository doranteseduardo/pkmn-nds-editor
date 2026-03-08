use std::fs;

#[tauri::command]
fn read_rom_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("Failed to read ROM: {}", e))
}

#[tauri::command]
fn write_rom_file(path: String, data: Vec<u8>) -> Result<(), String> {
    fs::write(&path, &data).map_err(|e| format!("Failed to write ROM: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![read_rom_file, write_rom_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
