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
            <p className="brand-subtitle">Coordinate Conversion, CRS Detection, Benchmarking, and Survey Computation Workspace</p>
          </div>
        </div>

      </div>
    </header>
  );
}
