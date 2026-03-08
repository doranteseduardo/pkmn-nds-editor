# Pokémon DPPt Map Editor

A web-based map editor for **Pokémon Diamond**, **Pearl**, and **Platinum** (Nintendo DS), built with **React + TypeScript + Tauri**.

## Features

- **ROM Parsing**: Load NDS ROM files and browse the internal filesystem (FAT/FNT)
- **Permission Grid Editor**: Visual 32×32 tile grid with paint, fill, and pick tools
- **Event Editor**: Place and edit NPCs, warps, triggers, and signs with property panels
- **Map Matrix Navigator**: Navigate the overworld grid to quickly jump between maps
- **Encounter Viewer**: View grass, surf, and special encounter tables per map
- **ROM Export**: Save modified maps and events back to a patched ROM

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (latest stable)
- [Tauri CLI](https://tauri.app/start/prerequisites/)

## Setup

```bash
# Install dependencies
npm install

# Run in development mode (browser only, no Tauri)
npm run dev

# Run with Tauri (native desktop app)
npm run tauri dev

# Build for production
npm run tauri build
```

## Development

The app works in two modes:

1. **Browser mode** (`npm run dev`): Uses the File API for ROM loading/saving. Good for rapid UI development.
2. **Tauri mode** (`npm run tauri dev`): Full native file system access via Rust backend. Required for proper Save functionality.

## Project Structure

```
src/
├── lib/               # Binary parsers and data models
│   ├── binary.ts      # Low-level binary read/write
│   ├── nds-rom.ts     # NDS ROM header, FAT, FNT parser
│   ├── narc.ts        # NARC archive parser/builder
│   ├── map-data.ts    # Map permission & building parser
│   ├── events.ts      # Event data (NPCs, warps, triggers, signs)
│   ├── encounters.ts  # Wild Pokémon encounter tables
│   ├── map-matrix.ts  # Map matrix (overworld grid) parser
│   └── tauri-bridge.ts # Tauri ↔ browser bridge for file I/O
├── components/        # React UI components
│   ├── MapCanvas.tsx   # Main canvas editor with zoom/pan
│   ├── Sidebar.tsx     # Map list and matrix navigator
│   ├── RightPanel.tsx  # Permission palette, events, encounters
│   └── FileTreeModal.tsx # ROM filesystem browser
├── styles/
│   └── global.css     # Full application styling
├── App.tsx            # Main application component
└── main.tsx           # Entry point
src-tauri/
├── src/
│   ├── lib.rs         # Tauri commands (read/write ROM)
│   └── main.rs        # Tauri entry point
├── Cargo.toml
└── tauri.conf.json
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `P` | Paint tool |
| `F` | Fill tool |
| `I` | Pick (eyedropper) tool |
| `E` | Event selection tool |
| `Alt+Drag` | Pan the view |
| `Scroll` | Zoom in/out |
| `Ctrl/Cmd+S` | Save ROM |

## Supported Games

| Game | Region | Code |
|------|--------|------|
| Diamond | US/EU/JP/KR | ADAE/ADAP/ADAJ/ADAK |
| Pearl | US/EU/JP/KR | APAE/APAP/APAJ/APAK |
| Platinum | US/EU/JP/KR | CPUE/CPUP/CPUJ/CPUK |

## Technical Notes

- Map permissions are stored as a 32×32 grid of 16-bit values in `land_data` NARCs
- Event data uses fixed-size entries: overworlds (32B), warps (12B), triggers (16B), signs (12B)
- The editor patches files in-place within the ROM; if a modified NARC exceeds its original size, data may be truncated (a warning is shown)
- 3D map models (NSBMD format) are preserved but not rendered; editing is focused on the 2D permission/event layers
