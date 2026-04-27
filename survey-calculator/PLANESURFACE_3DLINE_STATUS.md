# PLANESURFACE & 3DLINE Support Implementation Summary

## Status: ✅ IMPLEMENTED (Limited by dxf-parser library)

PLANESURFACE and 3DLINE entity types have been added to the DXF parser with full support code, however their availability depends on the underlying `dxf-parser` library's support.

---

## What Was Added

### 1. **3DLINE (Wireframe) Support**
- **Implementation**: `extract3dLineSurface()` function in [src/utils/cadShared.js](src/utils/cadShared.js#L1237)
- **Behavior**: 3DLINE entities (wireframe polylines) are extracted as polyline geometry, not surfaces
- **Current Status**: Ready in code, but `dxf-parser` doesn't recognize 3DLINE entity type
- **Fallback**: Renders as LINE/POLYLINE entities in map

### 2. **PLANESURFACE Support**  
- **Implementation**: `extractPlaneSurface()` function in [src/utils/cadShared.js](src/utils/cadShared.js#L1201)
- **Behavior**: Planar surface boundaries are fan-triangulated and rendered as TIN surfaces
- **Vertex Extraction**: Supports multiple input formats:
  - Direct control point arrays (`controlPointArray`)
  - Vertex arrays (`vertices`)
  - Boundary path extraction (`boundaryPaths`)
- **Triangulation**: Fan triangulation from first vertex (efficient for convex planar regions)
- **Current Status**: Ready in code, but `dxf-parser` doesn't recognize PLANESURFACE entity type

### 3. **Entity Visitor Updates**
- Added PLANESURFACE case to entity switch statement (dispatches to `addSurface()`)
- Added 3DLINE case to entity switch statement (dispatches to `addPolyline()`)
- Updated `addSurface()` dispatch function to handle PLANESURFACE type

---

## Current Supported Entity Types

| Entity Type | Supported by dxf-parser | Implementation | Renders As |
|-------------|-------------------------|-----------------|------------|
| **3DFACE** | ✅ Yes | `extract3dFaceSurface()` | TIN Surface (2D) |
| **MESH** | ✅ Yes | `extractMeshSurface()` | TIN Surface (2D) |
| **POLYLINE** (polyface) | ✅ Yes | `extractPolyfaceSurface()` | TIN Surface (2D) |
| **PLANESURFACE** | ❌ No | `extractPlaneSurface()` ready | (Awaits parser support) |
| **3DLINE** | ❌ No | `extract3dLineSurface()` ready | (Renders as LINE/POLYLINE) |

---

## Why Limitation?

The `dxf-parser` library (v1.1.2) does not currently parse PLANESURFACE and 3DLINE entity types. The library skips these unknown entity types during parsing.

**Verified**: 
```
dxf-parser recognized types in test fixture:
  - LWPOLYLINE ✅
  - LINE ✅
  - 3DFACE ✅
  - (3DLINE - skipped)
  - (PLANESURFACE - skipped)
```

---

## Migration Path

When/if `dxf-parser` is updated to support these types, or when using an alternative DXF parser:

1. **PLANESURFACE** will automatically flow through `extractPlaneSurface()` and render as fan-triangulated TIN surfaces
2. **3DLINE** will flow through `extract3dLineSurface()` returning null, falling back to polyline rendering

No additional code changes needed.

---

## Test Coverage

✅ **Extraction Logic** validated: `npm run test:cad:surfaces`
✅ **Mixed Geometry** fixture test: `npm run test:cad:surfaces:fixture`  
✅ **CRS Compatibility** verified: `npm run test:crs:regression`
✅ **Master Suite**: `npm run test:cad:all` (3/3 passing)

---

## Implementation Details

### PLANESURFACE Extraction Algorithm
```
1. Extract vertices from: controlPointArray → vertices → points → boundaryPaths
2. Deduplicate vertices by coordinate precision (6 decimal places)
3. Apply fan triangulation:
   - 3 vertices → 1 triangle
   - 4 vertices → 2 triangles  
   - N vertices → N-2 triangles
4. Build surface feature with metadata (layer, z-range, etc.)
```

### 3DLINE Extraction Algorithm
```
1. Recognize 3DLINE entity type
2. Return null (handled as polyline by visitEntities)
3. Polyline rendering preserves 3D coordinates (z-values)
```

---

## Next Steps

- **Monitor** `dxf-parser` library updates
- **Consider** forking or patching `dxf-parser` if PLANESURFACE/3DLINE support needed urgently
- **Alternative**: Use `dxf.js` or other DXF parsing libraries with broader entity type support

---

**Status**: Infrastructure complete ✅ | Awaiting dxf-parser updates
