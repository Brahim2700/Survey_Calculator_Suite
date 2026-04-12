import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

const DEFAULT_LEGEND_ITEMS = [
  { label: 'Geoid < -10 m', color: '#0000FF' },
  { label: 'Geoid -10 to -2 m', color: '#00FFFF' },
  { label: 'Geoid -2 to +2 m', color: '#00FF00' },
  { label: 'Geoid +2 to +10 m', color: '#FFFF00' },
  { label: 'Geoid > +10 m', color: '#FF0000' },
  { label: 'CAD line', color: '#0ea5e9' },
  { label: 'CAD polyline', color: '#2563eb' },
  { label: 'Measurement path', color: '#f97316' },
];

const drawRoundRect = (ctx, x, y, w, h, radius = 8) => {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

const waitForTiles = async (rootElement) => {
  const images = Array.from(rootElement.querySelectorAll('img'));
  const tilePromises = images.map((img) => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      setTimeout(done, 1200);
    });
  });
  await Promise.all(tilePromises);
};

const captureMapCanvas = async (mapRootElement) => {
  if (!mapRootElement) {
    throw new Error('Map is not ready for export yet.');
  }

  mapRootElement.classList.add('map-export-mode');
  try {
    await waitForTiles(mapRootElement);

    return html2canvas(mapRootElement, {
      useCORS: true,
      allowTaint: false,
      backgroundColor: '#f8fafc',
      scale: Math.min(Math.max(window.devicePixelRatio || 2, 2), 3),
      imageTimeout: 2500,
      logging: false,
    });
  } finally {
    mapRootElement.classList.remove('map-export-mode');
  }
};

const composeExportCanvas = (mapCanvas, exportInfo = {}) => {
  const {
    title = 'Survey Plan Export',
    subtitle = 'Survey Calculator Suite',
    details = [],
    legendItems = DEFAULT_LEGEND_ITEMS,
  } = exportInfo;

  const panelWidth = 350;
  const canvas = document.createElement('canvas');
  canvas.width = mapCanvas.width + panelWidth;
  canvas.height = Math.max(mapCanvas.height, 980);

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);
  ctx.drawImage(mapCanvas, 0, 0);

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(mapCanvas.width, 0, panelWidth, canvas.height);

  const px = mapCanvas.width + 22;
  let py = 34;

  ctx.fillStyle = '#93c5fd';
  ctx.font = '700 14px Segoe UI';
  ctx.fillText('PLAN REPORT', px, py);

  py += 28;
  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 22px Segoe UI';
  ctx.fillText(title, px, py);

  py += 24;
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '500 13px Segoe UI';
  ctx.fillText(subtitle, px, py);

  py += 18;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 11px Segoe UI';
  ctx.fillText(`Generated: ${new Date().toLocaleString()}`, px, py);

  py += 26;
  drawRoundRect(ctx, px - 10, py - 8, panelWidth - 36, 210, 10);
  ctx.fillStyle = '#111827';
  ctx.fill();

  py += 18;
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '700 12px Segoe UI';
  ctx.fillText('Project Details', px, py);

  py += 18;
  ctx.font = '500 11px Segoe UI';
  const safeDetails = details.length > 0 ? details : [{ label: 'Info', value: 'No additional metadata' }];
  safeDetails.slice(0, 14).forEach((item) => {
    const label = `${item.label}:`;
    const value = item.value ?? '-';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(label, px, py);
    ctx.fillStyle = '#f8fafc';
    const text = String(value);
    ctx.fillText(text.length > 36 ? `${text.slice(0, 33)}...` : text, px + 95, py);
    py += 14;
  });

  py += 18;
  drawRoundRect(ctx, px - 10, py - 8, panelWidth - 36, 330, 10);
  ctx.fillStyle = '#111827';
  ctx.fill();

  py += 18;
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '700 12px Segoe UI';
  ctx.fillText('Legend', px, py);

  py += 18;
  ctx.font = '500 11px Segoe UI';
  legendItems.forEach((item) => {
    ctx.fillStyle = item.color;
    ctx.fillRect(px, py - 8, 14, 9);
    ctx.strokeStyle = '#334155';
    ctx.strokeRect(px, py - 8, 14, 9);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(item.label, px + 22, py);
    py += 18;
  });

  py += 4;
  ctx.fillStyle = '#64748b';
  ctx.font = '500 10px Segoe UI';
  ctx.fillText('Map scale and north are contextual to active basemap.', px, py);

  return canvas;
};

const downloadBlob = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
};

export const exportMapAsPng = async (mapRootElement, exportInfo = {}, fileName = 'survey-plan.png') => {
  const mapCanvas = await captureMapCanvas(mapRootElement);
  const composedCanvas = composeExportCanvas(mapCanvas, exportInfo);

  await new Promise((resolve, reject) => {
    composedCanvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to create PNG export.'));
        return;
      }
      downloadBlob(blob, fileName);
      resolve();
    }, 'image/png');
  });
};

export const exportMapAsPdf = async (mapRootElement, exportInfo = {}, fileName = 'survey-plan.pdf', pdfOptions = {}) => {
  const mapCanvas = await captureMapCanvas(mapRootElement);
  const composedCanvas = composeExportCanvas(mapCanvas, exportInfo);
  const imageData = composedCanvas.toDataURL('image/png');
  const targetFormat = String(pdfOptions.format || 'a4').toLowerCase();
  const targetOrientation = String(pdfOptions.orientation || 'auto').toLowerCase();
  const orientation = targetOrientation === 'portrait' || targetOrientation === 'landscape'
    ? targetOrientation
    : (composedCanvas.width > composedCanvas.height ? 'landscape' : 'portrait');

  const pdf = new jsPDF({
    orientation,
    unit: 'mm',
    format: targetFormat === 'a3' ? 'a3' : 'a4',
    compress: true,
  });

  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 8;
  const drawableW = pageW - margin * 2;
  const drawableH = pageH - margin * 2;
  const ratioW = drawableW / composedCanvas.width;
  const ratioH = drawableH / composedCanvas.height;
  const scale = Math.min(ratioW, ratioH);
  const fittedW = composedCanvas.width * scale;
  const fittedH = composedCanvas.height * scale;
  const offsetX = margin + ((drawableW - fittedW) / 2);
  const offsetY = margin + ((drawableH - fittedH) / 2);

  pdf.addImage(imageData, 'PNG', offsetX, offsetY, fittedW, fittedH, undefined, 'FAST');

  pdf.save(fileName);
};
