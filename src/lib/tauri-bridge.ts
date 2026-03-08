/**
 * Bridge to Tauri backend commands.
 * Falls back to browser File API when Tauri is not available (dev mode).
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauri(): boolean {
  return typeof window.__TAURI_INTERNALS__ !== "undefined";
}

/** Open a file dialog and read the selected ROM file. */
export async function openRomFile(): Promise<{ buffer: ArrayBuffer; path: string } | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");

    const selected = await open({
      multiple: false,
      filters: [{ name: "NDS ROM", extensions: ["nds"] }],
    });

    if (!selected) return null;
    const path = typeof selected === "string" ? selected : (selected as { path: string }).path;

    const data: number[] = await invoke("read_rom_file", { path });
    const buffer = new Uint8Array(data).buffer;
    return { buffer, path };
  }

  // Fallback: browser file picker
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".nds";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const buffer = await file.arrayBuffer();
      resolve({ buffer, path: file.name });
    };
    input.click();
  });
}

/** Save modified ROM data to a file. */
export async function saveRomFile(
  data: ArrayBuffer,
  defaultPath?: string
): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");

    const path = await save({
      defaultPath: defaultPath?.replace(".nds", "_modified.nds"),
      filters: [{ name: "NDS ROM", extensions: ["nds"] }],
    });

    if (!path) return false;
    await invoke("write_rom_file", { path, data: Array.from(new Uint8Array(data)) });
    return true;
  }

  // Fallback: browser download
  const blob = new Blob([data], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (defaultPath || "rom") + "_modified.nds";
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
