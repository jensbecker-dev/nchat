import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  checkBackendHealth,
  clearBroadcastChat,
  clearGroupChat,
  clearPrivateChat,
  deleteBroadcastChat,
  deleteGroupChat,
  exchangeKey,
  findUsers,
  getBroadcastAdmin,
  getGroupAdmin,
  loadMessages,
  openMessageSocket,
  pingPresence,
  postEncryptedMessage,
  setBroadcastAdmin,
  setGroupAdmin
} from "./lib/api";
import { decryptMessage, decryptRoomKey, encryptMessage, generateOperatorKeys } from "./lib/crypto";
import type { RoomKey } from "./lib/crypto";
import type { ChatUser, EncryptedMessage } from "./types";

interface DecryptedMessage {
  id: number;
  sender: string;
  senderClientId: string;
  chatType: "public" | "private" | "group";
  groupKey: string;
  recipientClientIds: string[];
  content: MessageContent;
  preview: string;
  createdAt: string;
}

interface FilePayload {
  v: 1;
  t: "file";
  name: string;
  mimeType: string;
  size: number;
  data: string;
  checksum: string;
  caption?: string;
  accessMode?: FileAccessMode;
  allowedClientIds?: string[];
}

interface PendingFile {
  name: string;
  mimeType: string;
  size: number;
  data: string;
  checksum: string;
}

type MessageContent =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "file";
      file: PendingFile;
      caption: string;
      accessMode: FileAccessMode;
      allowedClientIds: string[];
    };

type FileAccessMode = "broadcast" | "users" | "group";

interface ConversationThread {
  key: string;
  audience: ChatAudience;
  partnerIds: string[];
  title: string;
  subtitle: string;
  lastAt: string;
}

interface SharedFileItem {
  messageId: number;
  sender: string;
  senderClientId: string;
  createdAt: string;
  audience: ChatAudience;
  partnerIds: string[];
  threadKey: string;
  threadTitle: string;
  direction: "sent" | "received";
  file: PendingFile;
  caption: string;
}

interface FileLibraryConfig {
  scope: "all" | "current";
  includeSent: boolean;
  includeReceived: boolean;
  includePublic: boolean;
  includePrivate: boolean;
  includeGroup: boolean;
  sortBy: "newest" | "oldest" | "size-desc" | "size-asc";
  limit: number;
}

type ThemeMode = "dark" | "light";
type CryptoMode = "secure" | "insecure";
type ChatAudience = "public" | "private" | "group";
type CryptoEngine = "WebCrypto" | "Forge" | "Fallback";
type SidebarSection = "contacts" | "files";

const sidebarPlugins = [
  { id: "files", label: "Files", short: "FI" }
];

const SESSION_CLIENT_ID_KEY = "nchat.clientId";
const FILES_CONFIG_KEY = "nchat.files.config";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const FILE_ACCESS_DEFAULT: FileAccessMode = "broadcast";
const defaultFileLibraryConfig: FileLibraryConfig = {
  scope: "all",
  includeSent: true,
  includeReceived: true,
  includePublic: true,
  includePrivate: true,
  includeGroup: true,
  sortBy: "newest",
  limit: 120
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

async function buildPendingFile(file: File): Promise<PendingFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let checksum = "";

  if (typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined") {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    checksum = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  return {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    data: bytesToBase64(bytes),
    checksum
  };
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function encodeFilePayload(file: PendingFile, caption: string, accessMode: FileAccessMode, allowedClientIds: string[]): string {
  const payload: FilePayload = {
    v: 1,
    t: "file",
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    data: file.data,
    checksum: file.checksum,
    caption: caption || undefined,
    accessMode,
    allowedClientIds: uniqueIds(allowedClientIds)
  };
  return JSON.stringify(payload);
}

function decodeMessageContent(rawPlaintext: string): MessageContent {
  const plaintext = rawPlaintext ?? "";
  try {
    const parsed = JSON.parse(plaintext) as Partial<FilePayload>;
    if (
      parsed &&
      parsed.t === "file" &&
      parsed.v === 1 &&
      typeof parsed.name === "string" &&
      typeof parsed.mimeType === "string" &&
      typeof parsed.size === "number" &&
      typeof parsed.data === "string"
    ) {
      return {
        kind: "file",
        file: {
          name: parsed.name,
          mimeType: parsed.mimeType,
          size: parsed.size,
          data: parsed.data,
          checksum: typeof parsed.checksum === "string" ? parsed.checksum : ""
        },
        caption: typeof parsed.caption === "string" ? parsed.caption : "",
        accessMode: parsed.accessMode === "users" || parsed.accessMode === "group" ? parsed.accessMode : "broadcast",
        allowedClientIds: Array.isArray(parsed.allowedClientIds)
          ? parsed.allowedClientIds.filter((id): id is string => typeof id === "string")
          : []
      };
    }
  } catch {
    // Messages from old clients are plain text and should remain readable.
  }

  return {
    kind: "text",
    text: plaintext
  };
}

function canAccessFile(
  content: Extract<MessageContent, { kind: "file" }>,
  viewerClientId: string,
  senderClientId: string,
  recipientClientIds: string[]
): boolean {
  if (!viewerClientId) {
    return false;
  }
  if (viewerClientId === senderClientId) {
    return true;
  }

  if (content.accessMode === "broadcast") {
    return true;
  }

  const members = content.allowedClientIds.length > 0 ? content.allowedClientIds : [senderClientId, ...recipientClientIds];
  return members.includes(viewerClientId);
}

function messagePreview(content: MessageContent): string {
  if (content.kind === "text") {
    return content.text.slice(0, 42) || "Message";
  }
  const base = `[File] ${content.file.name}`;
  return content.caption ? `${base}: ${content.caption.slice(0, 20)}` : base;
}

function generateCallsign(): string {
  const words = ["ATLAS", "NEXUS", "ORION", "CIPHER", "DELTA", "VECTOR", "NOVA", "PIVOT"];
  const word = words[Math.floor(Math.random() * words.length)];
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `${word}-${suffix}`;
}

function threadKey(audience: ChatAudience, partnerIds: string[]): string {
  if (audience === "public") {
    return "public";
  }
  return `${audience}:${[...partnerIds].sort().join(",")}`;
}

function groupKeyForMembers(clientId: string, partnerIds: string[]): string {
  if (!clientId) {
    return "";
  }
  return `group:${[clientId, ...partnerIds].sort().join(",")}`;
}

export default function App() {
  const [nickname, setNickname] = useState("");
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const savedTheme = localStorage.getItem("nchat.theme");
    return savedTheme === "dark" || savedTheme === "light" ? savedTheme : "light";
  });
  const [status, setStatus] = useState("Offline");
  const [backendReady, setBackendReady] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [clientId, setClientId] = useState("");
  const [roomKey, setRoomKey] = useState<RoomKey | null>(null);
  const [cryptoMode, setCryptoMode] = useState<CryptoMode>("secure");
  const [cryptoEngine, setCryptoEngine] = useState<CryptoEngine>("WebCrypto");
  const [messages, setMessages] = useState<DecryptedMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
  const [fileAccessMode, setFileAccessMode] = useState<FileAccessMode>(FILE_ACCESS_DEFAULT);
  const [fileAllowedClientIds, setFileAllowedClientIds] = useState<string[]>([]);
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeSidebarSection, setActiveSidebarSection] = useState<SidebarSection>("contacts");
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const [partnerFilter, setPartnerFilter] = useState("");
  const [isPartnerSearchFocused, setIsPartnerSearchFocused] = useState(false);
  const [chatAudience, setChatAudience] = useState<ChatAudience>("public");
  const [selectedPartnerIds, setSelectedPartnerIds] = useState<string[]>([]);
  const [groupAdminByKey, setGroupAdminByKey] = useState<Record<string, string>>({});
  const [broadcastAdminId, setBroadcastAdminId] = useState("");
  const [isBroadcastAdminLoading, setIsBroadcastAdminLoading] = useState(false);
  const [showBroadcastAdminSettings, setShowBroadcastAdminSettings] = useState(false);
  const [showGroupAdminSettings, setShowGroupAdminSettings] = useState(false);
  const [showFilesConfig, setShowFilesConfig] = useState(false);
  const [filesConfig, setFilesConfig] = useState<FileLibraryConfig>(() => {
    const raw = localStorage.getItem(FILES_CONFIG_KEY);
    if (!raw) {
      return defaultFileLibraryConfig;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<FileLibraryConfig>;
      return { ...defaultFileLibraryConfig, ...parsed };
    } catch {
      return defaultFileLibraryConfig;
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [storedClientId, setStoredClientId] = useState<string>(() => localStorage.getItem(SESSION_CLIENT_ID_KEY) ?? "");

  const socketRef = useRef<WebSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const autoConnectAttemptedRef = useRef(false);

  useEffect(() => {
    const storedNickname = localStorage.getItem("nchat.nickname");
    if (storedNickname && storedNickname.trim().length >= 2) {
      setNickname(storedNickname.trim());
    } else {
      const generated = generateCallsign();
      setNickname(generated);
      localStorage.setItem("nchat.nickname", generated);
    }

    return () => {
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!isMobileLayout) {
      return;
    }

    document.body.style.overflow = sidebarCollapsed ? "" : "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isMobileLayout, sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem(FILES_CONFIG_KEY, JSON.stringify(filesConfig));
  }, [filesConfig]);

  useEffect(() => {
    const applyLayout = () => {
      const mobile = window.innerWidth <= 1024;
      setIsMobileLayout(mobile);
      if (mobile) {
        setSidebarCollapsed(true);
      }
    };

    applyLayout();
    window.addEventListener("resize", applyLayout);
    return () => {
      window.removeEventListener("resize", applyLayout);
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("nchat.theme", theme);
  }, [theme]);

  useEffect(() => {
    if (nickname.trim().length >= 2) {
      localStorage.setItem("nchat.nickname", nickname.trim());
    }
  }, [nickname]);

  useEffect(() => {
    const runHealthCheck = async () => {
      const healthy = await checkBackendHealth();
      setBackendReady(healthy);
      if (!isConnected && !isConnecting) {
        setStatus(healthy ? "Ready" : "Offline");
      }
    };

    void runHealthCheck();
    const timer = window.setInterval(() => {
      void runHealthCheck();
    }, 4000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isConnected, isConnecting]);

  useEffect(() => {
    if (!isConnected || !clientId) {
      return;
    }

    const refreshUsers = async () => {
      try {
        const found = await findUsers("", clientId);
        setUsers(found.filter((user) => user.online));
      } catch {
        // Keep previous partner list when refresh fails.
      }
    };

    void refreshUsers();
    const timer = window.setInterval(() => {
      void refreshUsers();
    }, 5000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isConnected, clientId]);

  useEffect(() => {
    if (!isConnected || !clientId) {
      return;
    }

    const sendPresence = async () => {
      try {
        await pingPresence(clientId);
      } catch {
        // Connection stability is tracked via websocket + health checks.
      }
    };

    void sendPresence();
    const timer = window.setInterval(() => {
      void sendPresence();
    }, 15000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isConnected, clientId]);

  const contacts = useMemo(() => {
    const byClientId = new Set<string>();
    const byNickname = new Map<string, ChatUser>();

    for (const user of users) {
      if (byClientId.has(user.clientId)) {
        continue;
      }
      byClientId.add(user.clientId);

      const nickKey = user.nickname.trim().toLowerCase();
      const key = nickKey || user.clientId;
      const existing = byNickname.get(key);
      if (!existing) {
        byNickname.set(key, user);
        continue;
      }

      const existingSeen = Date.parse(existing.lastSeen);
      const candidateSeen = Date.parse(user.lastSeen);
      if (!Number.isNaN(candidateSeen) && (Number.isNaN(existingSeen) || candidateSeen > existingSeen)) {
        byNickname.set(key, user);
      }
    }

    return [...byNickname.values()];
  }, [users]);

  const visibleUsers = useMemo(() => {
    const query = partnerFilter.trim().toLowerCase();
    if (!query) {
      return contacts;
    }
    return contacts.filter((user) => {
      const nick = user.nickname.toLowerCase();
      const id = user.clientId.toLowerCase();
      return nick.includes(query) || id.includes(query);
    });
  }, [contacts, partnerFilter]);

  const contactSuggestions = useMemo(() => {
    const query = partnerFilter.trim().toLowerCase();
    if (!query) {
      return [];
    }
    return contacts
      .filter((user) => {
        const nick = user.nickname.toLowerCase();
        const id = user.clientId.toLowerCase();
        return nick.includes(query) || id.includes(query);
      })
      .slice(0, 12);
  }, [contacts, partnerFilter]);

  const showContactSuggestions = isPartnerSearchFocused && contactSuggestions.length > 0;

  const broadcastAdminCandidates = useMemo(() => {
    const list: Array<{ id: string; label: string }> = [];
    const seen = new Set<string>();

    const pushCandidate = (id: string, label: string) => {
      if (!id || seen.has(id)) {
        return;
      }
      seen.add(id);
      list.push({ id, label });
    };

    pushCandidate(clientId, `${nickname} (you)`);
    for (const user of contacts) {
      pushCandidate(user.clientId, user.nickname || user.clientId.slice(0, 8));
    }
    return list;
  }, [clientId, nickname, contacts]);

  const userById = useMemo(() => {
    const map = new Map<string, ChatUser>();
    for (const user of users) {
      map.set(user.clientId, user);
    }
    return map;
  }, [users]);

  const fileAccessCandidates = useMemo(() => {
    const map = new Map<string, string>();
    map.set(clientId, `${nickname} (you)`);
    for (const user of contacts) {
      map.set(user.clientId, user.nickname || user.clientId.slice(0, 8));
    }
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [clientId, nickname, contacts]);

  useEffect(() => {
    if (!pendingFile) {
      return;
    }

    if (chatAudience === "private") {
      setFileAccessMode("users");
      setFileAllowedClientIds(uniqueIds([clientId, ...selectedPartnerIds]));
      return;
    }
    if (chatAudience === "group") {
      setFileAccessMode("group");
      setFileAllowedClientIds(uniqueIds([clientId, ...selectedPartnerIds]));
      return;
    }

    setFileAccessMode(FILE_ACCESS_DEFAULT);
  }, [pendingFile, chatAudience, clientId, selectedPartnerIds]);

  const canSend = useMemo(() => {
    const hasText = draft.trim().length > 0;
    const hasFile = pendingFile !== null;
    if (!isConnected || (!hasText && !hasFile)) {
      return false;
    }
    if (cryptoMode !== "insecure" && roomKey === null) {
      return false;
    }
    if (chatAudience === "private") {
      return selectedPartnerIds.length === 1;
    }
    if (chatAudience === "group") {
      return selectedPartnerIds.length > 0;
    }
    if (pendingFile && fileAccessMode === "users" && fileAllowedClientIds.length === 0) {
      return false;
    }
    return true;
  }, [isConnected, draft, pendingFile, cryptoMode, roomKey, chatAudience, selectedPartnerIds, fileAccessMode, fileAllowedClientIds]);

  const filteredMessages = useMemo(() => {
    if (chatAudience === "public") {
      return messages.filter((msg) => msg.chatType === "public");
    }

    if (chatAudience === "private") {
      const target = selectedPartnerIds[0];
      if (!target) {
        return [];
      }
      return messages.filter((msg) => {
        if (msg.chatType !== "private") {
          return false;
        }
        if (msg.senderClientId === target && msg.recipientClientIds.includes(clientId)) {
          return true;
        }
        if (msg.senderClientId === clientId && msg.recipientClientIds.includes(target)) {
          return true;
        }
        return false;
      });
    }

    const selected = new Set(selectedPartnerIds);
    return messages.filter((msg) => {
      if (msg.chatType !== "group") {
        return false;
      }
      if (msg.senderClientId === clientId) {
        const targets = msg.recipientClientIds.filter((id) => id !== clientId);
        return targets.length === selected.size && targets.every((id) => selected.has(id));
      }
      const incomingMembers = new Set(msg.recipientClientIds.filter((id) => id !== clientId));
      incomingMembers.add(msg.senderClientId);
      return incomingMembers.size === selected.size && [...incomingMembers].every((id) => selected.has(id));
    });
  }, [messages, chatAudience, selectedPartnerIds, clientId]);

  const selectedThreadKey = useMemo(() => threadKey(chatAudience, selectedPartnerIds), [chatAudience, selectedPartnerIds]);
  const currentGroupKey = useMemo(() => {
    if (chatAudience !== "group" || !clientId) {
      return "";
    }
    return groupKeyForMembers(clientId, selectedPartnerIds);
  }, [chatAudience, clientId, selectedPartnerIds]);
  const currentGroupAdminId = currentGroupKey ? groupAdminByKey[currentGroupKey] ?? "" : "";
  const currentGroupAdmin = currentGroupAdminId ? userById.get(currentGroupAdminId) : undefined;
  const currentGroupAdminLabel =
    currentGroupAdminId === clientId
      ? `${nickname} (you)`
      : currentGroupAdmin?.nickname ?? (currentGroupAdminId ? currentGroupAdminId.slice(0, 8) : "Not assigned");
  const isCurrentUserGroupAdmin = chatAudience === "group" && !!currentGroupAdminId && currentGroupAdminId === clientId;
  const broadcastAdminUser = broadcastAdminId ? userById.get(broadcastAdminId) : undefined;
  const broadcastAdminLabel =
    broadcastAdminId === clientId
      ? `${nickname} (you)`
      : broadcastAdminUser?.nickname ?? (broadcastAdminId ? broadcastAdminId.slice(0, 8) : "Not assigned");
  const isCurrentUserBroadcastAdmin = chatAudience === "public" && !!broadcastAdminId && broadcastAdminId === clientId;

  useEffect(() => {
    if (chatAudience !== "group") {
      setShowGroupAdminSettings(false);
    }
  }, [chatAudience]);

  useEffect(() => {
    if (chatAudience !== "public") {
      setShowBroadcastAdminSettings(false);
    }
  }, [chatAudience]);

  useEffect(() => {
    if (!isConnected || !clientId) {
      return;
    }

    let cancelled = false;
    const refreshBroadcastAdmin = async (showLoading: boolean) => {
      if (showLoading) {
        setIsBroadcastAdminLoading(true);
      }
      try {
        const adminId = await getBroadcastAdmin(clientId);
        if (!cancelled) {
          setBroadcastAdminId((prev) => (prev === adminId ? prev : adminId));
        }
      } catch {
        // Keep current state; next sync tick retries.
      } finally {
        if (showLoading && !cancelled) {
          setIsBroadcastAdminLoading(false);
        }
      }
    };

    void refreshBroadcastAdmin(true);
    const timer = window.setInterval(() => {
      void refreshBroadcastAdmin(false);
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isConnected, clientId]);

  const conversationThreads = useMemo(() => {
    const map = new Map<string, ConversationThread>();

    const upsert = (thread: ConversationThread) => {
      const existing = map.get(thread.key);
      if (!existing || new Date(thread.lastAt).getTime() > new Date(existing.lastAt).getTime()) {
        map.set(thread.key, thread);
      }
    };

    upsert({
      key: "public",
      audience: "public",
      partnerIds: [],
      title: "Broadcast",
      subtitle: "All active partners",
      lastAt: new Date(0).toISOString()
    });

    for (const msg of messages) {
      if (msg.chatType === "public") {
        upsert({
          key: "public",
          audience: "public",
          partnerIds: [],
          title: "Broadcast",
          subtitle: msg.preview || "Public updates",
          lastAt: msg.createdAt
        });
        continue;
      }

      if (msg.chatType === "private") {
        const isIncoming = msg.senderClientId !== "" && msg.recipientClientIds.includes(clientId);
        const isOutgoing = msg.senderClientId === clientId;
        if (!isIncoming && !isOutgoing) {
          continue;
        }

        const partner = msg.senderClientId === clientId ? msg.recipientClientIds[0] : msg.senderClientId;
        if (!partner) {
          continue;
        }
        const user = userById.get(partner);
        upsert({
          key: threadKey("private", [partner]),
          audience: "private",
          partnerIds: [partner],
          title: user?.nickname ?? `Private ${partner.slice(0, 8)}`,
          subtitle: msg.preview || "Private messages",
          lastAt: msg.createdAt
        });
        continue;
      }

      const currentUserInRecipients = msg.recipientClientIds.includes(clientId);
      const currentUserIsSender = msg.senderClientId === clientId;
      if (!currentUserInRecipients && !currentUserIsSender) {
        continue;
      }

      const groupMembers = new Set<string>(msg.recipientClientIds.filter((id) => id !== clientId));
      if (msg.senderClientId && msg.senderClientId !== clientId) {
        groupMembers.add(msg.senderClientId);
      }
      const partnerIds = [...groupMembers].sort();
      if (partnerIds.length === 0) {
        continue;
      }

      const names = partnerIds.map((id) => userById.get(id)?.nickname ?? id.slice(0, 6));
      upsert({
        key: threadKey("group", partnerIds),
        audience: "group",
        partnerIds,
        title: `Group: ${names.join(", ")}`,
        subtitle: msg.preview || "Group conversation",
        lastAt: msg.createdAt
      });
    }

    const list = [...map.values()].sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());

    if (!list.some((thread) => thread.key === selectedThreadKey) && chatAudience !== "public") {
      const names = selectedPartnerIds.map((id) => userById.get(id)?.nickname ?? id.slice(0, 8));
      list.unshift({
        key: selectedThreadKey,
        audience: chatAudience,
        partnerIds: selectedPartnerIds,
        title: chatAudience === "private" ? `Private: ${names[0] ?? "Unknown"}` : `Group: ${names.join(", ")}`,
        subtitle: "Draft target",
        lastAt: new Date().toISOString()
      });
    }

    return list;
  }, [messages, clientId, userById, selectedThreadKey, chatAudience, selectedPartnerIds]);

  const sharedFiles = useMemo(() => {
    const items: SharedFileItem[] = [];

    for (const msg of messages) {
      if (msg.content.kind !== "file") {
        continue;
      }

      if (!canAccessFile(msg.content, clientId, msg.senderClientId, msg.recipientClientIds)) {
        continue;
      }

      const direction: "sent" | "received" = msg.senderClientId === clientId ? "sent" : "received";
      let partnerIds: string[] = [];
      let threadTitle = "Broadcast";
      let key = "public";

      if (msg.chatType === "private") {
        const partnerId = msg.senderClientId === clientId ? msg.recipientClientIds[0] : msg.senderClientId;
        if (!partnerId) {
          continue;
        }
        partnerIds = [partnerId];
        key = threadKey("private", partnerIds);
        threadTitle = userById.get(partnerId)?.nickname ?? `Private ${partnerId.slice(0, 8)}`;
      }

      if (msg.chatType === "group") {
        const groupMembers = new Set<string>(msg.recipientClientIds.filter((id) => id !== clientId));
        if (msg.senderClientId && msg.senderClientId !== clientId) {
          groupMembers.add(msg.senderClientId);
        }
        partnerIds = [...groupMembers].sort();
        if (partnerIds.length === 0) {
          continue;
        }
        key = threadKey("group", partnerIds);
        threadTitle = `Group: ${partnerIds.map((id) => userById.get(id)?.nickname ?? id.slice(0, 6)).join(", ")}`;
      }

      items.push({
        messageId: msg.id,
        sender: msg.sender,
        senderClientId: msg.senderClientId,
        createdAt: msg.createdAt,
        audience: msg.chatType,
        partnerIds,
        threadKey: key,
        threadTitle,
        direction,
        file: msg.content.file,
        caption: msg.content.caption
      });
    }

    const filtered = items.filter((item) => {
      if (filesConfig.scope === "current" && item.threadKey !== selectedThreadKey) {
        return false;
      }
      if (item.audience === "public" && !filesConfig.includePublic) {
        return false;
      }
      if (item.audience === "private" && !filesConfig.includePrivate) {
        return false;
      }
      if (item.audience === "group" && !filesConfig.includeGroup) {
        return false;
      }
      if (item.direction === "sent" && !filesConfig.includeSent) {
        return false;
      }
      if (item.direction === "received" && !filesConfig.includeReceived) {
        return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      if (filesConfig.sortBy === "oldest") {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      if (filesConfig.sortBy === "size-desc") {
        return b.file.size - a.file.size;
      }
      if (filesConfig.sortBy === "size-asc") {
        return a.file.size - b.file.size;
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return filtered.slice(0, Math.max(1, filesConfig.limit));
  }, [messages, clientId, userById, filesConfig, selectedThreadKey]);

  const sidebarCount = activeSidebarSection === "files" ? sharedFiles.length : visibleUsers.length;
  const sidebarTitle = activeSidebarSection === "files" ? "Shared Files" : "Active Contacts";

  const groupAdminTargets = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const thread of conversationThreads) {
      if (thread.audience !== "group" || thread.partnerIds.length === 0) {
        continue;
      }
      map.set(groupKeyForMembers(clientId, thread.partnerIds), thread.partnerIds);
    }
    return [...map.entries()].map(([key, partnerIds]) => ({ key, partnerIds }));
  }, [conversationThreads, clientId]);

  async function decryptMessageForState(message: EncryptedMessage, key: RoomKey | null): Promise<DecryptedMessage | null> {
    try {
      const plaintext = await decryptMessage(message.ciphertext, message.nonce, key);
      const content = decodeMessageContent(plaintext);
      return {
        id: message.id,
        sender: message.sender,
        senderClientId: message.senderClientId ?? "",
        chatType: message.chatType ?? "public",
        groupKey: message.groupKey ?? "",
        recipientClientIds: message.recipientClientIds ?? [],
        content,
        preview: messagePreview(content),
        createdAt: message.createdAt
      };
    } catch {
      return null;
    }
  }

  async function decryptAndAddMessage(message: EncryptedMessage, key: RoomKey | null) {
    const nextMessage = await decryptMessageForState(message, key);
    if (!nextMessage) {
      return;
    }

      setMessages((prev) => {
        if (prev.some((item) => item.id === nextMessage.id)) {
          return prev;
        }
        return [...prev, nextMessage];
      });
  }

  async function connectNode(event: FormEvent) {
    event.preventDefault();
    await connectWithSession(storedClientId);
  }

  async function connectWithSession(preferredClientId: string) {
    if (isConnecting || isConnected || nickname.trim().length < 2) {
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      setStatus("Initializing secure session...");
      const keys = await generateOperatorKeys();

      setStatus(keys.insecure ? "Initializing compatibility mode..." : "Applying RSA/AES handshake...");
      const response = await exchangeKey(nickname.trim(), keys.publicKeyPem, preferredClientId || undefined);
      const useInsecureMode = keys.insecure || response.algorithm.toLowerCase().includes("plaintext");
      const importedRoomKey = useInsecureMode ? null : await decryptRoomKey(response.encryptedRoomKey, keys.privateKey);
      const engine: CryptoEngine = useInsecureMode ? "Fallback" : importedRoomKey instanceof Uint8Array ? "Forge" : "WebCrypto";

      setRoomKey(importedRoomKey);
      setCryptoMode(useInsecureMode ? "insecure" : "secure");
      setCryptoEngine(engine);
      setClientId(response.clientId);
      setStoredClientId(response.clientId);
      localStorage.setItem(SESSION_CLIENT_ID_KEY, response.clientId);
      setNickname(response.nickname);

      setStatus("Syncing encrypted history...");
      const history = await loadMessages(response.clientId);
      const decryptedHistory = await Promise.all(history.map((msg) => decryptMessageForState(msg, importedRoomKey)));
      setMessages((prev) => {
        const byID = new Map<number, DecryptedMessage>();
        for (const item of prev) {
          byID.set(item.id, item);
        }
        for (const item of decryptedHistory) {
          if (!item) {
            continue;
          }
          byID.set(item.id, item);
        }
        return [...byID.values()].sort((a, b) => a.id - b.id);
      });

      setStatus("Opening realtime channel...");
      const ws = openMessageSocket(response.clientId, (message) => {
        void decryptAndAddMessage(message, importedRoomKey);
      });
      socketRef.current = ws;

      ws.onopen = () => setStatus(useInsecureMode ? "Online - compatibility mode" : `Online - secure mode (${engine})`);
      ws.onclose = () => setStatus("Disconnected");
      ws.onerror = () => setStatus("Socket error");

      setIsConnected(true);

      const foundUsers = await findUsers("", response.clientId);
      setUsers(foundUsers.filter((user) => user.online));
    } catch (connectError) {
      const message = connectError instanceof Error ? connectError.message : "Connection failed";
      setError(message);
      setStatus(backendReady ? "Ready" : "Offline");
      setIsConnected(false);

      if (preferredClientId) {
        setStoredClientId("");
        localStorage.removeItem(SESSION_CLIENT_ID_KEY);
      }
    } finally {
      setIsConnecting(false);
    }
  }

  useEffect(() => {
    if (autoConnectAttemptedRef.current) {
      return;
    }
    if (!backendReady || !storedClientId || isConnected || isConnecting || nickname.trim().length < 2) {
      return;
    }

    autoConnectAttemptedRef.current = true;
    void connectWithSession(storedClientId);
  }, [backendReady, storedClientId, isConnected, isConnecting, nickname]);

  async function handleSend(event: FormEvent) {
    event.preventDefault();
    const trimmedDraft = draft.trim();
    if (!nickname.trim() || (!trimmedDraft && !pendingFile)) {
      return;
    }

    try {
      let plaintext = trimmedDraft;
      if (pendingFile) {
        const impliedGroupMembers = uniqueIds([clientId, ...selectedPartnerIds]);
        const aclUsers =
          fileAccessMode === "users"
            ? uniqueIds([clientId, ...fileAllowedClientIds])
            : fileAccessMode === "group"
              ? impliedGroupMembers
              : [];
        plaintext = encodeFilePayload(pendingFile, trimmedDraft, fileAccessMode, aclUsers);
      }
      const payload = await encryptMessage(plaintext, roomKey);
      await postEncryptedMessage(
        nickname.trim(),
        clientId,
        payload.ciphertext,
        payload.nonce,
        chatAudience,
        selectedPartnerIds
      );
      setDraft("");
      setPendingFile(null);
      setFileAccessMode(FILE_ACCESS_DEFAULT);
      setFileAllowedClientIds([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : "Send failed";
      setError(message);
    }
  }

  async function processPickedFile(file: File) {
    if (file.size <= 0) {
      setError("Selected file is empty");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(`File exceeds ${formatFileSize(MAX_FILE_BYTES)} limit`);
      return;
    }

    try {
      const nextPending = await buildPendingFile(file);
      setPendingFile(nextPending);
      setError(null);
    } catch {
      setError("Failed to process selected file");
    }
  }

  async function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    await processPickedFile(file);
  }

  function clearPendingFile() {
    setPendingFile(null);
    setFileAccessMode(FILE_ACCESS_DEFAULT);
    setFileAllowedClientIds([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function openFileThread(item: SharedFileItem) {
    setChatAudience(item.audience);
    setSelectedPartnerIds(item.partnerIds);
    setActiveSidebarSection("contacts");
    if (isMobileLayout) {
      setSidebarCollapsed(true);
    }
  }

  function downloadFile(content: Extract<MessageContent, { kind: "file" }>) {
    const bytes = base64ToBytes(content.file.data);
    const blob = new Blob([toArrayBuffer(bytes)], { type: content.file.mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = content.file.name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  async function removePrivateMessages(partnerId: string) {
    await clearPrivateChat(clientId, partnerId);
    setMessages((prev) =>
      prev.filter((msg) => {
        if (msg.chatType !== "private") {
          return true;
        }
        const incoming = msg.senderClientId === partnerId && msg.recipientClientIds.includes(clientId);
        const outgoing = msg.senderClientId === clientId && msg.recipientClientIds.includes(partnerId);
        return !(incoming || outgoing);
      })
    );
  }

  async function handleClearPrivateChat() {
    const partnerId = selectedPartnerIds[0];
    if (chatAudience !== "private" || !partnerId || !clientId) {
      return;
    }

    const partnerName = users.find((user) => user.clientId === partnerId)?.nickname ?? partnerId.slice(0, 8);
    const ok = window.confirm(`Private chat with ${partnerName} will be cleared. Continue?`);
    if (!ok) {
      return;
    }

    try {
      await removePrivateMessages(partnerId);
    } catch (clearError) {
      const message = clearError instanceof Error ? clearError.message : "Failed to clear private chat";
      setError(message);
    }
  }

  async function handleDeletePrivateChat() {
    const partnerId = selectedPartnerIds[0];
    if (chatAudience !== "private" || !partnerId || !clientId) {
      return;
    }

    const partnerName = users.find((user) => user.clientId === partnerId)?.nickname ?? partnerId.slice(0, 8);
    const ok = window.confirm(`Private chat with ${partnerName} will be deleted and closed. Continue?`);
    if (!ok) {
      return;
    }

    try {
      await removePrivateMessages(partnerId);
      setChatAudience("public");
      setSelectedPartnerIds([]);
      setDraft("");
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : "Failed to delete private chat";
      setError(message);
    }
  }

  useEffect(() => {
    if (!isConnected || !clientId || groupAdminTargets.length === 0) {
      return;
    }

    let cancelled = false;
    const refreshGroupAdmins = async () => {
      for (const target of groupAdminTargets) {
        try {
          const adminId = await getGroupAdmin(clientId, target.partnerIds);
          if (!cancelled) {
            setGroupAdminByKey((prev) => {
              if (prev[target.key] === adminId) {
                return prev;
              }
              return { ...prev, [target.key]: adminId };
            });
          }
        } catch {
          // Keep current state; next sync tick retries.
        }
      }
    };

    void refreshGroupAdmins();
    const timer = window.setInterval(() => {
      void refreshGroupAdmins();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isConnected, clientId, groupAdminTargets]);

  async function handleChangeGroupAdmin(nextAdminId: string) {
    if (chatAudience !== "group" || !clientId || selectedPartnerIds.length === 0) {
      return;
    }
    try {
      const adminId = await setGroupAdmin(clientId, selectedPartnerIds, nextAdminId);
      if (currentGroupKey) {
        setGroupAdminByKey((prev) => ({ ...prev, [currentGroupKey]: adminId }));
      }
    } catch (setAdminError) {
      const message = setAdminError instanceof Error ? setAdminError.message : "Failed to set group admin";
      setError(message);
    }
  }

  async function handleClearGroupChat() {
    if (chatAudience !== "group" || !clientId || selectedPartnerIds.length === 0) {
      return;
    }
    const ok = window.confirm("Group chat will be cleared. Continue?");
    if (!ok) {
      return;
    }

    try {
      await clearGroupChat(clientId, selectedPartnerIds);
      if (!currentGroupKey) {
        return;
      }
      setMessages((prev) => prev.filter((msg) => !(msg.chatType === "group" && msg.groupKey === currentGroupKey)));
    } catch (clearError) {
      const message = clearError instanceof Error ? clearError.message : "Failed to clear group chat";
      setError(message);
    }
  }

  async function handleChangeBroadcastAdmin(nextAdminId: string) {
    if (chatAudience !== "public" || !clientId) {
      return;
    }
    if (isBroadcastAdminLoading) {
      return;
    }

    try {
      const adminId = await setBroadcastAdmin(clientId, nextAdminId);
      setBroadcastAdminId(adminId);
    } catch (setAdminError) {
      const message = setAdminError instanceof Error ? setAdminError.message : "Failed to set broadcast admin";
      setError(message);
      try {
        const currentAdminId = await getBroadcastAdmin(clientId);
        setBroadcastAdminId(currentAdminId);
      } catch {
        // Keep current UI state if refresh fails.
      }
    }
  }

  async function handleClearBroadcastChat() {
    if (chatAudience !== "public" || !clientId) {
      return;
    }
    const ok = window.confirm("Broadcast chat will be cleared. Continue?");
    if (!ok) {
      return;
    }

    try {
      await clearBroadcastChat(clientId);
      setMessages((prev) => prev.filter((msg) => msg.chatType !== "public"));
    } catch (clearError) {
      const message = clearError instanceof Error ? clearError.message : "Failed to clear broadcast chat";
      setError(message);
    }
  }

  async function handleDeleteBroadcastChat() {
    if (chatAudience !== "public" || !clientId) {
      return;
    }
    const ok = window.confirm("Broadcast chat will be deleted. Continue?");
    if (!ok) {
      return;
    }

    try {
      await deleteBroadcastChat(clientId);
      setMessages((prev) => prev.filter((msg) => msg.chatType !== "public"));
      setBroadcastAdminId("");
      const adminId = await getBroadcastAdmin(clientId);
      setBroadcastAdminId(adminId);
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : "Failed to delete broadcast chat";
      setError(message);
    }
  }

  async function handleDeleteGroupChat() {
    if (chatAudience !== "group" || !clientId || selectedPartnerIds.length === 0) {
      return;
    }
    const ok = window.confirm("Group chat will be deleted and closed. Continue?");
    if (!ok) {
      return;
    }

    try {
      await deleteGroupChat(clientId, selectedPartnerIds);
      if (currentGroupKey) {
        setMessages((prev) => prev.filter((msg) => !(msg.chatType === "group" && msg.groupKey === currentGroupKey)));
        setGroupAdminByKey((prev) => {
          const clone = { ...prev };
          delete clone[currentGroupKey];
          return clone;
        });
      }
      setChatAudience("public");
      setSelectedPartnerIds([]);
      setDraft("");
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : "Failed to delete group chat";
      setError(message);
    }
  }

  function handleLogout() {
    socketRef.current?.close();
    socketRef.current = null;
    setIsConnected(false);
    setIsConnecting(false);
    setClientId("");
    setRoomKey(null);
    setCryptoMode("secure");
    setCryptoEngine("WebCrypto");
    setMessages([]);
    setUsers([]);
    setDraft("");
    setPendingFile(null);
    setFileAccessMode(FILE_ACCESS_DEFAULT);
    setFileAllowedClientIds([]);
    setPartnerFilter("");
    setActiveSidebarSection("contacts");
    setShowFilesConfig(false);
    setChatAudience("public");
    setSelectedPartnerIds([]);
    setStoredClientId("");
    localStorage.removeItem(SESSION_CLIENT_ID_KEY);
    setSidebarCollapsed(false);
    setError(null);
    setStatus(backendReady ? "Ready" : "Offline");
  }

  function openPrivateContact(userId: string) {
    setChatAudience("private");
    setSelectedPartnerIds([userId]);
    setIsPartnerSearchFocused(false);
  }

  if (!isConnected) {
    return (
      <main className="corp-shell">
        <section className="auth-card">
          <div className="brand-block">
            <img className="brand-logo" src="/logo.svg" alt="NCHAT logo" />
            <div className="brand-wordmark-wrap">
              <p className="nchat-wordmark" aria-label="NCHAT">
                <span className="nchat-wordmark-accent">N</span>CHAT
              </p>
              <span className="nchat-wordmark-line" aria-hidden="true" />
            </div>
          </div>
          <h1>Secure Team Messaging</h1>
          <p className="copy">Sign in with your username. Encryption and peer discovery start automatically after login.</p>

          <form className="auth-form" onSubmit={connectNode}>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder="Enter username"
              maxLength={32}
              disabled={isConnecting}
            />
            <button type="submit" disabled={isConnecting || nickname.trim().length < 2}>
              {isConnecting ? "Starting secure chat..." : "Start Chat"}
            </button>
            {!backendReady && !isConnecting ? (
              <p className="muted">Backend currently not reachable. Start Chat will still try to connect.</p>
            ) : null}
          </form>

          <div className="auth-meta">
            <span>Status: {status}</span>
            <button type="button" className="theme-btn" onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}>
              Theme: {theme === "dark" ? "Dark" : "Light"}
            </button>
          </div>

          {error ? <p className="error-text">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="corp-shell">
      <section className="workspace">
        {isMobileLayout && !sidebarCollapsed ? (
          <button
            type="button"
            aria-label="Close partner panel"
            className="drawer-backdrop"
            onClick={() => setSidebarCollapsed(true)}
          />
        ) : null}

        <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <div className="sidebar-head">
            <div className="sidebar-title-row">
              <h2>{sidebarTitle}</h2>
              <span className="count-badge">{sidebarCount}</span>
            </div>
            <button
              type="button"
              className="sidebar-toggle-btn"
              aria-label={sidebarCollapsed ? "Open partner panel" : "Hide partner panel"}
              onClick={() => setSidebarCollapsed((prev) => !prev)}
            >
              {sidebarCollapsed ? "\u25B8" : "\u25C2"}
            </button>
          </div>

          <div className={`sidebar-plugin-strip ${sidebarCollapsed && !isMobileLayout ? "rail" : "inline"}`}>
            <button
              type="button"
              className={`sidebar-rail-btn ${activeSidebarSection === "contacts" ? "active" : ""}`}
              title="Contacts"
              aria-label="Contacts"
              onClick={() => {
                setActiveSidebarSection("contacts");
                setSidebarCollapsed(false);
              }}
            >
              {sidebarCollapsed && !isMobileLayout ? "CN" : "Contacts"}
            </button>
            {sidebarPlugins.map((plugin) => (
              <button
                key={plugin.id}
                type="button"
                className={`plugin-rail-btn ${plugin.id === "files" && activeSidebarSection === "files" ? "active" : ""}`}
                title={plugin.id === "files" ? "Shared Files" : `${plugin.label} plugin (coming soon)`}
                aria-label={plugin.id === "files" ? "Shared Files" : `${plugin.label} plugin (coming soon)`}
                disabled={plugin.id !== "files"}
                onClick={() => {
                  if (plugin.id === "files") {
                    setActiveSidebarSection("files");
                    setSidebarCollapsed(false);
                  }
                }}
              >
                <span>{plugin.short}</span>
                {!sidebarCollapsed || isMobileLayout ? (
                  <em>
                    {plugin.label}
                    {plugin.id === "files" ? <small className="plugin-count">{sharedFiles.length}</small> : null}
                  </em>
                ) : null}
              </button>
            ))}
          </div>

          {!sidebarCollapsed ? (
            <>
              {activeSidebarSection === "contacts" ? (
                <>
                  <div className="partner-search-wrap">
                    <input
                      type="search"
                      className="partner-search"
                      value={partnerFilter}
                      onChange={(event) => setPartnerFilter(event.target.value)}
                      onFocus={() => setIsPartnerSearchFocused(true)}
                      onBlur={() => {
                        window.setTimeout(() => setIsPartnerSearchFocused(false), 120);
                      }}
                      placeholder="Search contacts"
                      autoComplete="off"
                    />
                    {showContactSuggestions ? (
                      <div className="partner-suggestions" role="listbox" aria-label="Contact suggestions">
                        {contactSuggestions.map((user) => (
                          <button
                            key={user.clientId}
                            type="button"
                            className="partner-suggestion-btn"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              openPrivateContact(user.clientId);
                            }}
                          >
                            <strong>{user.nickname}</strong>
                            <span>ID {user.clientId.slice(0, 8)}...</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="partner-list">
                    <p className="sidebar-section-title">Recent Chats</p>
                    <div className="thread-list">
                      {conversationThreads.map((thread) => {
                        const threadGroupKey = thread.audience === "group" ? groupKeyForMembers(clientId, thread.partnerIds) : "";
                        const threadAdminId = threadGroupKey ? groupAdminByKey[threadGroupKey] ?? "" : "";
                        const isThreadAdminMe = !!threadAdminId && threadAdminId === clientId;
                        const isBroadcastThread = thread.audience === "public";
                        const isBroadcastAdminMe = !!broadcastAdminId && broadcastAdminId === clientId;

                        return (
                        <button
                          key={thread.key}
                          type="button"
                          className={`thread-card ${thread.key === selectedThreadKey ? "active" : ""}`}
                          onClick={() => {
                            setChatAudience(thread.audience);
                            setSelectedPartnerIds(thread.partnerIds);
                          }}
                        >
                          <strong>
                            {thread.title}
                            {isBroadcastThread && broadcastAdminId ? (
                              <span className={`admin-badge ${isBroadcastAdminMe ? "self" : ""}`}>{isBroadcastAdminMe ? "Admin" : "Managed"}</span>
                            ) : null}
                            {thread.audience === "group" && threadAdminId ? (
                              <span className={`admin-badge ${isThreadAdminMe ? "self" : ""}`}>{isThreadAdminMe ? "Admin" : "Managed"}</span>
                            ) : null}
                          </strong>
                          <span>{thread.subtitle}</span>
                        </button>
                        );
                      })}
                    </div>

                    <p className="sidebar-section-title">Contacts</p>
                    {visibleUsers.length === 0 ? <p className="muted">No active contacts</p> : null}
                    {visibleUsers.map((user) => (
                      <article
                        key={user.clientId}
                        className={`partner-card ${selectedPartnerIds.includes(user.clientId) ? "selected" : ""}`}
                        onClick={() => {
                          if (chatAudience === "public") {
                            setChatAudience("private");
                            setSelectedPartnerIds([user.clientId]);
                            return;
                          }
                          if (chatAudience === "private") {
                            setSelectedPartnerIds([user.clientId]);
                            return;
                          }
                          setSelectedPartnerIds((prev) =>
                            prev.includes(user.clientId) ? prev.filter((id) => id !== user.clientId) : [...prev, user.clientId]
                          );
                        }}
                      >
                        <div className="partner-row">
                          <strong>{user.nickname}</strong>
                          <span className="online-dot" aria-hidden="true" />
                        </div>
                        <span>ID {user.clientId.slice(0, 8)}...</span>
                      </article>
                    ))}
                  </div>
                </>
              ) : (
                <div className="files-panel">
                  <div className="files-panel-head">
                    <p className="sidebar-section-title">Central File Vault</p>
                    <button type="button" className="theme-btn files-config-btn" onClick={() => setShowFilesConfig((prev) => !prev)}>
                      {showFilesConfig ? "Hide Config" : "Config"}
                    </button>
                  </div>

                  {showFilesConfig ? (
                    <section className="files-config" aria-label="Files configuration">
                      <label>
                        Scope
                        <select
                          value={filesConfig.scope}
                          onChange={(event) => setFilesConfig((prev) => ({ ...prev, scope: event.target.value as FileLibraryConfig["scope"] }))}
                        >
                          <option value="all">All chats</option>
                          <option value="current">Current chat only</option>
                        </select>
                      </label>
                      <label>
                        Sort
                        <select
                          value={filesConfig.sortBy}
                          onChange={(event) => setFilesConfig((prev) => ({ ...prev, sortBy: event.target.value as FileLibraryConfig["sortBy"] }))}
                        >
                          <option value="newest">Newest first</option>
                          <option value="oldest">Oldest first</option>
                          <option value="size-desc">Largest first</option>
                          <option value="size-asc">Smallest first</option>
                        </select>
                      </label>
                      <label>
                        Max entries
                        <input
                          type="number"
                          min={10}
                          max={500}
                          value={filesConfig.limit}
                          onChange={(event) =>
                            setFilesConfig((prev) => ({
                              ...prev,
                              limit: Math.min(500, Math.max(10, Number(event.target.value) || 10))
                            }))
                          }
                        />
                      </label>
                      <div className="files-config-grid">
                        <label>
                          <input
                            type="checkbox"
                            checked={filesConfig.includeSent}
                            onChange={(event) => setFilesConfig((prev) => ({ ...prev, includeSent: event.target.checked }))}
                          />
                          Sent
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={filesConfig.includeReceived}
                            onChange={(event) => setFilesConfig((prev) => ({ ...prev, includeReceived: event.target.checked }))}
                          />
                          Received
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={filesConfig.includePublic}
                            onChange={(event) => setFilesConfig((prev) => ({ ...prev, includePublic: event.target.checked }))}
                          />
                          Public
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={filesConfig.includePrivate}
                            onChange={(event) => setFilesConfig((prev) => ({ ...prev, includePrivate: event.target.checked }))}
                          />
                          Private
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={filesConfig.includeGroup}
                            onChange={(event) => setFilesConfig((prev) => ({ ...prev, includeGroup: event.target.checked }))}
                          />
                          Group
                        </label>
                      </div>
                    </section>
                  ) : null}

                  {sharedFiles.length === 0 ? <p className="muted">No files matched the current filters.</p> : null}
                  <div className="files-list">
                    {sharedFiles.map((item) => (
                      <article key={item.messageId} className="files-item">
                        <div className="files-item-meta">
                          <strong>{item.file.name}</strong>
                          <span>{formatFileSize(item.file.size)}</span>
                          <span>{item.audience}</span>
                          <span>{item.direction}</span>
                        </div>
                        <p className="files-item-thread">{item.threadTitle}</p>
                        {item.caption ? <p className="files-item-caption">{item.caption}</p> : null}
                        <div className="files-item-actions">
                          <button
                            type="button"
                            className="theme-btn"
                            onClick={() =>
                              downloadFile({
                                kind: "file",
                                file: item.file,
                                caption: item.caption,
                                accessMode: "broadcast",
                                allowedClientIds: []
                              })
                            }
                          >
                            Download
                          </button>
                          <button type="button" className="theme-btn" onClick={() => openFileThread(item)}>
                            Open Chat
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </aside>

        <section className="chat-stage">
          <header className="topbar">
            <div>
              <div className="topbar-brand-row">
                <img className="topbar-logo" src="/logo.svg" alt="NCHAT logo" />
                <p className="nchat-wordmark compact" aria-label="NCHAT">
                  <span className="nchat-wordmark-accent">N</span>CHAT
                </p>
              </div>
              <p className="copy">{status}</p>
              {cryptoMode === "insecure" ? <p className="muted">Compatibility mode: messaging is available, end-to-end encryption is disabled on this device.</p> : null}
            </div>
            <div className="topbar-actions">
              <button type="button" className="theme-btn" onClick={() => setSidebarCollapsed((prev) => !prev)}>
                {sidebarCollapsed ? "Show Contacts" : "Hide Contacts"}
              </button>
              <span className={`security-pill ${cryptoMode === "secure" ? "secure" : "insecure"}`}>
                {cryptoMode === "secure" ? "Secure" : "Compatibility"}
              </span>
              <span className="chip">E2E: {cryptoEngine}</span>
              <span className="chip">{nickname}</span>
              <span className="chip">{clientId.slice(0, 8)}...</span>
              <button type="button" className="theme-btn" onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}>
                {theme === "dark" ? "Light Mode" : "Dark Mode"}
              </button>
              <button type="button" className="logout-btn" onClick={handleLogout}>
                Logout
              </button>
            </div>
          </header>

          {isMobileLayout ? <p className="muted mobile-note">Contacts and shared files are available via the sidebar button.</p> : null}

          <section className="chat-feed">
            <div className="audience-bar">
              <label>
                Mode
                <select
                  value={chatAudience}
                  onChange={(event) => {
                    const mode = event.target.value as ChatAudience;
                    setChatAudience(mode);
                    setSelectedPartnerIds((prev) => {
                      if (mode === "public") {
                        return [];
                      }
                      if (mode === "private") {
                        return prev.slice(0, 1);
                      }
                      return prev;
                    });
                  }}
                >
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                  <option value="group">Group</option>
                </select>
              </label>
              <div className="audience-targets">
                {chatAudience === "public" ? <span className="audience-chip">All partners</span> : null}
                {selectedPartnerIds.map((id) => {
                  const user = users.find((item) => item.clientId === id);
                  return (
                    <span key={id} className="audience-chip">
                      {user?.nickname ?? id.slice(0, 8)}
                    </span>
                  );
                })}
              </div>
              {chatAudience === "public" ? (
                <div className="group-admin-panel">
                  <span className={`admin-badge ${broadcastAdminId === clientId ? "self" : ""}`}>
                    Admin: {broadcastAdminLabel}
                  </span>
                  <button
                    type="button"
                    className="theme-btn admin-settings-toggle"
                    onClick={() => setShowBroadcastAdminSettings((prev) => !prev)}
                  >
                    {showBroadcastAdminSettings ? "Hide Admin Settings" : "Admin Settings"}
                  </button>
                  {showBroadcastAdminSettings ? (
                    <div className="group-admin-settings">
                      <label>
                        Assign admin
                        <select
                          value={broadcastAdminId || clientId}
                          onChange={(event) => void handleChangeBroadcastAdmin(event.target.value)}
                          disabled={isBroadcastAdminLoading || (!!broadcastAdminId && !isCurrentUserBroadcastAdmin)}
                        >
                          {broadcastAdminCandidates.map((candidate) => {
                            const user = userById.get(candidate.id);
                            return (
                              <option key={candidate.id} value={candidate.id}>
                                {user?.nickname ?? candidate.label}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                      {isCurrentUserBroadcastAdmin ? (
                        <div className="private-chat-actions">
                          <button type="button" className="danger-ghost-btn" onClick={() => void handleClearBroadcastChat()}>
                            Broadcast leeren
                          </button>
                          <button type="button" className="danger-solid-btn" onClick={() => void handleDeleteBroadcastChat()}>
                            Broadcast loeschen
                          </button>
                        </div>
                      ) : (
                        <span className="audience-chip">
                          {isBroadcastAdminLoading ? "Broadcast admin is loading..." : "Nur Admin kann Broadcast leeren/loeschen"}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="audience-chip">Admin controls are hidden</span>
                  )}
                </div>
              ) : null}
              {chatAudience === "group" && selectedPartnerIds.length > 0 ? (
                <div className="group-admin-panel">
                  <span className={`admin-badge ${currentGroupAdminId === clientId ? "self" : ""}`}>
                    Admin: {currentGroupAdminLabel}
                  </span>
                  <button type="button" className="theme-btn admin-settings-toggle" onClick={() => setShowGroupAdminSettings((prev) => !prev)}>
                    {showGroupAdminSettings ? "Hide Admin Settings" : "Admin Settings"}
                  </button>
                  {showGroupAdminSettings ? (
                    <div className="group-admin-settings">
                      <label>
                        Assign admin
                        <select
                          value={currentGroupAdminId || clientId}
                          onChange={(event) => void handleChangeGroupAdmin(event.target.value)}
                          disabled={!isCurrentUserGroupAdmin && !!currentGroupAdminId}
                        >
                          {[clientId, ...selectedPartnerIds].map((id) => {
                            const user = users.find((item) => item.clientId === id);
                            return (
                              <option key={id} value={id}>
                                {user?.nickname ?? id.slice(0, 8)}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                      {isCurrentUserGroupAdmin ? (
                        <div className="private-chat-actions">
                          <button type="button" className="danger-ghost-btn" onClick={() => void handleClearGroupChat()}>
                            Group leeren
                          </button>
                          <button type="button" className="danger-solid-btn" onClick={() => void handleDeleteGroupChat()}>
                            Group loeschen
                          </button>
                        </div>
                      ) : (
                        <span className="audience-chip">Nur Admin kann Group leeren/loeschen</span>
                      )}
                    </div>
                  ) : (
                    <span className="audience-chip">Admin controls are hidden</span>
                  )}
                </div>
              ) : null}
              {chatAudience === "private" && selectedPartnerIds.length === 1 ? (
                <div className="private-chat-actions">
                  <button type="button" className="danger-ghost-btn" onClick={() => void handleClearPrivateChat()}>
                    Chat leeren
                  </button>
                  <button type="button" className="danger-solid-btn" onClick={() => void handleDeletePrivateChat()}>
                    Chat loeschen
                  </button>
                </div>
              ) : null}
            </div>

            {filteredMessages.length === 0 ? <p className="muted">No messages for this chat target yet.</p> : null}
            {filteredMessages.map((msg) => (
              <article key={msg.id} className="message-row">
                <div className="message-meta">
                  <strong>{msg.sender}</strong>
                  <time>{new Date(msg.createdAt).toLocaleTimeString()}</time>
                </div>
                {msg.content.kind === "text" ? <p>{msg.content.text}</p> : null}
                {msg.content.kind === "file" ? (
                  <div className="file-card">
                    {canAccessFile(msg.content, clientId, msg.senderClientId, msg.recipientClientIds) ? (
                      <>
                        <div className="file-card-meta">
                          <strong>{msg.content.file.name}</strong>
                          <span>{formatFileSize(msg.content.file.size)}</span>
                          <span>{msg.content.file.mimeType}</span>
                          <span>{msg.content.accessMode}</span>
                        </div>
                        {msg.content.caption ? <p className="file-caption">{msg.content.caption}</p> : null}
                        <button
                          type="button"
                          className="theme-btn file-download-btn"
                          onClick={() => {
                            if (msg.content.kind === "file") {
                              downloadFile(msg.content);
                            }
                          }}
                        >
                          Download File
                        </button>
                      </>
                    ) : (
                      <p className="file-locked">Restricted file: you do not have permission to access this attachment.</p>
                    )}
                  </div>
                ) : null}
              </article>
            ))}
          </section>

          <form
            className="composer"
            onSubmit={handleSend}
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files?.[0];
              if (file) {
                void processPickedFile(file);
              }
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              className="file-input"
              onChange={(event) => void handleFileSelected(event)}
              aria-label="Attach a file"
            />
            {pendingFile ? (
              <div className="pending-file-row" role="status" aria-live="polite">
                <div className="pending-file-meta">
                  <div>
                    <strong>{pendingFile.name}</strong>
                    <span>{formatFileSize(pendingFile.size)}</span>
                  </div>
                  <div className="file-permissions">
                    <label>
                      File access
                      <select
                        value={fileAccessMode}
                        onChange={(event) => setFileAccessMode(event.target.value as FileAccessMode)}
                        disabled={chatAudience === "private" || chatAudience === "group"}
                      >
                        <option value="broadcast">Broadcast (all)</option>
                        <option value="users">Specific users</option>
                        <option value="group">Current group</option>
                      </select>
                    </label>
                    {fileAccessMode === "users" ? (
                      <div className="file-permission-users">
                        {fileAccessCandidates.map((candidate) => (
                          <label key={candidate.id}>
                            <input
                              type="checkbox"
                              checked={candidate.id === clientId || fileAllowedClientIds.includes(candidate.id)}
                              disabled={candidate.id === clientId}
                              onChange={(event) => {
                                setFileAllowedClientIds((prev) => {
                                  if (event.target.checked) {
                                    return uniqueIds([...prev, candidate.id]);
                                  }
                                  return prev.filter((id) => id !== candidate.id);
                                });
                              }}
                            />
                            {candidate.label}
                          </label>
                        ))}
                      </div>
                    ) : null}
                    {fileAccessMode === "group" ? (
                      <p className="muted file-permission-note">Group permissions use current members of this group chat.</p>
                    ) : null}
                  </div>
                </div>
                <button type="button" className="theme-btn" onClick={clearPendingFile}>
                  Remove file
                </button>
              </div>
            ) : (
              <p className="muted file-drop-hint">Drop file here or use Attach</p>
            )}
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (canSend) {
                    void handleSend(event as unknown as FormEvent);
                  }
                }
              }}
              placeholder="Write message"
              rows={2}
            />
            <div className="composer-actions">
              <button type="button" className="theme-btn" onClick={() => fileInputRef.current?.click()}>
                Attach
              </button>
              <button type="submit" disabled={!canSend}>
                {pendingFile ? "Send File" : "Send"}
              </button>
            </div>
          </form>

          {error ? <p className="error-text">{error}</p> : null}
        </section>
      </section>
    </main>
  );
}
