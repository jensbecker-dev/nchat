package service

import (
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/youruser/nchat/backend/internal/crypto"
	"github.com/youruser/nchat/backend/internal/model"
	"github.com/youruser/nchat/backend/internal/store"
)

type ChatService struct {
	store   *store.SQLiteStore
	roomKey []byte
	mu      sync.Mutex
	broker  *Broker
	users   map[string]model.ChatUser
}

const activeUserTTL = 45 * time.Second
const broadcastAdminKey = "broadcast:global"

func NewChatService(store *store.SQLiteStore) *ChatService {
	return &ChatService{
		store:  store,
		broker: NewBroker(),
		users:  make(map[string]model.ChatUser),
	}
}

func (s *ChatService) ExchangeKey(nickname, publicKeyPEM, preferredClientID string) (model.KeyExchangeResponse, error) {
	publicKeyPEM = strings.TrimSpace(publicKeyPEM)

	encryptedKey := ""
	algorithm := "PLAINTEXT-INSECURE"
	if publicKeyPEM != "PLAINTEXT-INSECURE" {
		roomKey, err := s.getOrCreateRoomKey()
		if err != nil {
			return model.KeyExchangeResponse{}, err
		}

		encrypted, err := crypto.EncryptRoomKeyWithRSAPublicPEM(publicKeyPEM, roomKey)
		if err == nil {
			encryptedKey = encrypted
			algorithm = "RSA-OAEP-SHA256 + AES-256-GCM"
		}
	}

	clientID := strings.TrimSpace(preferredClientID)
	if clientID == "" {
		clientID = uuid.NewString()
	}

	nickname = strings.TrimSpace(nickname)
	if nickname == "" {
		nickname = "operator-" + clientID[:8]
	}

	s.mu.Lock()
	if existing, ok := s.users[clientID]; ok {
		if nickname == "" {
			nickname = existing.Nickname
		}
	}
	s.users[clientID] = model.ChatUser{
		ClientID: clientID,
		Nickname: nickname,
		LastSeen: time.Now().UTC(),
		Online:   false,
	}
	s.mu.Unlock()

	return model.KeyExchangeResponse{
		ClientID:         clientID,
		Nickname:         nickname,
		EncryptedRoomKey: encryptedKey,
		Algorithm:        algorithm,
	}, nil
}

func (s *ChatService) PostMessage(req model.PostMessageRequest) (model.EncryptedMessage, error) {
	senderClientID := strings.TrimSpace(req.SenderClientID)
	if senderClientID == "" {
		return model.EncryptedMessage{}, errors.New("senderClientId is required")
	}

	s.mu.Lock()
	senderUser, ok := s.users[senderClientID]
	if ok {
		senderUser.LastSeen = time.Now().UTC()
		senderUser.Online = true
		s.users[senderClientID] = senderUser
	}
	s.mu.Unlock()

	if !ok {
		return model.EncryptedMessage{}, errors.New("invalid session id")
	}

	chatType := strings.ToLower(strings.TrimSpace(req.ChatType))
	if chatType == "" {
		chatType = "public"
	}
	if chatType != "public" && chatType != "private" && chatType != "group" {
		return model.EncryptedMessage{}, errors.New("chatType must be public, private or group")
	}
	if (chatType == "private" || chatType == "group") && len(req.RecipientClientIDs) == 0 {
		return model.EncryptedMessage{}, errors.New("recipientClientIds are required for private or group chat")
	}

	recipients := make([]string, 0, len(req.RecipientClientIDs))
	seen := make(map[string]struct{}, len(req.RecipientClientIDs))
	for _, recipient := range req.RecipientClientIDs {
		id := strings.TrimSpace(recipient)
		if id == "" {
			continue
		}
		if id == senderClientID {
			return model.EncryptedMessage{}, errors.New("cannot send message to your own session")
		}
		if _, ok := seen[id]; ok {
			continue
		}

		s.mu.Lock()
		_, recipientExists := s.users[id]
		s.mu.Unlock()
		if !recipientExists {
			return model.EncryptedMessage{}, errors.New("recipient session not found")
		}

		seen[id] = struct{}{}
		recipients = append(recipients, id)
	}
	if chatType == "private" && len(recipients) != 1 {
		return model.EncryptedMessage{}, errors.New("private chat requires exactly one recipientClientId")
	}

	groupKey := ""
	if chatType == "group" {
		groupKey = s.buildGroupKey(senderClientID, recipients)
	}

	stored, err := s.store.SaveMessage(model.EncryptedMessage{
		Sender:             senderUser.Nickname,
		SenderClientID:     senderClientID,
		ChatType:           chatType,
		GroupKey:           groupKey,
		RecipientClientIDs: recipients,
		Ciphertext:         req.Ciphertext,
		Nonce:              req.Nonce,
	})
	if err != nil {
		return model.EncryptedMessage{}, err
	}

	s.broker.Broadcast(stored)
	return stored, nil
}

func (s *ChatService) ListMessages(limit int) ([]model.EncryptedMessage, error) {
	return s.store.ListMessages(limit)
}

func (s *ChatService) ClearPrivateChat(selfClientID, partnerClientID string) (int64, error) {
	selfClientID = strings.TrimSpace(selfClientID)
	partnerClientID = strings.TrimSpace(partnerClientID)
	if selfClientID == "" || partnerClientID == "" {
		return 0, errors.New("selfClientId and partnerClientId are required")
	}
	if selfClientID == partnerClientID {
		return 0, errors.New("selfClientId and partnerClientId must be different")
	}

	return s.store.DeletePrivateConversation(selfClientID, partnerClientID)
}

func (s *ChatService) GetGroupAdmin(actorClientID string, memberClientIDs []string) (model.GroupAdminResponse, error) {
	groupKey, members, err := s.groupContext(actorClientID, memberClientIDs)
	if err != nil {
		return model.GroupAdminResponse{}, err
	}

	adminID, err := s.store.GetGroupAdmin(groupKey)
	if err != nil {
		return model.GroupAdminResponse{}, err
	}
	if adminID == "" {
		adminID = actorClientID
		if err := s.store.SetGroupAdmin(groupKey, adminID); err != nil {
			return model.GroupAdminResponse{}, err
		}
	}

	if !containsID(members, adminID) {
		adminID = actorClientID
		if err := s.store.SetGroupAdmin(groupKey, adminID); err != nil {
			return model.GroupAdminResponse{}, err
		}
	}

	return model.GroupAdminResponse{GroupKey: groupKey, AdminClientID: adminID}, nil
}

func (s *ChatService) SetGroupAdmin(actorClientID string, memberClientIDs []string, adminClientID string) (model.GroupAdminResponse, error) {
	groupKey, members, err := s.groupContext(actorClientID, memberClientIDs)
	if err != nil {
		return model.GroupAdminResponse{}, err
	}

	adminClientID = strings.TrimSpace(adminClientID)
	if adminClientID == "" {
		return model.GroupAdminResponse{}, errors.New("adminClientId is required")
	}
	if !containsID(members, adminClientID) {
		return model.GroupAdminResponse{}, errors.New("adminClientId must be a group member")
	}

	currentAdminID, err := s.store.GetGroupAdmin(groupKey)
	if err != nil {
		return model.GroupAdminResponse{}, err
	}
	if currentAdminID != "" && currentAdminID != actorClientID {
		return model.GroupAdminResponse{}, errors.New("only current admin can change group admin")
	}

	if err := s.store.SetGroupAdmin(groupKey, adminClientID); err != nil {
		return model.GroupAdminResponse{}, err
	}

	return model.GroupAdminResponse{GroupKey: groupKey, AdminClientID: adminClientID}, nil
}

func (s *ChatService) ClearGroupChat(actorClientID string, memberClientIDs []string, deleteChat bool) (int64, error) {
	groupKey, _, err := s.groupContext(actorClientID, memberClientIDs)
	if err != nil {
		return 0, err
	}

	adminID, err := s.store.GetGroupAdmin(groupKey)
	if err != nil {
		return 0, err
	}
	if adminID == "" {
		adminID = actorClientID
		if err := s.store.SetGroupAdmin(groupKey, adminID); err != nil {
			return 0, err
		}
	}
	if adminID != actorClientID {
		return 0, errors.New("only group admin can clear or delete this group chat")
	}

	deleted, err := s.store.DeleteGroupConversation(groupKey)
	if err != nil {
		return 0, err
	}

	if deleteChat {
		if err := s.store.DeleteGroupAdmin(groupKey); err != nil {
			return 0, err
		}
	}

	return deleted, nil
}

func (s *ChatService) GetBroadcastAdmin(actorClientID string) (model.GroupAdminResponse, error) {
	actorClientID = strings.TrimSpace(actorClientID)
	if actorClientID == "" {
		return model.GroupAdminResponse{}, errors.New("actorClientId is required")
	}

	if !s.isSessionActive(actorClientID) {
		return model.GroupAdminResponse{}, errors.New("invalid actor session id")
	}

	adminID, err := s.store.GetGroupAdmin(broadcastAdminKey)
	if err != nil {
		return model.GroupAdminResponse{}, err
	}
	if adminID != "" && !s.isSessionActive(adminID) {
		adminID = ""
	}
	if adminID == "" {
		adminID = actorClientID
		if err := s.store.SetGroupAdmin(broadcastAdminKey, adminID); err != nil {
			return model.GroupAdminResponse{}, err
		}
	}

	return model.GroupAdminResponse{GroupKey: broadcastAdminKey, AdminClientID: adminID}, nil
}

func (s *ChatService) SetBroadcastAdmin(actorClientID, adminClientID string) (model.GroupAdminResponse, error) {
	actorClientID = strings.TrimSpace(actorClientID)
	adminClientID = strings.TrimSpace(adminClientID)
	if actorClientID == "" {
		return model.GroupAdminResponse{}, errors.New("actorClientId is required")
	}
	if adminClientID == "" {
		return model.GroupAdminResponse{}, errors.New("adminClientId is required")
	}

	if !s.isSessionActive(actorClientID) {
		return model.GroupAdminResponse{}, errors.New("invalid actor session id")
	}
	if !s.isSessionActive(adminClientID) {
		return model.GroupAdminResponse{}, errors.New("admin session not found")
	}

	currentAdminID, err := s.store.GetGroupAdmin(broadcastAdminKey)
	if err != nil {
		return model.GroupAdminResponse{}, err
	}
	if currentAdminID != "" && !s.isSessionActive(currentAdminID) {
		currentAdminID = ""
	}
	if currentAdminID != "" && currentAdminID != actorClientID {
		return model.GroupAdminResponse{}, errors.New("only current admin can change broadcast admin")
	}

	if err := s.store.SetGroupAdmin(broadcastAdminKey, adminClientID); err != nil {
		return model.GroupAdminResponse{}, err
	}

	return model.GroupAdminResponse{GroupKey: broadcastAdminKey, AdminClientID: adminClientID}, nil
}

func (s *ChatService) ClearBroadcastChat(actorClientID string, deleteChat bool) (int64, error) {
	actorClientID = strings.TrimSpace(actorClientID)
	if actorClientID == "" {
		return 0, errors.New("actorClientId is required")
	}

	if !s.isSessionActive(actorClientID) {
		return 0, errors.New("invalid actor session id")
	}

	adminID, err := s.store.GetGroupAdmin(broadcastAdminKey)
	if err != nil {
		return 0, err
	}
	if adminID != "" && !s.isSessionActive(adminID) {
		adminID = ""
	}
	if adminID == "" {
		adminID = actorClientID
		if err := s.store.SetGroupAdmin(broadcastAdminKey, adminID); err != nil {
			return 0, err
		}
	}
	if adminID != actorClientID {
		return 0, errors.New("only broadcast admin can clear or delete this chat")
	}

	deleted, err := s.store.DeletePublicConversation()
	if err != nil {
		return 0, err
	}

	if deleteChat {
		if err := s.store.DeleteGroupAdmin(broadcastAdminKey); err != nil {
			return 0, err
		}
	}

	return deleted, nil
}

func (s *ChatService) FindUsers(query, excludeClientID string) []model.ChatUser {
	query = strings.ToLower(strings.TrimSpace(query))

	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]model.ChatUser, 0, len(s.users))
	for _, user := range s.users {
		if excludeClientID != "" && user.ClientID == excludeClientID {
			continue
		}

		if time.Since(user.LastSeen) > activeUserTTL {
			user.Online = false
		} else if user.Online {
			user.Online = true
		}

		if query != "" {
			nick := strings.ToLower(user.Nickname)
			id := strings.ToLower(user.ClientID)
			if !strings.Contains(nick, query) && !strings.Contains(id, query) {
				continue
			}
		}

		s.users[user.ClientID] = user
		out = append(out, user)
	}

	return out
}

func (s *ChatService) TouchUser(clientID string) bool {
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	user, ok := s.users[clientID]
	if !ok {
		return false
	}

	user.LastSeen = time.Now().UTC()
	user.Online = true
	s.users[clientID] = user
	return true
}

func (s *ChatService) Subscribe() chan model.EncryptedMessage {
	return s.broker.Subscribe()
}

func (s *ChatService) Unsubscribe(ch chan model.EncryptedMessage) {
	s.broker.Unsubscribe(ch)
}

func (s *ChatService) getOrCreateRoomKey() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.roomKey) > 0 {
		return s.roomKey, nil
	}

	key, err := crypto.GenerateRoomKey()
	if err != nil {
		return nil, err
	}

	s.roomKey = key
	return s.roomKey, nil
}

func (s *ChatService) groupContext(actorClientID string, memberClientIDs []string) (string, []string, error) {
	actorClientID = strings.TrimSpace(actorClientID)
	if actorClientID == "" {
		return "", nil, errors.New("actorClientId is required")
	}

	s.mu.Lock()
	_, actorExists := s.users[actorClientID]
	s.mu.Unlock()
	if !actorExists {
		return "", nil, errors.New("invalid actor session id")
	}

	memberSet := map[string]struct{}{actorClientID: {}}
	for _, member := range memberClientIDs {
		id := strings.TrimSpace(member)
		if id == "" {
			continue
		}
		memberSet[id] = struct{}{}
	}

	members := make([]string, 0, len(memberSet))
	s.mu.Lock()
	for id := range memberSet {
		if _, ok := s.users[id]; !ok {
			s.mu.Unlock()
			return "", nil, errors.New("group member session not found")
		}
		members = append(members, id)
	}
	s.mu.Unlock()

	if len(members) < 2 {
		return "", nil, errors.New("group chat requires at least two participants")
	}

	sort.Strings(members)
	return "group:" + strings.Join(members, ","), members, nil
}

func (s *ChatService) buildGroupKey(senderClientID string, recipients []string) string {
	members := make([]string, 0, len(recipients)+1)
	seen := make(map[string]struct{}, len(recipients)+1)
	seen[senderClientID] = struct{}{}
	members = append(members, senderClientID)
	for _, recipient := range recipients {
		if _, ok := seen[recipient]; ok {
			continue
		}
		seen[recipient] = struct{}{}
		members = append(members, recipient)
	}
	sort.Strings(members)
	return "group:" + strings.Join(members, ",")
}

func containsID(ids []string, value string) bool {
	for _, id := range ids {
		if id == value {
			return true
		}
	}
	return false
}

func (s *ChatService) isSessionActive(clientID string) bool {
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	user, ok := s.users[clientID]
	if !ok {
		return false
	}

	if time.Since(user.LastSeen) > activeUserTTL {
		user.Online = false
		s.users[clientID] = user
		return false
	}

	return true
}
