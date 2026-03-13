export interface EncryptedMessage {
  id: number;
  sender: string;
  senderClientId?: string;
  chatType?: "public" | "private" | "group";
  groupKey?: string;
  recipientClientIds?: string[];
  ciphertext: string;
  nonce: string;
  createdAt: string;
}

export interface KeyExchangeResponse {
  clientId: string;
  nickname: string;
  encryptedRoomKey: string;
  algorithm: string;
}

export interface ChatUser {
  clientId: string;
  nickname: string;
  lastSeen: string;
  online: boolean;
}
