import { useState } from "react";
import type { DirNode, FSNode } from "../lib/nds-rom";

interface Props {
  tree: DirNode;
  onClose: () => void;
}

export default function FileTreeModal({ tree, onClose }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["/"]));

  const toggle = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const renderNode = (node: FSNode, path: string, depth: number): JSX.Element => {
    const fullPath = path + node.name;
    const isNarc = node.name.endsWith(".narc");

    if (node.type === "dir") {
      const isExpanded = expanded.has(fullPath);
      return (
        <div key={fullPath}>
          <div
            className="tree-item tree-dir"
            style={{ paddingLeft: depth * 16 }}
            onClick={() => toggle(fullPath)}
          >
            <span>{isExpanded ? "▾" : "▸"}</span>
            <span>📁 {node.name}/</span>
          </div>
          {isExpanded && node.children?.map(c => renderNode(c, fullPath + "/", depth + 1))}
        </div>
      );
    }

    return (
      <div
        key={fullPath}
        className={`tree-item ${isNarc ? "tree-narc" : "tree-file"}`}
        style={{ paddingLeft: depth * 16 }}
      >
        <span>{isNarc ? "📦" : "📄"}</span>
        <span>{node.name}</span>
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>
          #{node.fileId}
          {node.end - node.start > 0 ? ` (${((node.end - node.start) / 1024).toFixed(1)}KB)` : ""}
        </span>
      </div>
    );
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>📁 ROM Filesystem</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {tree.children?.map(c => renderNode(c, "/", 0))}
        </div>
      </div>
    </div>
  );
}
