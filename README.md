# Jelopathy Messenger 🚀
> **A Minimalist, Local-First, Modern Dark Mode Desktop Messenger with Real-Time WebP Image Processing and Zero-Persistence WebSocket Routing.**

![Tauri](https://img.shields.io/badge/Tauri-v2-blue?style=flat-square&logo=tauri)
![Rust](https://img.shields.io/badge/Rust-1.75+-orange?style=flat-square&logo=rust)
![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react)
![TailwindCSS](https://img.shields.io/badge/Tailwind-CSS-38B2AC?style=flat-square&logo=tailwind-css)
![SQLite](https://img.shields.io/badge/SQLite-Local_Storage-003B57?style=flat-square&logo=sqlite)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

---

## 📖 Overview

**Jelopathy** is a high-performance desktop messaging application built with **Tauri (Rust)**, **React**, **TypeScript**, and **Tailwind CSS**. It is designed with a strict **Local-First Privacy** architecture: all chats, images, and user profiles are stored purely on your local machine using SQLite and local AppData storage. The remote relay server is completely transient and retains zero data on disk.

Jelopathy features Telegram-style message bubbles, Farsi/Persian typography support, dynamic RTL/LTR text detection, inline and syntax-highlighted code block rendering, automatic image-to-WebP compression, and a democratic 70% threshold group-joining vote system.

---

## ✨ Key Features

- **🖤 Minimalist Monochrome Dark Theme**: High-contrast, slick dark aesthetics matching modern OS windowing styles.
- **⚡ Local-First & Zero Server Storage**:
  - **Profile Data**: Stored under `%appdata%/.Jelopathy/usersdata.json`.
  - **Messages & History**: Saved locally in `%appdata%/.Jelopathy/jelopathy.db` (SQLite).
  - **Relay Server**: Ephemeral WebSocket broker with zero disk/database persistence.
- **🖼️ WebP Image Optimization**: Client-side screenshots/images are converted to compressed base64 WebP format via Rust backend before broadcast.
- **💬 Mixed Code & Formatting**:
  - Auto-detection of language blocks (e.g., ` ```python `) with copy buttons and collapse buttons.
  - Support for inline code blocks (`` `code` ``) inside standard messages.
- **📝 Smart Multiline Input**:
  - `Enter` sends the message; `Shift + Enter` inserts a newline.
  - Auto-expands up to 3x height before enabling scrollbar.
  - RTL placeholder with auto-direction detection for typed text.
- **🗳️ Democratic Group Joining**: Joining an active group room broadcasts a poll to online members requiring a **>70% positive vote ratio** to accept new members.
- **👥 Active Peer Tiles**: Account details panel displays interactive tiles of all online conversation members.

---

## 🛠️ Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                    Jelopathy Desktop App                    │
│                                                             │
│   ┌─────────────────────────┐     ┌─────────────────────┐   │
│   │   React + Tailwind UI   │ ◄──►│    Tauri Backend    │   │
│   │ (State / Components /   │ IPC │ (Image WebP Convert │   │
│   │   Textarea Auto-Resize) │     │  & SQLite Manager)  │   │
│   └────────────┬────────────┘     └──────────┬──────────┘   │
└────────────────┼─────────────────────────────┼──────────────┘
                 │                             │
    WebSocket    │                 Local DB    │ SQLite
    (JSON Msgs)  ▼                             ▼
   ┌───────────────────┐               ┌───────────────┐
   │ Transient Relay   │               │ Local Storage │
   │ WebSocket Server  │               │ %appdata%/    │
   │ (In-Memory Only)  │               │ .Jelopathy/   │
   └───────────────────┘               └───────────────┘