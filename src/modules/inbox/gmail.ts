/**
 * Minimal Gmail REST client.
 *
 * Uses an OAuth refresh token (stored as a Fly secret) to mint short-lived
 * access tokens on demand. We avoid pulling in the heavy googleapis SDK to
 * keep the Bun bundle small and predictable.
 *
 * Docs: https://developers.google.com/gmail/api/reference/rest
 */

interface AccessTokenState {
  token: string;
  expiresAt: number;
}

let accessToken: AccessTokenState | null = null;

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (accessToken && accessToken.expiresAt > now + 60_000) return accessToken.token;

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN are required");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Gmail token refresh failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  accessToken = {
    token: body.access_token,
    expiresAt: now + body.expires_in * 1000,
  };
  return accessToken.token;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
}

export async function listMessages(query: string, maxResults = 25): Promise<GmailMessageSummary[]> {
  const token = await getAccessToken();
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(maxResults));
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gmail listMessages failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { messages?: GmailMessageSummary[] };
  return body.messages ?? [];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
  };
}

export async function getMessage(id: string): Promise<GmailMessage> {
  const token = await getAccessToken();
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail getMessage failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as GmailMessage;
}

export function parseFrom(header: string): { email: string; name?: string } {
  // Common forms:
  //   "Aaron Schott <aaron@princetonreview.com>"
  //   "aaron@princetonreview.com"
  const match = header.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    const name = match[1]?.trim();
    const email = match[2]?.trim() ?? "";
    return name ? { email, name } : { email };
  }
  return { email: header.trim() };
}

export function getHeader(message: GmailMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  return message.payload.headers.find((h) => h.name.toLowerCase() === lower)?.value;
}
