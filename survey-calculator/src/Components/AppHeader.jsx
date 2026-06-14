import React from 'react';
import '../styles/AppHeader.css';

export default function AppHeader() {
  return (
    <header className="app-header">
      <div className="header-container">
        <div className="header-brand">
          <div className="brand-icon">📐</div>
          <div className="brand-text">
            <p className="brand-kicker">Professional Geomatics Platform</p>
            <h1>Survey<span className="brand-title-accent">Calc</span> Geomatics Suite</h1>
            <p className="brand-subtitle">Coordinate Conversion, Benchmarking, and Survey Computation Workspace</p>
          </div>
        </div>

        <div className="header-security">
          <div className="security-badge">
            <span className="badge-icon">🔒</span>
            <span className="badge-text">MIT Licensed</span>
          </div>
          <div className="security-badge secure">
            <span className="badge-icon">✓</span>
            <span className="badge-text">Open Source</span>
          </div>
        </div>
      </div>
    </header>
  );
}
