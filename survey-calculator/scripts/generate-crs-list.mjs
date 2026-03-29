import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// epsg-index publishes JSON; use createRequire so we can import it inside an ES module.
const require = createRequire(import.meta.url);
const epsgIndex = require("epsg-index/all.json");

// Normalize the CRS type so downstream UI logic can keep using geographic/projected flags.
const normalizeType = (kind = "") => {
  if (kind.toLowerCase().startsWith("geographic")) return "geographic";
  return "projected";
};

// Flatten the epsg-index dictionary into an array of CRS objects compatible with the UI.
const crsArray = Object.values(epsgIndex)
  .filter((entry) => entry?.proj4) // skip entries that do not expose proj4 strings
  .map((entry) => ({
    code: `EPSG:${entry.code}`,
    label: `${entry.name}${entry.area ? ` (${entry.area})` : ""}`,
    type: normalizeType(entry.kind),
    region: entry.area || "Global",
    proj4def: entry.proj4
  }))
  .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

// Emit the module with a short banner so future devs know it is generated.
const banner = "// src/crsList.js\n// Auto-generated from epsg-index. Contains all EPSG codes with proj4 definitions.\n\n";
const body = `const CRS_LIST = ${JSON.stringify(crsArray, null, 2)};\n\nexport default CRS_LIST;\n`;

// Write the file and report how many CRS definitions landed in the output.
fs.writeFileSync(path.resolve("src/crsList.js"), banner + body, "utf8");
console.log(`Wrote ${crsArray.length} CRS definitions to src/crsList.js`);
