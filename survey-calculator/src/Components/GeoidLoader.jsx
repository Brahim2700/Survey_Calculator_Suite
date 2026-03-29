// src/Components/GeoidLoader.jsx
// Status indicator only - all grids load on-demand

import { useEffect } from "react";

const GeoidLoader = ({ onLoadComplete }) => {
  useEffect(() => {
    // Immediately signal ready - no grids loaded
    if (onLoadComplete) onLoadComplete(['ready'], []);
  }, [onLoadComplete]); // Add dependency

  return (
    <div style={{ marginBottom: "1rem" }}>
      <div style={{
        padding: "0.75rem",
        backgroundColor: "#d4edda",
        border: "1px solid #c3e6cb",
        borderRadius: "4px",
        fontSize: "0.85rem",
        color: "#155724"
      }}>
        ✓ 3D conversion ready. Geoid grids will load automatically when needed.
      </div>
    </div>
  );
};

export default GeoidLoader;