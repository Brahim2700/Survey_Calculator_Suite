// src/utils/calculations.js
// Distance and bearing calculations for surveying and geomatics
// Includes: Slope, Horizontal, Grid, Ground, Geodesic distances
// Plus: Vincenty's formulas, scale factors, and azimuth calculations

/**
 * Constants
 */
const WGS84_A = 6378137.0; // WGS84 semi-major axis (meters)
const WGS84_B = 6356752.314245; // WGS84 semi-minor axis (meters)
const WGS84_F = 1 / 298.257223563; // WGS84 flattening
const EARTH_MEAN_RADIUS = 6371000; // Mean Earth radius (meters)

/**
 * Convert degrees to radians
 */
const toRadians = (degrees) => degrees * Math.PI / 180;

/**
 * Convert radians to degrees
 */
const toDegrees = (radians) => radians * 180 / Math.PI;

/**
 * Format decimal degrees to DMS (Degrees Minutes Seconds)
 */
export const formatDMS = (decimal) => {
  const abs = Math.abs(decimal);
  const degrees = Math.floor(abs);
  const minutesDecimal = (abs - degrees) * 60;
  const minutes = Math.floor(minutesDecimal);
  const seconds = (minutesDecimal - minutes) * 60;
  
  return `${degrees}° ${minutes}' ${seconds.toFixed(2)}"`;
};

/**
 * 1. SLOPE DISTANCE
 * Direct 3D distance between two points (what a total station measures)
 * 
 * @param {Object} p1 - Point 1 {x, y, z} or {e, n, elev}
 * @param {Object} p2 - Point 2 {x, y, z} or {e, n, elev}
 * @returns {number} Slope distance in meters
 */
export const calculateSlopeDistance = (p1, p2) => {
  const dx = (p2.x || p2.e || p2.easting || 0) - (p1.x || p1.e || p1.easting || 0);
  const dy = (p2.y || p2.n || p2.northing || 0) - (p1.y || p1.n || p1.northing || 0);
  const dz = (p2.z || p2.elev || p2.elevation || 0) - (p1.z || p1.elev || p1.elevation || 0);
  
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

/**
 * 2. HORIZONTAL DISTANCE
 * 2D distance projected to horizontal plane
 * 
 * @param {Object} p1 - Point 1
 * @param {Object} p2 - Point 2
 * @returns {number} Horizontal distance in meters
 */
export const calculateHorizontalDistance = (p1, p2) => {
  const dx = (p2.x || p2.e || p2.easting || 0) - (p1.x || p1.e || p1.easting || 0);
  const dy = (p2.y || p2.n || p2.northing || 0) - (p1.y || p1.n || p1.northing || 0);
  
  return Math.sqrt(dx * dx + dy * dy);
};

/**
 * Calculate vertical angle from slope and horizontal distances
 * 
 * @param {number} slopeDistance - Slope distance
 * @param {number} horizontalDistance - Horizontal distance
 * @returns {number} Vertical angle in degrees
 */
export const calculateVerticalAngle = (slopeDistance, horizontalDistance) => {
  if (slopeDistance === 0) return 0;
  return toDegrees(Math.acos(horizontalDistance / slopeDistance));
};

/**
 * 3. GRID DISTANCE
 * Distance in projected coordinate system (UTM, State Plane, etc.)
 * This is the same as horizontal distance in projected coordinates
 * 
 * @param {Object} p1 - Point 1 {e, n} in projected CRS
 * @param {Object} p2 - Point 2 {e, n} in projected CRS
 * @returns {number} Grid distance in meters
 */
export const calculateGridDistance = (p1, p2) => {
  return calculateHorizontalDistance(p1, p2);
};

/**
 * Calculate UTM scale factor
 * UTM uses Transverse Mercator projection with scale factor 0.9996 at central meridian
 * 
 * @param {number} lat - Latitude in degrees
 * @param {number} lon - Longitude in degrees
 * @param {number} centralMeridian - Central meridian of UTM zone
 * @returns {number} Scale factor
 */
export const calculateUTMScaleFactor = (lat, lon, centralMeridian) => {
  const k0 = 0.9996; // UTM scale factor at central meridian
  const latRad = toRadians(lat);
  const lonRad = toRadians(lon);
  const cmRad = toRadians(centralMeridian);
  
  const dLon = lonRad - cmRad;
  const e2 = 2 * WGS84_F - WGS84_F * WGS84_F; // First eccentricity squared
  
  const N = WGS84_A / Math.sqrt(1 - e2 * Math.sin(latRad) * Math.sin(latRad));
  const T = Math.tan(latRad) * Math.tan(latRad);
  const C = e2 * Math.cos(latRad) * Math.cos(latRad) / (1 - e2);
  
  const A = dLon * Math.cos(latRad);
  const A2 = A * A;
  const A4 = A2 * A2;
  
  const k = k0 * (1 + (1 + C) * A2 / 2 + (5 - 4 * T + 42 * C + 13 * C * C) * A4 / 24);
  
  return k;
};

/**
 * Get UTM central meridian from zone number
 * 
 * @param {number} zone - UTM zone number (1-60)
 * @returns {number} Central meridian in degrees
 */
export const getUTMCentralMeridian = (zone) => {
  return -183 + zone * 6;
};

/**
 * Detect UTM zone from longitude
 * 
 * @param {number} lon - Longitude in degrees
 * @returns {number} UTM zone number
 */
export const getUTMZone = (lon) => {
  return Math.floor((lon + 180) / 6) + 1;
};

/**
 * Calculate elevation factor
 * Corrects for the difference between distances at elevation vs sea level
 * 
 * @param {number} averageElevation - Average elevation in meters
 * @param {number} earthRadius - Earth radius in meters (default WGS84)
 * @returns {number} Elevation factor
 */
export const calculateElevationFactor = (averageElevation, earthRadius = WGS84_A) => {
  return (earthRadius + averageElevation) / earthRadius;
};

/**
 * 4. GROUND DISTANCE
 * True distance on Earth's surface, corrected for scale and elevation
 * 
 * @param {number} gridDistance - Grid distance in meters
 * @param {number} scaleFactor - Scale factor from projection
 * @param {number} elevationFactor - Elevation factor
 * @returns {number} Ground distance in meters
 */
export const calculateGroundDistance = (gridDistance, scaleFactor, elevationFactor) => {
  return gridDistance * scaleFactor * elevationFactor;
};

/**
 * 5. GEODESIC DISTANCE (Vincenty's Formula)
 * Most accurate distance on Earth's ellipsoid
 * 
 * @param {number} lat1 - Latitude of point 1 in degrees
 * @param {number} lon1 - Longitude of point 1 in degrees
 * @param {number} lat2 - Latitude of point 2 in degrees
 * @param {number} lon2 - Longitude of point 2 in degrees
 * @returns {Object} {distance, forwardAzimuth, reverseAzimuth}
 */
export const calculateGeodesicDistance = (lat1, lon1, lat2, lon2) => {
  const a = WGS84_A;
  const b = WGS84_B;
  const f = WGS84_F;
  
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const lambda1 = toRadians(lon1);
  const lambda2 = toRadians(lon2);
  
  const L = lambda2 - lambda1;
  const U1 = Math.atan((1 - f) * Math.tan(phi1));
  const U2 = Math.atan((1 - f) * Math.tan(phi2));
  
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);
  
  let lambda = L;
  let lambdaP;
  let iterLimit = 100;
  let cosSqAlpha, sinSigma, cos2SigmaM, cosSigma, sigma;
  
  do {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) * (cosU2 * sinLambda) +
      (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) *
      (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda)
    );
    
    if (sinSigma === 0) {
      // Co-incident points
      return { distance: 0, forwardAzimuth: 0, reverseAzimuth: 0 };
    }
    
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    
    cos2SigmaM = cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha;
    if (isNaN(cos2SigmaM)) {
      cos2SigmaM = 0; // Equatorial line
    }
    
    const C = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    lambdaP = lambda;
    lambda = L + (1 - C) * f * sinAlpha * (
      sigma + C * sinSigma * (
        cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
      )
    );
  } while (Math.abs(lambda - lambdaP) > 1e-12 && --iterLimit > 0);
  
  if (iterLimit === 0) {
    // Formula failed to converge
    console.warn('Vincenty formula failed to converge');
    return null;
  }
  
  const uSq = cosSqAlpha * (a * a - b * b) / (b * b);
  const A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  
  const deltaSigma = B * sinSigma * (
    cos2SigmaM + B / 4 * (
      cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
      B / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) *
      (-3 + 4 * cos2SigmaM * cos2SigmaM)
    )
  );
  
  const distance = b * A * (sigma - deltaSigma);
  
  // Calculate azimuths
  const sinLambda = Math.sin(lambda);
  const cosLambda = Math.cos(lambda);
  
  const forwardAzimuthRad = Math.atan2(
    cosU2 * sinLambda,
    cosU1 * sinU2 - sinU1 * cosU2 * cosLambda
  );
  
  const reverseAzimuthRad = Math.atan2(
    cosU1 * sinLambda,
    -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda
  );
  
  let forwardAzimuth = toDegrees(forwardAzimuthRad);
  let reverseAzimuth = toDegrees(reverseAzimuthRad) + 180;
  
  // Normalize to 0-360
  if (forwardAzimuth < 0) forwardAzimuth += 360;
  if (reverseAzimuth >= 360) reverseAzimuth -= 360;
  
  return {
    distance,
    forwardAzimuth,
    reverseAzimuth
  };
};

/**
 * Calculate all distances and bearings between two points
 * 
 * @param {Object} point1 - {lat, lon, elev, e, n} (mix of geographic and projected)
 * @param {Object} point2 - {lat, lon, elev, e, n}
 * @param {string} projectionType - 'UTM', 'StatePlane', etc.
 * @param {number} utmZone - UTM zone number (if applicable)
 * @returns {Object} All calculated distances and factors
 */
export const calculateAllDistances = (point1, point2, projectionType = 'UTM', utmZone = null) => {
  // 1. Slope Distance (if elevation data available)
  const slopeDistance = calculateSlopeDistance(point1, point2);
  
  // 2. Horizontal Distance
  const horizontalDistance = calculateHorizontalDistance(point1, point2);
  
  // 3. Grid Distance (same as horizontal in projected coords)
  const gridDistance = calculateGridDistance(point1, point2);
  
  // 4. Calculate factors for Ground Distance
  const avgLat = ((point1.lat || 0) + (point2.lat || 0)) / 2;
  const avgLon = ((point1.lon || point1.lng || 0) + (point2.lon || point2.lng || 0)) / 2;
  const avgElev = ((point1.elev || point1.elevation || 0) + (point2.elev || point2.elevation || 0)) / 2;
  
  let scaleFactor = 1.0;
  let centralMeridian = 0;
  
  if (projectionType === 'UTM') {
    const zone = utmZone || getUTMZone(avgLon);
    centralMeridian = getUTMCentralMeridian(zone);
    scaleFactor = calculateUTMScaleFactor(avgLat, avgLon, centralMeridian);
  }
  
  const elevationFactor = calculateElevationFactor(avgElev);
  const combinedFactor = scaleFactor * elevationFactor;
  
  // Ground Distance
  const groundDistance = calculateGroundDistance(gridDistance, scaleFactor, elevationFactor);
  
  // 5. Geodesic Distance with azimuths
  const geodesicResult = calculateGeodesicDistance(
    point1.lat || 0,
    point1.lon || point1.lng || 0,
    point2.lat || 0,
    point2.lon || point2.lng || 0
  );
  
  // Vertical angle (if elevation data)
  const verticalAngle = slopeDistance > 0 ? calculateVerticalAngle(slopeDistance, horizontalDistance) : 0;
  const elevationDifference = (point2.elev || point2.elevation || 0) - (point1.elev || point1.elevation || 0);
  
  return {
    slopeDistance,
    horizontalDistance,
    gridDistance,
    groundDistance,
    geodesicDistance: geodesicResult?.distance || 0,
    forwardAzimuth: geodesicResult?.forwardAzimuth || 0,
    reverseAzimuth: geodesicResult?.reverseAzimuth || 0,
    scaleFactor,
    elevationFactor,
    combinedFactor,
    verticalAngle,
    elevationDifference,
    centralMeridian,
    avgElevation: avgElev,
    utmZone: utmZone || getUTMZone(avgLon)
  };
};

/**
 * Calculate grid bearing/azimuth from projected coordinates
 * 
 * @param {Object} p1 - Point 1 {e, n}
 * @param {Object} p2 - Point 2 {e, n}
 * @returns {number} Bearing in degrees (0-360)
 */
export const calculateGridBearing = (p1, p2) => {
  const de = (p2.e || p2.easting || 0) - (p1.e || p1.easting || 0);
  const dn = (p2.n || p2.northing || 0) - (p1.n || p1.northing || 0);
  
  let bearing = toDegrees(Math.atan2(de, dn));
  if (bearing < 0) bearing += 360;
  
  return bearing;
};
