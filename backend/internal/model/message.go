package model

import "time"

type EncryptedMessage struct {
	ID                 int64     `json:"id"`
	Sender             string    `json:"sender"`
	SenderClientID     string    `json:"senderClientId,omitempty"`
	ChatType           string    `json:"chatType,omitempty"`
	GroupKey           string    `json:"groupKey,omitempty"`
	RecipientClientIDs []string  `json:"recipientClientIds,omitempty"`
	Ciphertext         string    `json:"ciphertext"`
	Nonce              string    `json:"nonce"`
	CreatedAt          time.Time `json:"createdAt"`
}

type KeyExchangeRequest struct {
	ClientID  string `json:"clientId,omitempty"`
	Nickname  string `json:"nickname"`
	PublicKey string `json:"publicKey"`
}

type KeyExchangeResponse struct {
	ClientID         string `json:"clientId"`
	Nickname         string `json:"nickname"`
	EncryptedRoomKey string `json:"encryptedRoomKey"`
	Algorithm        string `json:"algorithm"`
}

type PostMessageRequest struct {
	Sender             string   `json:"sender"`
	SenderClientID     string   `json:"senderClientId"`
	ChatType           string   `json:"chatType"`
	RecipientClientIDs []string `json:"recipientClientIds"`
	Ciphertext         string   `json:"ciphertext"`
	Nonce              string   `json:"nonce"`
}

type ChatUser struct {
	ClientID string    `json:"clientId"`
	Nickname string    `json:"nickname"`
	LastSeen time.Time `json:"lastSeen"`
	Online   bool      `json:"online"`
}

type UserSearchResponse struct {
	Users []ChatUser `json:"users"`
}

type PresencePingRequest struct {
	ClientID string `json:"clientId"`
}

type GroupAdminSetRequest struct {
	ActorClientID   string   `json:"actorClientId"`
	MemberClientIDs []string `json:"memberClientIds"`
	AdminClientID   string   `json:"adminClientId"`
}

type GroupAdminGetRequest struct {
	ActorClientID   string   `json:"actorClientId"`
	MemberClientIDs []string `json:"memberClientIds"`
}

type GroupAdminResponse struct {
	GroupKey      string `json:"groupKey"`
	AdminClientID string `json:"adminClientId"`
}

type GroupChatActionRequest struct {
	ActorClientID   string   `json:"actorClientId"`
	MemberClientIDs []string `json:"memberClientIds"`
}

type BroadcastAdminGetRequest struct {
	ActorClientID string `json:"actorClientId"`
}

type BroadcastAdminSetRequest struct {
	ActorClientID string `json:"actorClientId"`
	AdminClientID string `json:"adminClientId"`
}

type BroadcastChatActionRequest struct {
	ActorClientID string `json:"actorClientId"`
}
