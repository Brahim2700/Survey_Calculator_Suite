import { describe, expect, it } from 'vitest';
import { analyzeDxfTextForPurgeAudit, runCadPurgeApply } from '../../server/cadPurgeAuditService.js';

function buildMinimalDxf() {
  return [
    '0', 'SECTION',
    '2', 'TABLES',

    '0', 'TABLE',
    '2', 'LAYER',
    '0', 'LAYER',
    '2', '0',
    '0', 'LAYER',
    '2', 'USED_LAYER',
    '0', 'LAYER',
    '2', 'UNUSED_LAYER',
    '0', 'ENDTAB',

    '0', 'TABLE',
    '2', 'LTYPE',
    '0', 'LTYPE',
    '2', 'CONTINUOUS',
    '0', 'LTYPE',
    '2', 'UNUSED_LT',
    '0', 'ENDTAB',

    '0', 'TABLE',
    '2', 'STYLE',
    '0', 'STYLE',
    '2', 'STANDARD',
    '0', 'STYLE',
    '2', 'UNUSED_STYLE',
    '0', 'ENDTAB',

    '0', 'TABLE',
    '2', 'DIMSTYLE',
    '0', 'DIMSTYLE',
    '2', 'STANDARD',
    '0', 'DIMSTYLE',
    '2', 'UNUSED_DIM',
    '0', 'ENDTAB',

    '0', 'TABLE',
    '2', 'APPID',
    '0', 'APPID',
    '2', 'ACAD',
    '0', 'APPID',
    '2', 'MY_UNUSED_APP',
    '0', 'ENDTAB',

    '0', 'ENDSEC',

    '0', 'SECTION',
    '2', 'BLOCKS',
    '0', 'BLOCK',
    '2', 'USED_BLOCK',
    '70', '0',
    '0', 'ENDBLK',
    '0', 'BLOCK',
    '2', 'UNUSED_BLOCK',
    '70', '0',
    '0', 'ENDBLK',
    '0', 'BLOCK',
    '2', 'XREF_UNUSED',
    '70', '4',
    '1', 'xref-unused.dwg',
    '0', 'ENDBLK',
    '0', 'ENDSEC',

    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'INSERT',
    '2', 'USED_BLOCK',
    '8', 'USED_LAYER',
    '0', 'LINE',
    '8', 'USED_LAYER',
    '10', '0',
    '20', '0',
    '11', '10',
    '21', '10',
    '0', 'LINE',
    '8', 'USED_LAYER',
    '10', '0',
    '20', '0',
    '11', '10',
    '21', '10',
    '0', 'ENDSEC',

    '0', 'EOF',
  ].join('\n');
}

describe('analyzeDxfTextForPurgeAudit', () => {
  it('returns audit-only safety contract and unused definition candidates', () => {
    const report = analyzeDxfTextForPurgeAudit(buildMinimalDxf(), { fileName: 'sample.dxf' });

    expect(report.mode).toBe('audit-only');
    expect(report.safe).toBe(true);
    expect(report.willModifyDrawing).toBe(false);
    expect(report.willRemoveGeometry).toBe(false);

    expect(report.candidates.layers).toContain('UNUSED_LAYER');
    expect(report.candidates.linetypes).toContain('UNUSED_LT');
    expect(report.candidates.textStyles).toContain('UNUSED_STYLE');
    expect(report.candidates.dimensionStyles).toContain('UNUSED_DIM');
    expect(report.candidates.regapps).toContain('MY_UNUSED_APP');

    expect(report.candidates.blocks).toContain('UNUSED_BLOCK');
    expect(report.candidates.blocks).not.toContain('USED_BLOCK');

    expect(report.candidates.xrefs).toContain('XREF_UNUSED');
    expect(report.summary.overkillPotential.duplicateLineGroups).toBe(1);
    expect(report.summary.overkillPotential.duplicateLineEntities).toBe(1);
  });

  it('keeps protected defaults out of candidate lists', () => {
    const report = analyzeDxfTextForPurgeAudit(buildMinimalDxf(), { fileName: 'sample.dxf' });

    expect(report.candidates.layers).not.toContain('0');
    expect(report.candidates.linetypes).not.toContain('CONTINUOUS');
    expect(report.candidates.textStyles).not.toContain('STANDARD');
    expect(report.candidates.dimensionStyles).not.toContain('STANDARD');
    expect(report.candidates.regapps).not.toContain('ACAD');
  });

  it('applies safe purge only to unreferenced definitions and keeps geometry safety', async () => {
    const input = buildMinimalDxf();
    const result = await runCadPurgeApply({
      buffer: Buffer.from(input, 'utf8'),
      originalName: 'sample.dxf',
    });

    expect(result.mode).toBe('apply-safe');
    expect(result.safe).toBe(true);
    expect(result.willModifyDrawing).toBe(true);
    expect(result.willRemoveGeometry).toBe(false);

    expect(result.summary.removedCounts.layers).toBeGreaterThanOrEqual(1);
    expect(result.summary.removedCounts.linetypes).toBeGreaterThanOrEqual(1);
    expect(result.summary.removedCounts.textStyles).toBeGreaterThanOrEqual(1);
    expect(result.summary.removedCounts.dimensionStyles).toBeGreaterThanOrEqual(1);
    expect(result.summary.removedCounts.regapps).toBeGreaterThanOrEqual(1);
    expect(result.summary.removedCounts.blocks).toBeGreaterThanOrEqual(1);
    expect(result.summary.removedCounts.xrefs).toBe(0);

    expect(result.auditAfter?.summary?.candidateCounts?.layers ?? 0).toBe(0);
    expect(result.auditAfter?.summary?.candidateCounts?.linetypes ?? 0).toBe(0);
    expect(result.auditAfter?.summary?.candidateCounts?.textStyles ?? 0).toBe(0);
    expect(result.auditAfter?.summary?.candidateCounts?.dimensionStyles ?? 0).toBe(0);
    expect(result.auditAfter?.summary?.candidateCounts?.regapps ?? 0).toBe(0);

    expect(result.cleanedDxfText).toContain('SECTION');
    expect(result.cleanedDxfText).toContain('EOF');
    expect(result.cleanedDxfText).toContain('USED_BLOCK');
    expect(result.cleanedDxfText).toContain('XREF_UNUSED');
    expect(result.cleanedDxfText).not.toContain('UNUSED_BLOCK');
    expect(result.cleanedDxfText).not.toContain('\r\n');
    expect(result.summary.sizeAfterBytes).toBeLessThan(result.summary.sizeBeforeBytes);
  });

  it('supports optional unreferenced xref detach mode only', async () => {
    const input = buildMinimalDxf();
    const result = await runCadPurgeApply({
      buffer: Buffer.from(input, 'utf8'),
      originalName: 'sample.dxf',
      options: {
        xrefMode: 'detach-unreferenced',
      },
    });

    expect(result.summary.removedCounts.xrefs).toBeGreaterThanOrEqual(1);
    expect(result.cleanedDxfText).not.toContain('XREF_UNUSED');
  });

  it('builds and applies conservative overkill duplicate map for line/point/arc/circle', async () => {
    const input = [
      '0', 'SECTION',
      '2', 'TABLES',
      '0', 'TABLE',
      '2', 'LAYER',
      '0', 'LAYER',
      '2', '0',
      '0', 'ENDTAB',
      '0', 'ENDSEC',
      '0', 'SECTION',
      '2', 'ENTITIES',
      '0', 'LINE',
      '8', '0',
      '10', '0',
      '20', '0',
      '11', '10',
      '21', '10',
      '0', 'LINE',
      '8', '0',
      '10', '0',
      '20', '0',
      '11', '10',
      '21', '10',
      '0', 'POINT',
      '8', '0',
      '10', '5',
      '20', '5',
      '0', 'POINT',
      '8', '0',
      '10', '5',
      '20', '5',
      '0', 'CIRCLE',
      '8', '0',
      '10', '3',
      '20', '3',
      '40', '2',
      '0', 'CIRCLE',
      '8', '0',
      '10', '3',
      '20', '3',
      '40', '2',
      '0', 'ARC',
      '8', '0',
      '10', '3',
      '20', '3',
      '40', '2',
      '50', '0',
      '51', '90',
      '0', 'ARC',
      '8', '0',
      '10', '3',
      '20', '3',
      '40', '2',
      '50', '0',
      '51', '90',
      '0', 'ENDSEC',
      '0', 'EOF',
    ].join('\n');

    const audit = analyzeDxfTextForPurgeAudit(input, {
      fileName: 'overkill.dxf',
      options: {
        overkillMode: 'report-only',
        overkillTolerance: 1e-6,
      },
    });

    expect(audit.overkill?.duplicateMap?.duplicateGroupCount).toBeGreaterThanOrEqual(4);
    expect(audit.overkill?.duplicateMap?.duplicateEntities).toBeGreaterThanOrEqual(4);

    const applied = await runCadPurgeApply({
      buffer: Buffer.from(input, 'utf8'),
      originalName: 'overkill.dxf',
      options: {
        overkillMode: 'delete-duplicates',
        overkillTolerance: 1e-6,
      },
    });

    expect(applied.summary.overkill?.removedDuplicatesTotal).toBeGreaterThanOrEqual(4);
    expect(applied.cleanedDxfText).toContain('EOF');
  });
});
