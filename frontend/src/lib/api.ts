import type { ChatUser, EncryptedMessage, KeyExchangeResponse } from "../types";

const DEFAULT_API_BASE = import.meta.env.VITE_NCHAT_API_BASE ?? "http://localhost:8080";
const DEFAULT_WS_URL = import.meta.env.VITE_NCHAT_WS_URL ?? "ws://localhost:8080/ws";

let resolvedApiBase: string | null = null;
let resolvedWsUrl: string | null = null;

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    if (data.error && data.error.trim().length > 0) {
      return data.error;
    }
  } catch {
    // Keep fallback if the response body is not valid JSON.
  }
  return fallback;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function browserHostCandidates(): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  const host = window.location.hostname;
  if (!host) {
    return [];
  }

  const candidates: string[] = [];
  for (let port = 8080; port <= 8090; port += 1) {
    candidates.push(`http://${host}:${port}`);
  }
  return candidates;
}

function buildCandidates(): string[] {
  const envCandidates = [DEFAULT_API_BASE, DEFAULT_API_BASE.replace("localhost", "127.0.0.1")];
  const fallbackCandidates: string[] = [];

  for (let port = 8080; port <= 8090; port += 1) {
    fallbackCandidates.push(`http://localhost:${port}`);
    fallbackCandidates.push(`http://127.0.0.1:${port}`);
  }

  return unique([...browserHostCandidates(), ...envCandidates, ...fallbackCandidates]);
}

function toWsUrl(apiBase: string): string {
  try {
    const url = new URL(apiBase);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return DEFAULT_WS_URL;
  }
}

async function probeHealth(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

async function resolveApiBase(): Promise<string> {
  if (resolvedApiBase) {
    return resolvedApiBase;
  }

  const candidates = buildCandidates();
  for (const candidate of candidates) {
    if (await probeHealth(candidate)) {
      resolvedApiBase = candidate;
      resolvedWsUrl = toWsUrl(candidate);
      return candidate;
    }
  }

  resolvedApiBase = DEFAULT_API_BASE;
  resolvedWsUrl = DEFAULT_WS_URL;
  return resolvedApiBase ?? DEFAULT_API_BASE;
}

export async function exchangeKey(nickname: string, publicKey: string, clientId?: string): Promise<KeyExchangeResponse> {
  const apiBase = await resolveApiBase();
  const response = await fetch(`${apiBase}/api/v1/key-exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname, publicKey, clientId })
  });

  if (!response.ok) {
    throw new Error("Key exchange failed");
  }

  return response.json() as Promise<KeyExchangeResponse>;
}

export async function loadMessages(limit = 200): Promise<EncryptedMessage[]> {
  const apiBase = await resolveApiBase();
  const response = await fetch(`${apiBase}/api/v1/messages?limit=${limit}`);
  if (!response.ok) {
    throw new Error("Failed to load messages");
  }
  return response.json() as Promise<EncryptedMessage[]>;
}

export async function checkBackendHealth(): Promise<boolean> {
  const candidates = buildCandidates();
  for (const candidate of candidates) {
    if (await probeHealth(candidate)) {
      resolvedApiBase = candidate;
      resolvedWsUrl = toWsUrl(candidate);
      return true;
    }
  }
  return false;
}

export async function findUsers(query: string, excludeClientId: string): Promise<ChatUser[]> {
  const params = new URLSearchParams();
  if (query.trim()) {
    params.set("query", query.trim());
  }
  if (excludeClientId) {
    params.set("excludeClientId", excludeClientId);
  }

  const apiBase = await resolveApiBase();
  const response = await fetch(`${apiBase}/api/v1/users?${params.toString()}`);
  if (!response.ok) {
    throw new Error("Failed to search users");
  }

  const data = (await response.json()) as { users: ChatUser[] };
  return data.users;
}

export async function pingPresence(clientId: string): Promise<void> {
  const apiBase = await resolveApiBase();
  const response = await fetch(`${apiBase}/api/v1/presence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId })
  });

  if (!response.ok) {
    throw new Error("Presence ping failed");
  }
}

export async function postEncryptedMessage(
  sender: string,
  senderClientId: string,
  ciphertext: string,
  nonce: string,
  chatType: "public" | "private" | "group",
  recipientClientIds: string[]
): Promise<void> {
  const apiBase = await resolveApiBase();
  const response = await fetch(`${apiBase}/api/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, senderClientId, ciphertext, nonce, chatType, recipientClientIds })
  });

  if (!response.ok) {
    throw new Error("Failed to send message");
  }
}

export async function clearPrivateChat(selfClientId: string, partnerClientId: string): Promise<number> {
  const apiBase = await resolveApiBase();
  const params = new URLSearchParams({ selfClientId, partnerClientId });
  const response = await fetch(`${apiBase}/api/v1/messages/private?${params.toString()}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    throw new Error("Failed to clear private chat");
  }

  const data = (await response.json()) as { deleted: number };
  return data.deleted;
}

export async function getBroadcastAdmin(actorClientId: string): Promise<string> {
  const apiBase = await resolveApiBase();
  const response = await fetch(`${apiBase}/api/v1/broadcast/admin/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorClientId })
  });
  if (!response.ok) {
    throw new Error(await readApiError(response, "Failed to load broadcast admin"));
  }
  const data = (await response.json()) as { adminClientId: string };
  return data.adminClientId;
}

export async function setBroadcastAdmin(actorClientId: string, adminClientId: string): Promise<string> {
  const apiBase = await resolveApiBase();
  const response = await fetch(`${apiBase}/api/v1/broadcast/admin/set`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorClientId, adminClientId })
  });
  if (!response.ok) {
    throw new Error(await readApiError(response, "Failed to update broadcast admin"));
  }
  const data = (await response.json()) as { adminClientId: string };
  return data.adminClientId;
}

async function broadcastAction(path: string, actorClientId: string): Promise<number> {
  const apiBase = await resolveApiBase();
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorClientId })
  });
  if (!response.ok) {
    throw new Error(await readApiError(response, "Broadcast action failed"));
  }
  const data = (await response.json()) as { deleted: number };
  return data.deleted;
}

export async function clearBroadcastChat(actorClientId: string): Promise<number> {
  return broadcastAction("/api/v1/messages/broadcast/clear", actorClientId);
}

export async function deleteBroadcastChat(actorClientId: string): Promise<number> {
  return broadcastAction("/api/v1/messages/broadcast/delete", actorClientId);
}

export async function getGroupAdmin(actorClientId: string, memberClientIds: string[]): Promise<string> {
  const apiBase = await resolveApiBase();
  const response = await fetch(`${apiBase}/api/v1/groups/admin/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorClientId, memberClientIds })
  });
  if (!response.ok) {
    throw new Error(await readApiError(response, "Failed to load group admin"));
  }
  const data = (await response.json()) as { adminClientId: string };
  return data.adminClientId;
}

export async function setGroupAdmin(actorClientId: string, memberClientIds: string[], adminClientId: string): Promise<string> {
  const apiBase = await resolveApiBase();
  const response = await fetch(`${apiBase}/api/v1/groups/admin/set`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorClientId, memberClientIds, adminClientId })
  });
  if (!response.ok) {
    throw new Error(await readApiError(response, "Failed to update group admin"));
  }
  const data = (await response.json()) as { adminClientId: string };
  return data.adminClientId;
}

async function groupAction(path: string, actorClientId: string, memberClientIds: string[]): Promise<number> {
  const apiBase = await resolveApiBase();
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorClientId, memberClientIds })
  });
  if (!response.ok) {
    throw new Error(await readApiError(response, "Group action failed"));
  }
  const data = (await response.json()) as { deleted: number };
  return data.deleted;
}

export async function clearGroupChat(actorClientId: string, memberClientIds: string[]): Promise<number> {
  return groupAction("/api/v1/messages/group/clear", actorClientId, memberClientIds);
}

export async function deleteGroupChat(actorClientId: string, memberClientIds: string[]): Promise<number> {
  return groupAction("/api/v1/messages/group/delete", actorClientId, memberClientIds);
}

export function openMessageSocket(onMessage: (message: EncryptedMessage) => void): WebSocket {
  const ws = new WebSocket(resolvedWsUrl ?? DEFAULT_WS_URL);

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data) as EncryptedMessage;
    onMessage(message);
  };

  return ws;
}
