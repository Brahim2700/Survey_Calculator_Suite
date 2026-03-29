import proj4 from 'proj4';
import CRS_LIST from '../crsList';

const fmtNum = (v, digits = 4) => (Number.isFinite(v) ? Number(v).toFixed(digits) : '');

const ddToDMS = (value, kind) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutesFloat = (abs - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = (minutesFloat - minutes) * 60;
  const secStr = seconds.toFixed(2);
  let hemi = '';
  if (kind === 'lat') hemi = sign < 0 ? 'S' : 'N';
  if (kind === 'lon') hemi = sign < 0 ? 'W' : 'E';
  return `${degrees}°${minutes}'${secStr}"${hemi}`;
};

const registerDefs = () => {
  CRS_LIST.forEach((crs) => {
    if (crs?.code && crs?.proj4def) {
      proj4.defs(crs.code, crs.proj4def);
    }
  });
};

self.onmessage = async (event) => {
  const { parsed, fromCrs, toCrs, outputFormat } = event.data || {};
  if (!Array.isArray(parsed)) {
    self.postMessage({ type: 'error', message: 'Invalid payload' });
    return;
  }

  try {
    registerDefs();
    const toIsGeo = CRS_LIST.find((c) => c.code === toCrs)?.type === 'geographic';
    const outPrec = toCrs === 'EPSG:4326' ? 8 : 4;
    const inPrec = fromCrs === 'EPSG:4326' ? 8 : 4;

    const rows = [];
    for (let i = 0; i < parsed.length; i += 1) {
      const p = parsed[i];
      try {
        const [xOut, yOut] = proj4(fromCrs, toCrs, [p.x, p.y]);
        const ddX = fmtNum(xOut, outPrec);
        const ddY = fmtNum(yOut, outPrec);
        const outX = toIsGeo
          ? (outputFormat === 'DMS' ? ddToDMS(xOut, 'lon') : ddX)
          : ddX;
        const outY = toIsGeo
          ? (outputFormat === 'DMS' ? ddToDMS(yOut, 'lat') : ddY)
          : ddY;

        rows.push({
          id: p.id || i + 1,
          inputX: fmtNum(p.x, inPrec),
          inputY: fmtNum(p.y, inPrec),
          outputX: outX,
          outputY: outY,
          outputXRaw: xOut,
          outputYRaw: yOut,
          inputZ: p.z ?? undefined,
          outputZ: p.z ?? undefined,
        });
      } catch (err) {
        rows.push({
          id: p.id || i + 1,
          inputX: fmtNum(p.x, 4),
          inputY: fmtNum(p.y, 4),
          outputX: 'ERROR',
          outputY: err.message || 'Conversion failed',
          errorCategory: 'conversion',
          errorMessage: err.message || 'Conversion failed',
        });
      }

      if ((i + 1) % 1000 === 0) {
        self.postMessage({ type: 'progress', done: i + 1, total: parsed.length });
      }
    }

    self.postMessage({ type: 'done', rows });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
