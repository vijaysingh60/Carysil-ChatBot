/**
 * Builds data/dealerGeo.json: lat/lon for every city in data/dealers.json, plus
 * well-known cities/states that have NO dealers (so "Hyderabad" is recognised as a
 * real place outside the network, and "nearest dealers" can be computed).
 *
 * Source: OpenStreetMap Nominatim (one-time lookup, ~1 request/second per their
 * usage policy). Re-run only when the dealer list gains new cities:
 *
 *   node scripts/buildDealerGeo.mjs
 *
 * Every served-city result is checked against a rough bounding box for its state;
 * anything outside is reported as SUSPECT and left out until fixed via SPELLING
 * below — small Indian town names are ambiguous (e.g. "Nanded" is also a village
 * in Bhandara), so never trust a result that fails the check.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dealers = JSON.parse(fs.readFileSync(path.join(root, "data/dealers.json"), "utf8"));

/** [minLat, maxLat, minLon, maxLon] — deliberately generous. */
const STATE_BOX = {
  Gujarat: [19.9, 24.8, 68.0, 74.6],
  Maharashtra: [15.5, 22.1, 72.5, 80.95],
  "Madhya Pradesh": [21.0, 26.9, 74.0, 82.9],
  Chhattisgarh: [17.7, 24.2, 80.2, 84.5],
  Jharkhand: [21.9, 25.4, 83.3, 87.95],
  Odisha: [17.7, 22.7, 81.3, 87.6],
  Bihar: [24.2, 27.6, 83.3, 88.3],
  "West Bengal": [21.5, 27.3, 85.8, 89.9],
  Sikkim: [27.0, 28.2, 88.0, 88.95],
  "Dadra and Nagar Haveli and Daman and Diu": [19.9, 20.8, 70.8, 73.3],
};
const INDIA_BOX = [6, 37.5, 68, 98];
const CITY_LIKE = new Set(["city", "town", "municipality", "village", "suburb", "borough"]);

/** Dealer-sheet spelling → a spelling OpenStreetMap knows. */
const SPELLING = {
  Narmdapuram: "Narmadapuram",
  Ahmadnagar: "Ahmednagar",
  Baroda: "Vadodara",
  Parlekhamundi: "Paralakhemundi",
  Bhawanipatna: "Bhawanipatna",
  Munchar: "Manchar",
  "Taala Gir": "Talala",
  Midnapore: "Medinipur",
  "Cooch Behar": "Cooch Behar",
  Saripali: "Sarangarh",
  Berhampur: "Brahmapur", // OpenStreetMap's name for the Ganjam city (plain "Berhampur" matches a village near Balasore)
};

/** Places with no dealers. [name, state-or-null] — null means the name IS a state/UT. */
const UNSERVED = [
  ["hyderabad", "Telangana"], ["secunderabad", "Telangana"], ["warangal", "Telangana"], ["karimnagar", "Telangana"],
  ["nizamabad", "Telangana"], ["khammam", "Telangana"],
  ["mumbai", "Maharashtra"], ["navi mumbai", "Maharashtra"], ["thane", "Maharashtra"], ["nagpur", "Maharashtra"],
  ["delhi", "Delhi"], ["new delhi", "Delhi"], ["noida", "Uttar Pradesh"], ["greater noida", "Uttar Pradesh"],
  ["gurgaon", "Haryana"], ["gurugram", "Haryana"], ["faridabad", "Haryana"], ["ghaziabad", "Uttar Pradesh"],
  ["bangalore", "Karnataka"], ["bengaluru", "Karnataka"], ["mysore", "Karnataka"], ["mysuru", "Karnataka"],
  ["mangalore", "Karnataka"], ["mangaluru", "Karnataka"], ["hubli", "Karnataka"], ["belgaum", "Karnataka"],
  ["belagavi", "Karnataka"],
  ["chennai", "Tamil Nadu"], ["coimbatore", "Tamil Nadu"], ["madurai", "Tamil Nadu"], ["salem", "Tamil Nadu"],
  ["trichy", "Tamil Nadu"], ["tiruchirappalli", "Tamil Nadu"],
  ["kochi", "Kerala"], ["cochin", "Kerala"], ["ernakulam", "Kerala"], ["thiruvananthapuram", "Kerala"],
  ["trivandrum", "Kerala"], ["kozhikode", "Kerala"], ["calicut", "Kerala"], ["thrissur", "Kerala"],
  ["visakhapatnam", "Andhra Pradesh"], ["vizag", "Andhra Pradesh"], ["vijayawada", "Andhra Pradesh"],
  ["guntur", "Andhra Pradesh"], ["tirupati", "Andhra Pradesh"], ["nellore", "Andhra Pradesh"],
  ["rajahmundry", "Andhra Pradesh"],
  ["jaipur", "Rajasthan"], ["jodhpur", "Rajasthan"], ["udaipur", "Rajasthan"], ["kota", "Rajasthan"],
  ["ajmer", "Rajasthan"], ["bikaner", "Rajasthan"],
  ["lucknow", "Uttar Pradesh"], ["kanpur", "Uttar Pradesh"], ["varanasi", "Uttar Pradesh"], ["agra", "Uttar Pradesh"],
  ["allahabad", "Uttar Pradesh"], ["prayagraj", "Uttar Pradesh"], ["meerut", "Uttar Pradesh"],
  ["dehradun", "Uttarakhand"], ["haridwar", "Uttarakhand"],
  ["chandigarh", "Chandigarh"], ["mohali", "Punjab"], ["ludhiana", "Punjab"], ["amritsar", "Punjab"],
  ["jalandhar", "Punjab"], ["patiala", "Punjab"],
  ["shimla", "Himachal Pradesh"], ["jammu", "Jammu and Kashmir"], ["srinagar", "Jammu and Kashmir"],
  ["guwahati", "Assam"], ["dibrugarh", "Assam"], ["shillong", "Meghalaya"], ["imphal", "Manipur"],
  ["agartala", "Tripura"], ["aizawl", "Mizoram"], ["kohima", "Nagaland"], ["itanagar", "Arunachal Pradesh"],
  ["panaji", "Goa"], ["goa", "Goa"], ["puducherry", "Puducherry"], ["pondicherry", "Puducherry"],
  // whole states / UTs we have no dealers in
  ["telangana", null], ["karnataka", null], ["tamil nadu", null], ["kerala", null], ["andhra pradesh", null],
  ["rajasthan", null], ["uttar pradesh", null], ["punjab", null], ["haryana", null], ["uttarakhand", null],
  ["himachal pradesh", null], ["jammu and kashmir", null], ["assam", null], ["meghalaya", null], ["manipur", null],
  ["tripura", null], ["mizoram", null], ["nagaland", null], ["arunachal pradesh", null], ["ladakh", null],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inBox = (lat, lon, [a, b, c, d]) => lat >= a && lat <= b && lon >= c && lon <= d;

async function geocode(query, mustMention) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "carysil-chatbot-dealer-geo/1.0 (vsp.krashi@gmail.com)", "Accept-Language": "en" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const results = await res.json();
      if (results.length === 0) return null;
      const needle = (mustMention ?? "").toLowerCase();
      // Prefer an actual city/town over a same-named district centre ("Solapur" the district vs the city),
      // restricted to results that mention the expected state.
      const inState = results.filter((r) => needle && r.display_name.toLowerCase().includes(needle));
      const candidates = inState.length > 0 ? inState : results;
      const pick = candidates.find((r) => CITY_LIKE.has(r.addresstype)) ?? candidates[0];
      return { lat: Number(pick.lat), lon: Number(pick.lon), label: pick.display_name };
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(5000);
    }
  }
  return null;
}

const served = {};
const unserved = {};
const suspect = [];

const cities = new Map(); // "City|State" → dealer count
for (const d of dealers) {
  const key = `${d.city}|${d.state}`;
  cities.set(key, (cities.get(key) ?? 0) + 1);
}

let n = 0;
for (const [key, count] of cities) {
  const [city, state] = key.split("|");
  const stateShort = state.startsWith("Dadra") ? "Dadra and Nagar Haveli" : state;
  const g = await geocode(`${SPELLING[city] ?? city}, ${stateShort}, India`, stateShort);
  await sleep(1100);
  n++;
  const box = STATE_BOX[state] ?? INDIA_BOX;
  if (!g || !inBox(g.lat, g.lon, box)) {
    suspect.push(`${key} (${count} dealers) → ${g ? `${g.lat.toFixed(2)},${g.lon.toFixed(2)} ${g.label.slice(0, 70)}` : "no result"}`);
  } else {
    served[key] = [Number(g.lat.toFixed(3)), Number(g.lon.toFixed(3))];
  }
  if (n % 20 === 0) console.log(`served ${n}/${cities.size}`);
}

for (const [name, state] of UNSERVED) {
  const g = await geocode(state ? `${name}, ${state}, India` : `${name}, India`, state ?? name);
  await sleep(1100);
  if (g && inBox(g.lat, g.lon, INDIA_BOX)) {
    unserved[name] = [Number(g.lat.toFixed(3)), Number(g.lon.toFixed(3))];
  } else {
    // Still recognised as "a place we don't serve" — just no distances for it.
    unserved[name] = null;
    suspect.push(`UNSERVED ${name} → ${g ? `${g.lat},${g.lon}` : "no result"}`);
  }
}

fs.writeFileSync(
  path.join(root, "data/dealerGeo.json"),
  JSON.stringify({ generated: new Date().toISOString().slice(0, 10), served, unserved }, null, 1)
);
console.log(`\nserved: ${Object.keys(served).length}/${cities.size}  unserved: ${Object.keys(unserved).length}/${UNSERVED.length}`);
console.log(suspect.length ? `\nSUSPECT / MISSING (${suspect.length}):\n` + suspect.join("\n") : "\nno suspect results");
