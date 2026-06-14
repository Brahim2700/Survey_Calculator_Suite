import React from 'react';
import '../styles/AppHeader.css';

export default function AppHeader({ uiLanguage = 'en', onLanguageChange, t }) {
  return (
    <header className="app-header">
      <div className="header-container">
        <div className="header-brand">
          <div className="brand-icon">📐</div>
          <div className="brand-text">
            <p className="brand-kicker">{t('header.kicker')}</p>
            <h1>Survey<span className="brand-title-accent">Calc</span> Geomatics Suite</h1>
            <p className="brand-subtitle">{t('header.subtitle')}</p>
          </div>
        </div>

        <div className="header-language-switch" aria-label={t('header.language')}>
          <span className="header-language-label">{t('header.language')}</span>
          <div className="header-language-buttons">
            <button
              type="button"
              className={`header-language-btn${uiLanguage === 'fr' ? ' active' : ''}`}
              onClick={() => onLanguageChange?.('fr')}
            >
              FR
            </button>
            <button
              type="button"
              className={`header-language-btn${uiLanguage === 'en' ? ' active' : ''}`}
              onClick={() => onLanguageChange?.('en')}
            >
              EN
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
