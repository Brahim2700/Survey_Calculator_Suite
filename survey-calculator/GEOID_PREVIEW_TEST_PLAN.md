# Geoid Grid Preview - Comprehensive Test Plan

## Feature Overview
The Geoid Grid Preview (🌍 button) allows you to:
- Visualize geoid grid coverage (EGM96, EGM2008, EGM2020)
- Query geoid heights at specific geographic points
- Upload custom geoid grids for your project area
- Verify grid accuracy before conducting surveys

---

## Test Scenario 1: CSV/TXT Coordinate Points

### Setup:
1. In the left panel, navigate to **Single Point Conversion**
2. Enter test coordinates in **Decimal Degrees (DD)** format:
   - **Point 1 (Paris, France):** Lon: 2.3522, Lat: 48.8566
   - **Point 2 (Lyon, France):** Lon: 4.8357, Lat: 45.7640
   - **Point 3 (Marseille, France):** Lon: 5.3698, Lat: 43.2965

### Steps:
1. Click **"Convert Single Point"** button
2. Observe point appearing on the Interactive Map
3. Repeat for Points 2 and 3 (you should see 3 points on map)
4. Click the **🌍 button** in the map toolbar to open Geoid Grid Preview

### Validation:
- ✅ All test points appear within EGM96/EGM2008/EGM2020 coverage (global grids)
- ✅ Clicking on each point in the preview shows the queried location
- ✅ Geoid heights are displayed in the preview panel
- ✅ Can switch between different geoid grids without errors
- ✅ Map layers toggle (OpenStreetMap ↔ Satellite) works smoothly

---

## Test Scenario 2: CSV File Bulk Import

### Setup:
1. Use the sample CSV file: `/samples/sample.csv`
2. Or create a test CSV with this format:
```
ID,X,Y,Z
P001,2.3522,48.8566,100
P002,4.8357,45.7640,150
P003,5.3698,43.2965,200
```

### Steps:
1. In **Bulk Conversion / Import** section, click **"Choose file"**
2. Select the CSV file
3. Click **"Convert File/Bulk"**
4. Wait for conversion to complete
5. Open **🌍 Geoid Grid Preview**
6. Click on several points to verify geoid coverage

### Validation:
- ✅ All bulk points loaded successfully
- ✅ Geoid coverage verified for all points
- ✅ Height values consistent across bulk vs. single point conversions
- ✅ No console errors during preview panel interaction

---

## Test Scenario 3: DWG/DXF CAD File Import

### Setup:
1. Use sample file: `/samples/sample_urban_plan_l93.dxf`
   - This is already in Lambert-93 (EPSG:2154)
   - French urban survey data

### Steps:
1. In **Bulk Conversion / Import**, click **"Load DWG Sample"** or **"Choose file"**
2. Select the DXF file
3. Wait for CAD inspection and visualization
4. Observe the CAD geometry on the map (lines, points, polylines)
5. Open **🌍 Geoid Grid Preview**
6. Switch to different geoid grids (EGM96 → EGM2008 → EGM2020)

### Validation:
- ✅ CAD geometry displays correctly on base map
- ✅ Geoid grid coverage aligns with CAD data extent
- ✅ Grid resolution visible (especially EGM2020 with 1 arcmin resolution)
- ✅ No performance degradation with CAD data + geoid preview

---

## Test Scenario 4: Custom Geoid Grid Upload

### Steps:
1. In the Geoid Grid Preview panel, locate **"Upload Custom Grid"**
2. Attempt to upload a custom geoid grid file (if available)
   - Supported formats: .grd, .bin, .dat, .tif, .tiff
3. Verify file size display (e.g., "2.5 MB")

### Validation:
- ✅ File upload dialog opens without errors
- ✅ File size displayed correctly
- ✅ Success message appears after upload

---

## Test Scenario 5: Interactive Query

### Steps:
1. Open Geoid Grid Preview (🌍 button)
2. On the preview map, click on different locations:
   - Over France (should show geoid height)
   - Over ocean (should show geoid height - grid covers globally)
   - Over multiple countries
3. For each click, observe:
   - Latitude/Longitude displayed
   - Geoid height calculated
   - Marker appears on map

### Validation:
- ✅ Query results accurate to ±0.5m (EGM96), ±0.4m (EGM2008), ±0.2m (EGM2020)
- ✅ Clicking works across all base map types
- ✅ Marker persists and can be clicked again for new queries
- ✅ Geoid height value makes geographic sense

---

## Test Scenario 6: Grid Comparison

### Steps:
1. Open Geoid Grid Preview
2. Click on same location (e.g., Paris: 2.35°, 48.85°) with each grid:
   - EGM96
   - EGM2008
   - EGM2020
3. Record geoid heights for each

### Validation:
- ✅ EGM96 (±0.5m) vs EGM2008 (±0.4m) show similar heights
- ✅ EGM2020 (±0.2m) potentially shows finer detail
- ✅ Accuracy metadata matches selected grid
- ✅ Resolution info updates correctly

---

## Test Scenario 7: Performance Test

### Steps:
1. Load a large CAD file (if available) or bulk points (100+ points)
2. Open Geoid Grid Preview
3. Click multiple points rapidly
4. Toggle between grid selections multiple times
5. Observe performance metrics (if available)

### Validation:
- ✅ Preview panel doesn't freeze
- ✅ Map responds within 1-2 seconds per click
- ✅ Grid switching completes quickly
- ✅ No memory leaks (page doesn't slow down after 5+ minutes)

---

## Expected Results Summary

| Test | Expected | Status |
|------|----------|--------|
| CSV Points Query | Shows geoid heights for each point | ☐ |
| Bulk CSV Import | All points loaded and queried successfully | ☐ |
| DXF CAD Geometry | CAD + geoid preview coexist without issues | ☐ |
| Custom Grid Upload | File uploads and displays correctly | ☐ |
| Interactive Query | Accurate geoid heights (±0.2-0.5m) | ☐ |
| Grid Comparison | Differences visible between EGM versions | ☐ |
| Performance | Sub-2s response time for queries | ☐ |

---

## Troubleshooting

If 🌍 button is not visible:
1. Clear browser cache (Ctrl+Shift+Del)
2. Hard refresh (Ctrl+Shift+R)
3. Check Vercel deployment status at https://vercel.com/dashboard
4. Check browser console for errors (F12 → Console tab)

If geoid values seem incorrect:
1. Verify you've selected correct grid (EGM96 vs EGM2008 vs EGM2020)
2. Check coordinate is within grid coverage (should be global for all three)
3. Compare with known reference values for that location
4. Check if height value makes geographic sense

---

## Notes
- All test coordinates use WGS84 (EPSG:4326) for geographic queries
- Geoid heights are in meters
- Grid coverage is global for EGM96, EGM2008, and EGM2020
- Custom grids can provide regional improvements (typically ±0.1m)
