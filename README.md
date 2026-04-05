<div align="center">

# Pokemon DPPt Map Editor

**A cross-platform map editor for Pokemon Diamond, Pearl, and Platinum**

[![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?style=flat-square&logo=tauri)](https://v2.tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-stable-CE422B?style=flat-square&logo=rust)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/License-MIT-10B981?style=flat-square)](LICENSE)

Load NDS ROM files, edit permission grids, place events, navigate the overworld matrix, and export a patched ROM — all without leaving the editor. Supports Diamond, Pearl, and Platinum for US/EU/JP/KR regions.

</div>

---

## What it does

| Module | Description |
|---|---|
| **ROM Parser** | Loads NDS ROMs, parses the FAT/FNT filesystem and NARC archives |
| **Permission Grid** | Visual 32x32 tile editor with paint, fill, and eyedropper tools |
| **Event Editor** | Place and edit NPCs, warps, triggers, and signs with property panels |
| **Map Matrix** | Overworld grid navigator — jump between maps with a single click |
| **Encounter Viewer** | View grass, surf, and special encounter tables per map |
| **ROM Export** | Patches modified maps and events back into the ROM |

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 · TypeScript · Vite |
| Desktop shell | Tauri v2 (Rust) |
| ROM parsing | Custom NDS FAT/FNT + NARC parser (TypeScript) |
| Canvas | HTML5 Canvas 2D with zoom/pan |

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)

```bash
npm install

# Browser-only mode (rapid UI development, File API for ROM I/O)
npm run dev

# Full native app (Tauri, required for proper Save)
npm run tauri dev

# Production build
npm run tauri build
```

---

## Architecture

```
src/
├── lib/
│   ├── binary.ts          # Low-level binary read/write
│   ├── nds-rom.ts         # NDS ROM header, FAT, FNT parser
│   ├── narc.ts            # NARC archive parser/builder
│   ├── map-data.ts        # Map permission & building parser
│   ├── events.ts          # Event data (NPCs, warps, triggers, signs)
│   ├── encounters.ts      # Wild encounter tables
│   ├── map-matrix.ts      # Overworld grid parser
│   └── tauri-bridge.ts    # Tauri / browser file I/O bridge
├── components/
│   ├── MapCanvas.tsx      # Main canvas editor with zoom/pan
│   ├── Sidebar.tsx        # Map list and matrix navigator
│   ├── RightPanel.tsx     # Permission palette, events, encounters
│   └── FileTreeModal.tsx  # ROM filesystem browser
├── App.tsx
└── main.tsx

src-tauri/
├── src/
│   ├── lib.rs             # Tauri commands (read/write ROM)
│   └── main.rs
└── Cargo.toml
```

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `P` | Paint tool |
| `F` | Fill tool |
| `I` | Eyedropper |
| `E` | Event selection |
| `Alt+Drag` | Pan viewport |
| `Scroll` | Zoom in/out |
| `Ctrl+S` | Save ROM |

---

## Roadmap

```
[x] NDS ROM filesystem parser (FAT/FNT)
[x] NARC archive parser/builder
[x] Permission grid editor (paint, fill, pick)
[x] Event editor (NPCs, warps, triggers, signs)
[x] Map matrix navigator
[x] Encounter viewer
[x] ROM export with in-place NARC patching
[ ] NSBMD 3D model preview
[ ] Script editor
[ ] Trainer data editor
```

---

<div align="center">
  <sub>Fan project · Not affiliated with Nintendo or Game Freak · MIT License</sub>
</div>
