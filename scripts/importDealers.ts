import fs from "node:fs";
import path from "node:path";
import { getDbPool } from "../lib/db";

/**
 * Imports data/dealers.json into the `dealers` table.
 *
 * Usage:
 *   node --import tsx scripts/importDealers.ts [--dry-run]
 */

type RawDealer = {
  id: string;
  name: string;
  city: string;
  state: string;
  products_supported?: string[];
  contact_email?: string | null;
  phone?: string | null;
};

function loadLocalEnv(): void {
  const candidates = [".env.local", ".env"];
  for (const fileName of candidates) {
    const filePath = path.resolve(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

async function upsertDealer(dealer: RawDealer): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `
    INSERT INTO dealers (id, name, city, state, contact_email, phone)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      contact_email = EXCLUDED.contact_email,
      phone = EXCLUDED.phone
    `,
    [dealer.id, dealer.name, dealer.city, dealer.state, dealer.contact_email ?? null, dealer.phone ?? null]
  );
}

async function run(): Promise<void> {
  loadLocalEnv();
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");

  const filePath = path.resolve(process.cwd(), "data/dealers.json");
  const dealers = JSON.parse(fs.readFileSync(filePath, "utf8")) as RawDealer[];
  console.log(`Loaded ${dealers.length} dealers from data/dealers.json.`);

  const invalid = dealers.filter((d) => !d.id || !d.name || !d.city || !d.state);
  if (invalid.length > 0) {
    console.warn(`Skipping ${invalid.length} dealer(s) missing required fields (id/name/city/state).`);
  }
  const valid = dealers.filter((d) => d.id && d.name && d.city && d.state);

  const seen = new Set<string>();
  const deduped = valid.filter((d) => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
  if (deduped.length !== valid.length) {
    console.log(`Deduplicated ${valid.length - deduped.length} duplicate dealer id(s).`);
  }

  if (dryRun) {
    console.log(`Dry run: would upsert ${deduped.length} dealers. No database writes performed.`);
    return;
  }

  for (let i = 0; i < deduped.length; i += 1) {
    await upsertDealer(deduped[i]);
    if ((i + 1) % 50 === 0 || i + 1 === deduped.length) {
      console.log(`Upserted ${i + 1}/${deduped.length} dealers.`);
    }
  }

  console.log("Dealer import completed.");
}

run()
  .catch((error) => {
    console.error("Dealer import failed:", error);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
