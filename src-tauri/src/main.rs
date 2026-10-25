// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use image::imageops::FilterType;
use image::ImageFormat;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Cursor, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UserProfile {
    pub id: String,
    pub name: String,
    pub photo_b64: Option<String>,
    pub color: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub id: String,
    pub room_id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub content: String,
    pub msg_type: String, // "text" | "image" | "code"
    pub timestamp: i64,
}

pub struct AppState {
    pub db: Mutex<Connection>,
    pub app_dir: PathBuf,
}

fn resolve_app_dir(app_handle: &AppHandle) -> PathBuf {
    let dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from(".Jelopathy"));
    fs::create_dir_all(&dir).ok();
    dir
}

fn init_db(app_dir: &PathBuf) -> Result<Connection, String> {
    let db_path = app_dir.join("jelopathy.db");
    let conn = Connection::open(db_path).map_err(|e| format!("Could not open local message database: {e}"))?;

    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA foreign_keys = ON;",
    ).map_err(|e| format!("Could not configure local database: {e}"))?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL,
            sender_id TEXT NOT NULL,
            sender_name TEXT NOT NULL,
            content TEXT NOT NULL,
            msg_type TEXT NOT NULL,
            timestamp INTEGER NOT NULL
        )", [],
    ).map_err(|e| format!("Could not initialize message table: {e}"))?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_room_time ON messages(room_id, timestamp DESC)", [],
    ).map_err(|e| format!("Could not initialize message index: {e}"))?;
    Ok(conn)
}

#[tauri::command]
fn get_user_profile(state: State<AppState>) -> Result<Option<UserProfile>, String> {
    let path = state.app_dir.join("usersdata.json");
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let profile: UserProfile = serde_json::from_str(&contents).map_err(|e| e.to_string())?;
    Ok(Some(profile))
}

#[tauri::command]
fn save_user_profile(profile: UserProfile, state: State<AppState>) -> Result<(), String> {
    let target_path = state.app_dir.join("usersdata.json");
    let temp_path = state.app_dir.join("usersdata.json.tmp");

    let data = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    
    {
        let mut file = File::create(&temp_path).map_err(|e| e.to_string())?;
        file.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    // Windows does not consistently replace an existing target via rename. Keep a backup
    // during replacement so a failed write does not destroy the last valid profile.
    let backup_path = state.app_dir.join("usersdata.json.bak");
    if target_path.exists() {
        let _ = fs::remove_file(&backup_path);
        fs::rename(&target_path, &backup_path).map_err(|e| format!("Could not back up existing profile: {e}"))?;
    }
    if let Err(err) = fs::rename(&temp_path, &target_path) {
        if backup_path.exists() { let _ = fs::rename(&backup_path, &target_path); }
        return Err(format!("Could not save profile: {err}"));
    }
    let _ = fs::remove_file(backup_path);
    Ok(())
}

#[tauri::command]
fn save_message(msg: ChatMessage, state: State<AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO messages (id, room_id, sender_id, sender_name, content, msg_type, timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            msg.id,
            msg.room_id,
            msg.sender_id,
            msg.sender_name,
            msg.content,
            msg.msg_type,
            msg.timestamp
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// High-speed transactional batch saving for sync payloads
#[tauri::command]
fn save_messages_batch(msgs: Vec<ChatMessage>, state: State<AppState>) -> Result<(), String> {
    if msgs.len() > 1000 {
        return Err("A sync batch cannot exceed 1000 messages".to_string());
    }
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO messages (id, room_id, sender_id, sender_name, content, msg_type, timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| e.to_string())?;

        for msg in &msgs {
            stmt.execute(params![
                msg.id,
                msg.room_id,
                msg.sender_id,
                msg.sender_name,
                msg.content,
                msg.msg_type,
                msg.timestamp
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_messages(
    room_id: String,
    offset: i64,
    limit: i64,
    state: State<AppState>,
) -> Result<Vec<ChatMessage>, String> {
    if room_id.trim().is_empty() { return Err("Room ID cannot be empty".to_string()); }
    let safe_limit = limit.clamp(1, 200);
    let safe_offset = offset.max(0);
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    let mut stmt = conn
        .prepare(
            "SELECT id, room_id, sender_id, sender_name, content, msg_type, timestamp
             FROM (
                 SELECT id, room_id, sender_id, sender_name, content, msg_type, timestamp
                 FROM messages 
                 WHERE room_id = ?1 
                 ORDER BY timestamp DESC 
                 LIMIT ?2 OFFSET ?3
             ) 
             ORDER BY timestamp ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![room_id, safe_limit, safe_offset], |row| {
            Ok(ChatMessage {
                id: row.get(0)?,
                room_id: row.get(1)?,
                sender_id: row.get(2)?,
                sender_name: row.get(3)?,
                content: row.get(4)?,
                msg_type: row.get(5)?,
                timestamp: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::with_capacity(safe_limit as usize);
    for row in rows {
        result.push(row.map_err(|e| format!("Could not read local message: {e}"))?);
    }
    Ok(result)
}

#[tauri::command]
fn convert_to_webp(base64_raw: String) -> Result<String, String> {
    if base64_raw.len() > 12 * 1024 * 1024 {
        return Err("Image is too large. Maximum encoded size is 12 MiB".to_string());
    }
    let raw = if let Some(idx) = base64_raw.find(',') {
        &base64_raw[idx + 1..]
    } else {
        &base64_raw
    };

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    let mut img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;

    const MAX_DIM: u32 = 1280;
    if img.width() > MAX_DIM || img.height() > MAX_DIM {
        img = img.resize(MAX_DIM, MAX_DIM, FilterType::Triangle);
    }

    let mut webp_bytes: Vec<u8> = Vec::new();
    img.write_to(&mut Cursor::new(&mut webp_bytes), ImageFormat::WebP)
        .map_err(|e| format!("WebP conversion error: {}", e))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(&webp_bytes);
    Ok(format!("data:image/webp;base64,{}", encoded))
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let app_dir = resolve_app_dir(app.handle());
            let conn = init_db(&app_dir).map_err(|e| {
                eprintln!("Jelopathy database initialization failed: {e}");
                std::io::Error::new(std::io::ErrorKind::Other, e)
            })?;
            app.manage(AppState {
                db: Mutex::new(conn),
                app_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_user_profile,
            save_user_profile,
            save_message,
            save_messages_batch,
            get_messages,
            convert_to_webp
        ])
        .run(tauri::generate_context!())
        .expect("error while running Jelopathy Tauri application");
}