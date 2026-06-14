import React from 'react';
import '../styles/AppFooter.css';

export default function AppFooter() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="app-footer">
      <div className="footer-divider">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</div>
      
      <div className="footer-content">
        <div className="footer-section footer-copyright">
          <span>© {currentYear} Survey Calculator | MIT License</span>
        </div>

        <div className="footer-section footer-links">
          <a href="/legal/terms-of-service.html" target="_blank" rel="noopener noreferrer" title="Terms of Service">
            Terms of Service
          </a>
          <span className="link-separator">|</span>
          <a href="/legal/security.html" target="_blank" rel="noopener noreferrer" title="Security Policy">
            Security
          </a>
          <span className="link-separator">|</span>
          <a href="https://github.com/Brahim2700" target="_blank" rel="noopener noreferrer" title="GitHub Profile (Repository is private)">
            GitHub (Profile)
          </a>
        </div>

        <div className="footer-section footer-version">
          <span>v0.0.1 | Open Source</span>
          <span className="link-separator">|</span>
          <a
            className="footer-email-link"
            href="mailto:frahbrahim27@hotmail.fr?subject=Code%20or%20Website%20Creation%20Request"
            title="Request source code or website creation"
          >
            Request Code or Website (Email)
          </a>
        </div>
      </div>

      <div className="footer-credit">
        <span>Made by <strong>FRAH BRAHIM</strong></span>
      </div>
    </footer>
  );
}
