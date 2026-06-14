import React from 'react';
import '../styles/AppFooter.css';

export default function AppFooter({ t }) {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="app-footer">
      <div className="footer-divider">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</div>
      
      <div className="footer-content">
        <div className="footer-section footer-copyright">
          <span>© {currentYear} {t('footer.copyright')}</span>
        </div>

        <div className="footer-section footer-links">
          <a href="/legal/terms-of-service.html" target="_blank" rel="noopener noreferrer" title={t('footer.terms')}>
            {t('footer.terms')}
          </a>
          <span className="link-separator">|</span>
          <a href="/legal/security.html" target="_blank" rel="noopener noreferrer" title={t('footer.security')}>
            {t('footer.security')}
          </a>
          <span className="link-separator">|</span>
          <a href="https://github.com/Brahim2700" target="_blank" rel="noopener noreferrer" title="GitHub Profile (Repository is private)">
            {t('footer.github')}
          </a>
        </div>

        <div className="footer-section footer-version">
          <span>v0.0.1 | {t('footer.openSource')}</span>
          <span className="link-separator">|</span>
          <a
            className="footer-email-link"
            href="mailto:frahbrahim27@hotmail.fr?subject=Code%20or%20Website%20Creation%20Request"
            title={t('footer.request')}
          >
            {t('footer.request')}
          </a>
        </div>
      </div>

      <div className="footer-credit">
        <span>{t('footer.madeBy')} <strong>FRAH BRAHIM</strong></span>
      </div>
    </footer>
  );
}
