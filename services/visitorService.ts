import { createHash } from "node:crypto";
import { getDbPool } from "@/lib/db";
import { ensureLeadSchema } from "@/services/sessionService";
import type { ContactInfo } from "@/types/lead";

/**
 * Visitor + person identity service.
 *
 * - A `visitor_id` is a long-lived UUID stored in localStorage by the widget.
 *   It groups multiple sessions belonging to the same browser without any
 *   fingerprinting.
 * - A `person_id` is created the first time we capture phone or email. We
 *   hash the contact (sha-256) and use that as the unique identifier — the raw
 *   PII still lives on the `leads` row but is never the join key for
 *   cross-session analytics.
 */

function hashContact(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export async function upsertVisitor(
  visitorId: string | null | undefined
): Promise<void> {
  if (!visitorId) return;
  if (!(await ensureLeadSchema())) return;
  try {
    const pool = getDbPool();
    await pool.query(
      `
      INSERT INTO visitors (visitor_id, last_seen, sessions_count)
      VALUES ($1, NOW(), 1)
      ON CONFLICT (visitor_id) DO UPDATE SET
        last_seen = NOW(),
        sessions_count = visitors.sessions_count + 1
      `,
      [visitorId]
    );
  } catch (error) {
    console.error("[identity] upsertVisitor failed", error);
  }
}

/**
 * Increment a visitor's last_seen on every turn without bumping sessions_count.
 * Cheaper than upsertVisitor when the row is known to exist.
 */
export async function touchVisitor(visitorId: string | null | undefined): Promise<void> {
  if (!visitorId) return;
  if (!(await ensureLeadSchema())) return;
  try {
    const pool = getDbPool();
    await pool.query(`UPDATE visitors SET last_seen = NOW() WHERE visitor_id = $1`, [
      visitorId,
    ]);
  } catch (error) {
    console.error("[identity] touchVisitor failed", error);
  }
}

export type PersonMergeResult = {
  personId: number | null;
  newPerson: boolean;
};

/**
 * Merge the captured contact info into a `persons` row, linking the related
 * `visitors` row and `leads.person_id`. Returns the resolved person id (or
 * null if no contact info was provided).
 */
export async function mergeIntoPerson(
  sessionId: string,
  contact: ContactInfo
): Promise<PersonMergeResult> {
  const phoneHash = contact.phone ? hashContact(contact.phone) : null;
  const emailHash = contact.email ? hashContact(contact.email) : null;
  if (!phoneHash && !emailHash) {
    return { personId: null, newPerson: false };
  }
  if (!(await ensureLeadSchema())) {
    return { personId: null, newPerson: false };
  }

  const pool = getDbPool();
  try {
    // 1. Look up any existing person by either hash.
    const existing = await pool.query<{ id: number }>(
      `
      SELECT id FROM persons
      WHERE ($1::text IS NOT NULL AND phone_hash = $1)
         OR ($2::text IS NOT NULL AND email_hash = $2)
      ORDER BY id ASC
      LIMIT 1
      `,
      [phoneHash, emailHash]
    );

    let personId: number;
    let newPerson = false;
    if (existing.rows.length > 0) {
      personId = existing.rows[0].id;
      // Fill in any missing hash so future lookups by the other channel work.
      await pool.query(
        `
        UPDATE persons SET
          phone_hash = COALESCE(persons.phone_hash, $2),
          email_hash = COALESCE(persons.email_hash, $3),
          last_seen = NOW()
        WHERE id = $1
        `,
        [personId, phoneHash, emailHash]
      );
    } else {
      const inserted = await pool.query<{ id: number }>(
        `
        INSERT INTO persons (phone_hash, email_hash)
        VALUES ($1, $2)
        RETURNING id
        `,
        [phoneHash, emailHash]
      );
      personId = inserted.rows[0].id;
      newPerson = true;
    }

    // 2. Stamp this session + lead with the person id and link the visitor.
    await pool.query(
      `
      UPDATE chat_sessions SET person_id = $1 WHERE session_id = $2 AND person_id IS DISTINCT FROM $1
      `,
      [personId, sessionId]
    );
    await pool.query(
      `
      UPDATE visitors SET person_id = COALESCE(visitors.person_id, $1)
      WHERE visitor_id IN (SELECT visitor_id FROM chat_sessions WHERE session_id = $2 AND visitor_id IS NOT NULL)
      `,
      [personId, sessionId]
    );
    await pool.query(
      `UPDATE leads SET person_id = $1 WHERE session_id = $2 AND person_id IS DISTINCT FROM $1`,
      [personId, sessionId]
    );

    return { personId, newPerson };
  } catch (error) {
    console.error("[identity] mergeIntoPerson failed", error);
    return { personId: null, newPerson: false };
  }
}

/** Returns the number of past sessions for the visitor that owns this session. */
export async function getReturningSessionCount(
  sessionId: string
): Promise<number> {
  if (!(await ensureLeadSchema())) return 0;
  try {
    const pool = getDbPool();
    const { rows } = await pool.query<{ count: string }>(
      `
      SELECT COALESCE(v.sessions_count, 0)::text AS count
      FROM chat_sessions cs
      LEFT JOIN visitors v ON v.visitor_id = cs.visitor_id
      WHERE cs.session_id = $1
      LIMIT 1
      `,
      [sessionId]
    );
    return Number(rows[0]?.count ?? 0);
  } catch (error) {
    console.error("[identity] getReturningSessionCount failed", error);
    return 0;
  }
}
