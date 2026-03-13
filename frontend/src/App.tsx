import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  plaintext: string;
  createdAt: string;
}

interface ConversationThread {
  key: string;
  audience: ChatAudience;
  partnerIds: string[];
  title: string;
  subtitle: string;
  lastAt: string;
}

type ThemeMode = "dark" | "light";
type CryptoMode = "secure" | "insecure";
type ChatAudience = "public" | "private" | "group";
type CryptoEngine = "WebCrypto" | "Forge" | "Fallback";

const sidebarPlugins = [
  { id: "files", label: "Files", short: "FI" },
  { id: "tasks", label: "Tasks", short: "TA" },
  { id: "tools", label: "Tools", short: "TL" }
];

const SESSION_CLIENT_ID_KEY = "nchat.clientId";

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
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  const [error, setError] = useState<string | null>(null);
  const [storedClientId, setStoredClientId] = useState<string>(() => localStorage.getItem(SESSION_CLIENT_ID_KEY) ?? "");

  const socketRef = useRef<WebSocket | null>(null);
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

  const canSend = useMemo(() => {
    if (!isConnected || draft.trim().length === 0) {
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
    return true;
  }, [isConnected, draft, cryptoMode, roomKey, chatAudience, selectedPartnerIds]);

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
          subtitle: msg.plaintext.slice(0, 42) || "Public updates",
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
          subtitle: msg.plaintext.slice(0, 42) || "Private messages",
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
        subtitle: msg.plaintext.slice(0, 42) || "Group conversation",
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

  async function decryptAndAddMessage(message: EncryptedMessage, key: RoomKey | null) {
    try {
      const plaintext = await decryptMessage(message.ciphertext, message.nonce, key);
      setMessages((prev) => {
        if (prev.some((item) => item.id === message.id)) {
          return prev;
        }
        return [
          ...prev,
          {
            id: message.id,
            sender: message.sender,
            senderClientId: message.senderClientId ?? "",
            chatType: message.chatType ?? "public",
            groupKey: message.groupKey ?? "",
            recipientClientIds: message.recipientClientIds ?? [],
            plaintext,
            createdAt: message.createdAt
          }
        ];
      });
    } catch {
      // Ignore payloads that cannot be decrypted with current session key.
    }
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
      const history = await loadMessages();
      for (const msg of history) {
        await decryptAndAddMessage(msg, importedRoomKey);
      }

      setStatus("Opening realtime channel...");
      const ws = openMessageSocket((message) => {
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
    if (!nickname.trim() || !draft.trim()) {
      return;
    }

    try {
      const payload = await encryptMessage(draft.trim(), roomKey);
      await postEncryptedMessage(
        nickname.trim(),
        clientId,
        payload.ciphertext,
        payload.nonce,
        chatAudience,
        selectedPartnerIds
      );
      setDraft("");
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : "Send failed";
      setError(message);
    }
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
    setPartnerFilter("");
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
              <h2>Active Contacts</h2>
              <span className="count-badge">{visibleUsers.length}</span>
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
              className="sidebar-rail-btn active"
              title="Contacts"
              aria-label="Contacts"
              onClick={() => setSidebarCollapsed(false)}
            >
              {sidebarCollapsed && !isMobileLayout ? "CN" : "Contacts"}
            </button>
            {sidebarPlugins.map((plugin) => (
              <button
                key={plugin.id}
                type="button"
                className="plugin-rail-btn"
                title={`${plugin.label} plugin (coming soon)`}
                aria-label={`${plugin.label} plugin (coming soon)`}
              >
                <span>{plugin.short}</span>
                {!sidebarCollapsed || isMobileLayout ? <em>{plugin.label}</em> : null}
              </button>
            ))}
          </div>

          {!sidebarCollapsed ? (
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
              <h1>Corporate Secure Chat</h1>
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

          {isMobileLayout ? <p className="muted mobile-note">Contact list is available via the Show Contacts button.</p> : null}

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
                <p>{msg.plaintext}</p>
              </article>
            ))}
          </section>

          <form className="composer" onSubmit={handleSend}>
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
            <button type="submit" disabled={!canSend}>
              Send
            </button>
          </form>

          {error ? <p className="error-text">{error}</p> : null}
        </section>
      </section>
    </main>
  );
}
