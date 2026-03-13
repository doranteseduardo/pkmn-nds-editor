/**
 * Debug panel that renders each decoded NDS texture as a small canvas.
 * Used to visually verify that texture parsing and decoding are working correctly,
 * independent of the 3D renderer.
 */

import { useRef, useEffect, useState } from "react";
import type { NdsTexture } from "../lib/nsbtx";

interface Props {
  textures: NdsTexture[];
  visible: boolean;
  onClose: () => void;
}

export default function TextureDebugPanel({ textures, visible, onClose }: Props) {
  if (!visible || textures.length === 0) return null;

  return (
    <div style={{
      position: "fixed",
      top: 0,
      right: 0,
      width: 320,
      height: "100vh",
      background: "#1a1a2e",
      borderLeft: "1px solid #333",
      overflowY: "auto",
      zIndex: 1000,
      padding: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ color: "#ccc", fontSize: 13, fontWeight: "bold" }}>
          Texture Debug ({textures.length})
        </span>
        <button
          onClick={onClose}
          style={{ background: "#333", color: "#ccc", border: "none", borderRadius: 4, padding: "2px 8px", cursor: "pointer" }}
        >
          Close
        </button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {textures.map((tex, i) => (
          <TextureTile key={`${tex.name}-${i}`} texture={tex} />
        ))}
      </div>
    </div>
  );
}

function TextureTile({ texture }: { texture: NdsTexture }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = texture.width;
    canvas.height = texture.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const imageData = ctx.createImageData(texture.width, texture.height);
    imageData.data.set(texture.rgba);
    ctx.putImageData(imageData, 0, 0);
  }, [texture]);

  // Scale small textures for visibility
  const displaySize = Math.min(96, Math.max(48, texture.width));
  const scale = displaySize / texture.width;

  return (
    <div
      style={{
        background: "#222",
        borderRadius: 4,
        padding: 2,
        position: "relative",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: displaySize,
          height: texture.height * scale,
          imageRendering: "pixelated",
          display: "block",
        }}
      />
      <div style={{
        fontSize: 9,
        color: "#999",
        textAlign: "center",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        width: displaySize,
      }}>
        {texture.name}
      </div>

      {hovered && (
        <div style={{
          position: "absolute",
          bottom: "100%",
          left: 0,
          background: "#000",
          color: "#ddd",
          padding: "4px 6px",
          borderRadius: 4,
          fontSize: 10,
          whiteSpace: "nowrap",
          zIndex: 10,
          border: "1px solid #555",
        }}>
          {texture.name} | fmt={texture.format} | {texture.width}x{texture.height}
        </div>
      )}
    </div>
  );
}
