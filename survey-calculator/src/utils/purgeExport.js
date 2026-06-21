const SIZE_GZIP_THRESHOLD_RATIO = 1.15;

function normalizeDxfText(value) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\u0000/g, '');
  if (!text.endsWith('\n')) text += '\n';
  return text;
}

function canUseCompressionStream() {
  return typeof CompressionStream !== 'undefined';
}

async function gzipText(text) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  const compressedBuffer = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(compressedBuffer);
}

export async function buildPurgedCadDownload({
  originalFile,
  cleanedDxfText,
  cleanedFileName,
  thresholdRatio = SIZE_GZIP_THRESHOLD_RATIO,
} = {}) {
  const normalized = normalizeDxfText(cleanedDxfText);
  const rawBlob = new Blob([normalized], { type: 'application/octet-stream' });

  const originalSize = Number(originalFile?.size || 0);
  const baseName = String(cleanedFileName || 'drawing-safepurge.dxf').trim() || 'drawing-safepurge.dxf';

  const shouldTryGzip = originalSize > 0
    && rawBlob.size > originalSize * thresholdRatio
    && canUseCompressionStream();

  if (shouldTryGzip) {
    try {
      const gzBytes = await gzipText(normalized);
      if (gzBytes.byteLength > 0 && gzBytes.byteLength < rawBlob.size) {
        return {
          blob: new Blob([gzBytes], { type: 'application/gzip' }),
          filename: `${baseName}.gz`,
          usedGzip: true,
          rawSizeBytes: rawBlob.size,
          outputSizeBytes: gzBytes.byteLength,
        };
      }
    } catch {
      // Fall back to raw DXF on unsupported/failed compression.
    }
  }

  return {
    blob: rawBlob,
    filename: baseName,
    usedGzip: false,
    rawSizeBytes: rawBlob.size,
    outputSizeBytes: rawBlob.size,
  };
}
