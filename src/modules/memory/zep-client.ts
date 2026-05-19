/**
 * Thin wrapper around the Zep Cloud client.
 *
 * Centralizes lazy initialization, the singleton user id ("shaun"), and the
 * one or two graph operations the ingestion worker actually uses. Keeping the
 * surface small makes it easier to swap the underlying client later (for
 * example to a self-hosted Zep) without rippling through callers.
 */

import { ZepClient } from "@getzep/zep-cloud";
import type { Episode } from "./types.js";

export const ZEP_USER_ID = "shaun";

let client: ZepClient | null = null;
let userEnsured = false;

function getClient(): ZepClient {
  if (client) return client;
  const apiKey = process.env.ZEP_API_KEY;
  if (!apiKey) {
    throw new Error("ZEP_API_KEY must be set to use the memory ingestion worker");
  }
  client = new ZepClient({ apiKey });
  return client;
}

/**
 * Create the canonical Jarvis user in Zep if it does not already exist.
 * Safe to call repeatedly; result is cached for the lifetime of the process.
 */
export async function ensureUser(userId: string = ZEP_USER_ID): Promise<void> {
  if (userEnsured) return;
  const z = getClient();
  try {
    await z.user.get(userId);
    userEnsured = true;
    return;
  } catch {
    // User not found, create below.
  }
  try {
    await z.user.add({ userId, firstName: "Shaun" });
    userEnsured = true;
  } catch (err) {
    // Tolerate race conditions where another worker created the user first.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists|409/i.test(msg)) throw err;
    userEnsured = true;
  }
}

/**
 * Push a single episode into the Zep graph for the given user.
 *
 * The originating event id is folded into both the source description and
 * metadata so re-ingesting the same event is observable (and so we can chase
 * back to the source row for debugging). Zep currently has no first-class
 * dedup-by-key on graph.add, so the watermark in `runIngestion` is what
 * actually prevents duplicates.
 */
export async function addEpisode(
  episode: Episode,
  userId: string = ZEP_USER_ID
): Promise<void> {
  await ensureUser(userId);
  const z = getClient();
  await z.graph.add({
    userId,
    type: episode.kind,
    data: episode.body,
    createdAt: episode.occurredAt,
    sourceDescription: `${episode.sourceDescription} [event:${episode.eventId}]`,
    metadata: {
      eventId: episode.eventId,
      ...(episode.related && episode.related.length > 0
        ? { related: episode.related }
        : {}),
    },
  });
}
