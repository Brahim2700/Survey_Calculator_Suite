import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { getCadBackendStatus, parseCadUpload } from './cadService.js';

const app = express();
const port = Number(process.env.CAD_API_PORT || 4000);
const uploadLimitMb = Number(process.env.CAD_MAX_UPLOAD_MB || 100);
const allowedOrigins = String(process.env.CAD_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadLimitMb * 1024 * 1024 },
});

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed by CAD API CORS policy: ${origin}`));
  },
}));

app.get('/api/cad/health', (_req, res) => {
  res.json(getCadBackendStatus());
});

app.post('/api/cad/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ message: 'No CAD file was uploaded.' });
      return;
    }

    const result = await parseCadUpload({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      fileSizeBytes: req.file.size,
      pointsOnly: String(req.body?.pointsOnly || '').toLowerCase() === 'true',
    });

    res.json({
      rows: result.rows,
      sourceFormat: result.sourceFormat,
      warnings: result.warnings || [],
      inspection: result.inspection || null,
    });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      message: err.message || 'CAD parsing failed.',
    });
  }
});

app.listen(port, () => {
  console.log(`CAD backend listening on http://localhost:${port}`);
});