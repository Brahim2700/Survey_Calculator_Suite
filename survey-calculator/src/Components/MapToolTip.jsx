// src/Components/MapToolTip.jsx
// Shared floating tooltip component used throughout the toolbar.
// Renders a styled popup below the wrapped element on hover.
// The popup disappears immediately when the cursor leaves.
import { useState } from "react";

/**
 * MapToolTip
 *
 * Wrap any toolbar button (or element) with this component to display
 * a rich floating tooltip when the user hovers over it.
 *
 * Props:
 *   title       – Short heading shown in blue at the top of the popup.
 *   description – One-to-three sentence explanation of what the tool does.
 *   children    – The button or element to wrap.
 *
 * Behaviour:
 *   - Popup appears instantly on mouseEnter, disappears on mouseLeave.
 *   - Positioned below the wrapped element, centred horizontally.
 *   - Uses CSS class "map-tooltip-popup" (defined in App.css).
 */
function MapToolTip({ children, title, description }) {
  const [visible, setVisible] = useState(false);

  return (
    <div
      className="map-tooltip-wrapper"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div className="map-tooltip-popup" role="tooltip">
          <div className="map-tooltip-title">{title}</div>
          <div className="map-tooltip-desc">{description}</div>
        </div>
      )}
    </div>
  );
}

export default MapToolTip;
