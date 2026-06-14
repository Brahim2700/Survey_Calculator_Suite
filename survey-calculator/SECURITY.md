# Security Policy

## Reporting a Vulnerability

Survey Calculator takes security seriously. If you discover a security vulnerability, please **do not** open a public issue. Instead, please report it privately to help us address it quickly.

### How to Report

Email your security report to: **[your-security-email@example.com]**

Please include:

- Description of the vulnerability
- Steps to reproduce (if applicable)
- Potential impact and severity
- Any suggested fixes (if you have them)

### What to Expect

1. **Acknowledgment**: We will acknowledge receipt of your report within 48 hours
2. **Assessment**: We will investigate and assess the severity
3. **Timeline**: We aim to release a patch within 7-14 days for critical issues
4. **Credit**: We will credit you in the fix (unless you request anonymity)
5. **Public Disclosure**: We will notify you before any public disclosure

## Security Best Practices for Users

### Frontend (Client-Side)

- **Do not store sensitive data locally**: Avoid saving API keys, tokens, or credentials in browser storage
- **Clear sensitive data after use**: Ensure coordinates and project data are cleared when switching users
- **Use HTTPS only**: Always access the application over a secure connection
- **Keep browser updated**: Regularly update your browser to patch security vulnerabilities

### Backend (CAD API Service)

- **Keep LibreDWG updated**: Regularly update the `dwg2dxf` binary to the latest version
- **Restrict file uploads**: Only accept DWG/DXF files from trusted sources
- **Monitor file sizes**: Use the `CAD_MAX_UPLOAD_MB` setting to prevent resource exhaustion
- **Run with least privileges**: Execute the backend service under a restricted user account
- **Use environment variables for secrets**: Never hardcode API keys or credentials

## Supported Versions

| Version | Status          | Security Updates Until |
| ------- | --------------- | ---------------------- |
| 0.0.1+  | Active          | Current + 12 months    |
| < 0.0.1 | End of Life     | Not supported          |

## Known Security Considerations

### Client-Side Code Visibility

This is a client-side React application. The code is naturally visible in the browser and cannot be truly "hidden." We mitigate this by:

- Storing only non-sensitive business logic on the frontend
- Offloading sensitive operations (DWG parsing) to the backend
- Using the MIT License to establish IP ownership and usage terms

### Data In Transit

- All communication with the backend should use HTTPS/TLS encryption
- API responses containing coordinate data should be treated as sensitive in production environments

### Geoid Data

- Geoid grids are loaded from `public/geoid/` and are publicly available
- No sensitive information is embedded in grid files

## Deployment Security

When deploying in production:

1. **Frontend (Vercel)**
   - Enable HTTPS (automatic on Vercel)
   - Set up rate limiting if needed
   - Use environment variables for any backend URLs

2. **Backend (Railway/Your Server)**
   - Use Docker image from `Dockerfile.cad-api`
   - Set `helmet` headers (already configured)
   - Enable `cors` with specific allowed origins
   - Use `express-rate-limit` to prevent abuse
   - Monitor upload sizes and set timeouts
   - Keep node dependencies updated

## Dependencies & Vulnerability Scanning

We regularly update dependencies to patch known vulnerabilities. Run:

```bash
npm audit
npm audit fix
```

To check and fix known vulnerabilities in your local installation.

## Additional Resources

- [OWASP Security Best Practices](https://owasp.org/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Express.js Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)
- [MDN Web Security](https://developer.mozilla.org/en-US/docs/Web/Security)

---

**Last Updated**: June 2026

Thank you for helping keep Survey Calculator secure!
