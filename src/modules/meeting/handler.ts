/**
 * MeetingMemory webhook handler.
 *
 * Fireflies POSTs to /webhooks/fireflies when a transcript is ready. This
 * handler fetches the full transcript via the GraphQL API, persists a
 * canonical row in `meetings`, appends to the event log, and stubs the
 * Zep ingestion path for later.
 *
 * Signature verification is left as a stub for now — fill in once
 * FIREFLIES_WEBHOOK_SECRET is set in Fly secrets.
 */

import { createClient } from "@supabase/supabase-js";
import { logEvent } from "../scout/db.js";

interface FirefliesWebhookPayload {
  meetingId: string;
  eventType?: string;
  clientReferenceId?: string;
}

interface FirefliesTranscript {
  id: string;
  title?: string;
  date?: number;            // unix ms
  duration?: number;        // seconds
  meeting_link?: string;
  transcript_url?: string;
  participants?: string[];
  summary?: {
    short_summary?: string;
    action_items?: string;
    keywords?: string[];
  };
  sentences?: Array<{
    text: string;
    speaker_name?: string;
    start_time?: number;
  }>;
}

const FIREFLIES_GRAPHQL = "https://api.fireflies.ai/graphql";

export async function handleFirefliesWebhook(
  payload: FirefliesWebhookPayload,
  signature?: string
): Promise<void> {
  // TODO: validate signature against FIREFLIES_WEBHOOK_SECRET once Fireflies
  // documents the exact signing format. Fail closed once implemented.

  if (!payload.meetingId) {
    await logEvent("fireflies", "webhook_invalid", { payload });
    return;
  }

  // Always log the raw inbound event for replay/debugging.
  await logEvent("fireflies", "webhook_received", payload);

  const transcript = await fetchTranscript(payload.meetingId);
  if (!transcript) {
    await logEvent("fireflies", "transcript_not_found", { meetingId: payload.meetingId });
    return;
  }

  // Persist canonical meeting row.
  const meetingId = await upsertMeeting(transcript);

  // Persist the full transcript payload to the event log so memory ingestion
  // can be done async / re-run.
  await logEvent(
    "fireflies",
    "transcript_ingested",
    {
      meetingId: transcript.id,
      title: transcript.title,
      participants: transcript.participants,
      summary: transcript.summary,
      durationSeconds: transcript.duration,
    },
    [meetingId]
  );

  // TODO: enqueue Zep episode ingestion (entity extraction + edges).
  // For now, the raw event log is sufficient as a source of truth.
}

async function fetchTranscript(meetingId: string): Promise<FirefliesTranscript | null> {
  const apiKey = process.env.FIREFLIES_API_KEY;
  if (!apiKey) throw new Error("FIREFLIES_API_KEY required");

  const query = `
    query Transcript($id: String!) {
      transcript(id: $id) {
        id
        title
        date
        duration
        meeting_link
        transcript_url
        participants
        summary {
          short_summary
          action_items
          keywords
        }
        sentences {
          text
          speaker_name
          start_time
        }
      }
    }
  `;
  const res = await fetch(FIREFLIES_GRAPHQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables: { id: meetingId } }),
  });
  if (!res.ok) {
    throw new Error(`Fireflies GraphQL fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data?: { transcript?: FirefliesTranscript } };
  return body.data?.transcript ?? null;
}

async function upsertMeeting(transcript: FirefliesTranscript): Promise<string> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL/SERVICE_ROLE_KEY required");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const started = transcript.date ? new Date(transcript.date).toISOString() : null;
  const ended =
    transcript.date && transcript.duration
      ? new Date(transcript.date + transcript.duration * 1000).toISOString()
      : null;

  // Upsert by fireflies_id.
  const { data: existing } = await sb
    .from("meetings")
    .select("id")
    .eq("fireflies_id", transcript.id)
    .maybeSingle();

  if (existing) {
    await sb
      .from("meetings")
      .update({
        title: transcript.title ?? "(untitled)",
        started_at: started,
        ended_at: ended,
        participants: transcript.participants ?? [],
        summary: transcript.summary?.short_summary ?? null,
        transcript_url: transcript.transcript_url ?? null,
      })
      .eq("id", existing.id);
    return existing.id as string;
  }

  const { data: inserted, error } = await sb
    .from("meetings")
    .insert({
      fireflies_id: transcript.id,
      title: transcript.title ?? "(untitled)",
      started_at: started,
      ended_at: ended,
      participants: transcript.participants ?? [],
      summary: transcript.summary?.short_summary ?? null,
      transcript_url: transcript.transcript_url ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return inserted.id as string;
}
