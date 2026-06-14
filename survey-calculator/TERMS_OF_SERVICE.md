# Terms of Service

**Last Updated: June 2026**

## 1. Acceptance of Terms

By accessing and using Survey Calculator ("the Application"), you agree to be bound by these Terms of Service. If you do not agree to these terms, you must not use this Application.

## 2. Use License

Survey Calculator is licensed under the MIT License. You are granted a limited, non-exclusive, revocable license to use this Application for lawful purposes. Specifically, you may:

- Use the Application for coordinate transformations, CRS conversions, and geospatial analysis
- Import and process your own geospatial data
- Access documentation and sample files
- Integrate the Application with your projects (in compliance with the MIT License)

## 3. Restrictions

You agree NOT to:

- Reverse engineer, decompile, or disassemble the backend CAD services (LibreDWG binary components)
- Sell, rent, lease, or transfer the Application without proper licensing
- Use the Application for unlawful purposes or to violate local, state, national, or international laws
- Attempt to gain unauthorized access to the Application or its backend services
- Use automated scraping, bots, or other automation tools to extract data at scale without permission
- Upload, process, or store illegal, malicious, or harmful content
- Abuse the CAD backend by uploading exceptionally large files or submitting malicious DWG/DXF files
- Use the Application to harass, threaten, or harm any individual or organization
- Violate intellectual property rights of third parties

## 4. User Responsibilities

You are responsible for:

- Maintaining the confidentiality of any credentials or API keys you use
- Securing your local environment and protecting sensitive data
- Ensuring your data uploads comply with applicable data protection regulations (GDPR, CCPA, etc.)
- Backing up your own data; the Application does not persistently store uploaded files on servers
- Compliance with all applicable laws in your jurisdiction when using the Application

## 5. API Usage & Rate Limiting

If you deploy the CAD backend service:

- You agree to implement and enforce rate limiting (`express-rate-limit` is provided)
- You agree to monitor and prevent API abuse
- You agree to respect the resource constraints of your hosting infrastructure
- Excessive uploads or requests may result in temporary suspension of service

## 6. Data & Privacy

- **Frontend**: All data processing on the web UI happens client-side. Coordinates and conversions are not sent to external servers unless you explicitly choose to upload to the CAD backend
- **CAD Backend**: Uploaded DWG/DXF files are processed server-side and temporary files are deleted after conversion. We do not retain copies of your files on the server
- **Geoid Data**: Grid files are public resources and not considered sensitive
- **Analytics**: The Application includes Vercel Analytics for usage monitoring (non-personally identifiable)

For sensitive data handling, please review your own server's privacy policy if you self-host the backend.

## 7. Disclaimer of Warranties

THE APPLICATION IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO:

- Merchantability, fitness for a particular purpose, or non-infringement
- That the Application will be error-free, uninterrupted, or secure
- That transformations or conversions are accurate for all CRS combinations (always validate critical measurements with official sources)
- That the backend CAD service will successfully parse all DWG files (some proprietary or corrupted files may fail)

## 8. Limitation of Liability

IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR:

- Direct, indirect, incidental, special, consequential, or punitive damages
- Loss of data, revenue, profits, or business opportunity
- Errors in coordinate transformations or CRS conversions
- Failures to parse or convert CAD files
- Downtime or interruption of service

**Always validate critical surveying or mapping work with authoritative sources.**

## 9. Intellectual Property

- The Survey Calculator application, code, and documentation are licensed under the MIT License
- You retain ownership of data you upload and process
- Third-party libraries are governed by their respective licenses (see `package.json` and dependencies)
- LibreDWG is subject to the GNU GPL v3 license (binary components)

## 10. Indemnification

You agree to indemnify and hold harmless the authors, contributors, and maintainers from any claims, damages, or costs arising from:

- Your use or misuse of the Application
- Your violation of these Terms of Service
- Your violation of applicable laws
- Your infringement of any third-party rights
- Data you upload or process through the Application

## 11. Third-Party Services

The Application uses third-party libraries and services:

- **Leaflet & Cesium**: For mapping and 3D visualization
- **proj4**: For CRS transformations
- **LibreDWG**: For DWG to DXF conversion (backend)
- **Vercel Analytics**: For usage tracking

You agree to comply with the terms and conditions of these third-party services.

## 12. Termination

We reserve the right to:

- Suspend or terminate access to the Application for violations of these terms
- Remove or delete content that violates these terms
- Modify or discontinue the Application at any time

## 13. Modifications to Terms

We may update these Terms of Service at any time. Continued use of the Application following modifications constitutes acceptance of the updated terms.

## 14. Governing Law

These Terms of Service are governed by and construed in accordance with applicable laws, and you irrevocably submit to the exclusive jurisdiction of the courts in that location.

## 15. Contact & Disputes

For questions, concerns, or disputes regarding these Terms of Service:

- Email: **[your-contact-email@example.com]**
- Security Issues: See [SECURITY.md](SECURITY.md)

---

**By using Survey Calculator, you acknowledge that you have read, understood, and agree to be bound by these Terms of Service.**
