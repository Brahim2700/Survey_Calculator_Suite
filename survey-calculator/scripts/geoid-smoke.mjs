import path from "node:path";
import { fileURLToPath } from "node:url";
import proj4 from "proj4";
import { fromFile } from "geotiff";
import CRS_LIST from "../src/crsList.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const geoidDir = path.join(__dirname, "..", "public", "geoid");

// Register a small set of CRS definitions needed for the samples
function registerCrs(codes) {
  codes.forEach((code) => {
    const def = CRS_LIST.find((c) => c.code === code)?.proj4def;
    if (def) {
      proj4.defs(code, def);
    }
  });
}

// Simple bilinear sampler mirroring src/utils/geoid.js
async function makeSampler(localFilename) {
  const filePath = path.join(geoidDir, localFilename);
  const tiff = await fromFile(filePath);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bbox = image.getBoundingBox();
  const [minX, minY, maxX, maxY] = bbox;

  return async (lonDeg, latDeg) => {
    const lon = Math.min(Math.max(lonDeg, minX), maxX);
    const lat = Math.min(Math.max(latDeg, minY), maxY);

    const xNorm = (lon - minX) / (maxX - minX);
    const yNorm = (lat - minY) / (maxY - minY);

    const xPix = xNorm * (width - 1);
    const yPix = (1 - yNorm) * (height - 1);

    const x0 = Math.max(0, Math.min(Math.floor(xPix), width - 2));
    const y0 = Math.max(0, Math.min(Math.floor(yPix), height - 2));
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    const t = xPix - x0;
    const u = yPix - y0;

    const arr = await image.readRasters({
      window: [x0, y0, x1 + 1, y1 + 1],
      samples: [0],
      interleave: true,
    });

    const n00 = arr[0];
    const n10 = arr[1];
    const n01 = arr[2];
    const n11 = arr[3];

    const nTop = n00 * (1 - t) + n10 * t;
    const nBottom = n01 * (1 - t) + n11 * t;
    const N = nTop * (1 - u) + nBottom * u;

    return N;
  };
}

async function run() {
  registerCrs(["EPSG:2154", "EPSG:4326"]);

  const sampleRAF20 = await makeSampler("fr_ign_RAF20.tif");
  const sampleEGM96 = await makeSampler("us_nga_egm96_15.tif");

  // Paris, Lambert-93 -> WGS84
  const l93Point = [652709.401, 6859290.946];
  const [lon, lat] = proj4("EPSG:2154", "EPSG:4326", l93Point);
  const Nraf = await sampleRAF20(lon, lat);
  const H = 100; // orthometric height in meters
  const h = H + Nraf;

  // New York City, WGS84 ellipsoidal height -> orthometric using EGM96
  const lonNyc = -73.985656;
  const latNyc = 40.748433;
  const Nnyc = await sampleEGM96(lonNyc, latNyc);
  const hNyc = 30; // ellipsoidal
  const Hnyc = hNyc - Nnyc;

  console.log("Paris (Lambert-93 -> WGS84)");
  console.log({ lon, lat, geoid: Nraf.toFixed(3), H_in: H, h_out: h.toFixed(3) });

  console.log("\nNYC (WGS84 h -> orthometric using EGM96)");
  console.log({ lon: lonNyc, lat: latNyc, geoid: Nnyc.toFixed(3), h_in: hNyc, H_out: Hnyc.toFixed(3) });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
