import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import BatchOperations from '../Components/BatchOperations';

const TRANSLATIONS = {
  'panels.operation': 'Operation',
  'panels.selectOperation': 'Select Operation',
  'panels.batchOperationsTitle': 'Batch Operations',
  'panels.pointsTotal': ({ total }) => `Total points: ${total}`,
  'panels.pointsSelectedFromTotal': ({ count, total }) => `${count}/${total}`,
  'panels.viewStatistics': 'View Stats',
  'panels.exportCsv': 'Export CSV',
  'panels.addElevationOffset': 'Add Elevation Offset',
  'panels.deleteSelected': 'Delete Selected',
  'panels.exportPoints': ({ count }) => `Export ${count} points`,
  'panels.selectOperationAbove': 'Select an operation',
};

const t = (key, params = {}) => {
  const value = TRANSLATIONS[key];
  if (typeof value === 'function') return value(params);
  return value || key;
};

describe('BatchOperations bulk export', () => {
  let createObjectURLSpy;
  let revokeObjectURLSpy;
  let anchorClickSpy;
  let capturedBlob;

  beforeEach(() => {
    capturedBlob = null;
    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      capturedBlob = blob;
      return 'blob:mock-export';
    });
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports only active filtered points as CSV and triggers download', async () => {
    const points = [
      { id: 'A1', label: 'First', lat: 10.1, lng: 20.2, height: 100, crs: 'EPSG:4326', sourceType: 'csv', importedCadName: '' },
      { id: 'A2', label: 'Second', lat: 11.1, lng: 21.2, height: 110, crs: 'EPSG:4326', sourceType: 'manual', importedCadName: '' },
    ];

    render(<BatchOperations points={points} filteredPoints={[points[1]]} t={t} />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'export' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export 1 points' }));

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock-export');

    const csv = await capturedBlob.text();
    expect(csv).toContain('ID,Label,Latitude,Longitude,Height (m),CRS,Source Type,Imported Name');
    expect(csv).toContain('"A2","Second",11.1,21.2,110,"EPSG:4326","manual",""');
    expect(csv).not.toContain('"A1"');
  });

  it('escapes double quotes inside CSV string fields', async () => {
    const points = [
      {
        id: 'P-01',
        label: 'Stake "A"',
        lat: 48.1,
        lng: 2.2,
        height: 55,
        crs: 'EPSG:4326',
        sourceType: 'field "gps"',
        importedCadName: 'Road, Segment "North"',
      },
    ];

    render(<BatchOperations points={points} t={t} />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'export' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export 1 points' }));

    const csv = await capturedBlob.text();
    expect(csv).toContain('"P-01","Stake ""A""",48.1,2.2,55,"EPSG:4326","field ""gps""","Road, Segment ""North"""');
  });

  it('keeps export button disabled when no active points exist', () => {
    render(<BatchOperations points={[]} filteredPoints={[]} t={t} />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'export' } });

    expect(screen.getByRole('button', { name: 'Export 0 points' })).toBeDisabled();
    expect(createObjectURLSpy).not.toHaveBeenCalled();
  });
});
