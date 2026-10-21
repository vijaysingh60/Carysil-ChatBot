/**
 * Cross-checks data/dealerGeo.json against the pincodes printed in the dealers' own addresses.
 *
 * Why: place NAMES are ambiguous ("Ashta", "Nanded" and "Solapur" each exist as a village or district
 * as well as the town), and a bounding-box check can't tell them apart. A 6-digit pincode can, so each
 * city's coordinate is compared with where its dealers' pincodes actually are.
 *
 *   node scripts/verifyDealerGeo.mjs          # report only
 *   node scripts/verifyDealerGeo.mjs --fix    # also correct coordinates when 2+ dealer pincodes agree
 *
 * A correction is only applied when at least two different pincodes (from different dealers) resolve
 * to nearly the same spot — a single typo'd pincode never moves a city. Anything else is left in the
 * report for a human to look at. ~1 request/second (OpenStreetMap Nominatim policy).
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dealers = JSON.parse(fs.readFileSync(path.join(root, "data/dealers.json"), "utf8"));
const geoPath = path.join(root, "data/dealerGeo.json");
const geo = JSON.parse(fs.readFileSync(geoPath, "utf8"));
const fix = process.argv.includes("--fix");

const MISMATCH_KM = 50; // city coordinate vs its dealers' pincodes
const AGREE_KM = 40; // two pincodes count as "agreeing" within this
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

async function geocodePin(pin) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&country=India&postalcode=${pin}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "carysil-chatbot-dealer-geo/1.0 (vsp.krashi@gmail.com)", "Accept-Language": "en" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const [hit] = await res.json();
      return hit ? [Number(hit.lat), Number(hit.lon)] : null;
    } catch (err) {
      if (attempt === 2) return null;
      await sleep(5000);
    }
  }
  return null;
}

// city key → pincodes, one per dealer (so two pincodes really are two independent dealers)
const pinsByCity = new Map();
for (const d of dealers) {
  const pin = (d.address ?? "").match(/(?<!\d)([1-9]\d{5})(?!\d)/)?.[1];
  if (!pin) continue;
  const key = `${d.city}|${d.state}`;
  if (!pinsByCity.has(key)) pinsByCity.set(key, []);
  const list = pinsByCity.get(key);
  if (!list.includes(pin)) list.push(pin);
}

const report = { ok: 0, noPin: 0, fixed: [], review: [] };
let n = 0;
for (const [key, coord] of Object.entries(geo.served)) {
  const pins = (pinsByCity.get(key) ?? []).slice(0, 3);
  if (pins.length === 0) {
    report.noPin++;
    continue;
  }
  const points = [];
  let agrees = false;
  for (const pin of pins) {
    const p = await geocodePin(pin);
    await sleep(1100);
    if (!p) continue;
    points.push({ pin, p });
    if (haversineKm(coord, p) <= MISMATCH_KM) {
      agrees = true; // one pincode confirming the city is enough — stop early
      break;
    }
  }
  if (++n % 20 === 0) console.log(`checked ${n} cities…`);
  if (agrees) {
    report.ok++;
    continue;
  }
  if (points.length === 0) {
    report.noPin++;
    continue;
  }
  const dists = points.map((x) => haversineKm(coord, x.p));
  // Disagreement. Trust the pincodes only if at least two of them agree with each other.
  const agreeing = points.filter((a) => points.filter((b) => haversineKm(a.p, b.p) <= AGREE_KM).length >= 2);
  if (agreeing.length >= 2) {
    const lat = agreeing.reduce((s, x) => s + x.p[0], 0) / agreeing.length;
    const lon = agreeing.reduce((s, x) => s + x.p[1], 0) / agreeing.length;
    report.fixed.push(
      `${key}: ${coord} → [${lat.toFixed(3)}, ${lon.toFixed(3)}]  (was ${Math.min(...dists).toFixed(0)} km from pincodes ${agreeing.map((x) => x.pin).join(",")})`
    );
    if (fix) geo.served[key] = [Number(lat.toFixed(3)), Number(lon.toFixed(3))];
  } else {
    report.review.push(
      `${key}: city point ${coord} is ${Math.min(...dists).toFixed(0)} km from pincode(s) ${points.map((x) => `${x.pin}@${x.p.map((v) => v.toFixed(2))}`).join(" ")} — only one usable pincode, left as is`
    );
  }
}

if (fix && report.fixed.length > 0) fs.writeFileSync(geoPath, JSON.stringify(geo, null, 1));
console.log(`\nverified OK: ${report.ok} | no usable pincode: ${report.noPin} | corrected${fix ? "" : " (dry run)"}: ${report.fixed.length} | needs review: ${report.review.length}`);
if (report.fixed.length) console.log("\nCORRECTIONS:\n" + report.fixed.join("\n"));
if (report.review.length) console.log("\nNEEDS REVIEW:\n" + report.review.join("\n"));
