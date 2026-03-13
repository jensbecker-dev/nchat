package http

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/youruser/nchat/backend/internal/config"
	"github.com/youruser/nchat/backend/internal/model"
	"github.com/youruser/nchat/backend/internal/service"
)

type Handler struct {
	cfg      config.Config
	chat     *service.ChatService
	upgrader websocket.Upgrader
}

func NewHandler(cfg config.Config, chat *service.ChatService) *Handler {
	return &Handler{
		cfg:  cfg,
		chat: chat,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				if cfg.CORSOrigin == "" || cfg.CORSOrigin == "*" {
					return true
				}

				origin := strings.TrimSpace(r.Header.Get("Origin"))
				if origin == "" {
					return false
				}

				for _, allowed := range strings.Split(cfg.CORSOrigin, ",") {
					if strings.TrimSpace(allowed) == origin {
						return true
					}
				}

				return false
			},
		},
	}
}

func (h *Handler) Healthz(w http.ResponseWriter, _ *http.Request) {
	respondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) KeyExchange(w http.ResponseWriter, r *http.Request) {
	var req model.KeyExchangeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.PublicKey == "" {
		respondError(w, http.StatusBadRequest, "publicKey is required")
		return
	}

	response, err := h.chat.ExchangeKey(req.Nickname, req.PublicKey, req.ClientID)
	if err != nil {
		log.Printf("key exchange failed: %v", err)
		respondError(w, http.StatusBadRequest, "failed to exchange keys")
		return
	}

	respondJSON(w, http.StatusOK, response)
}

func (h *Handler) ListMessages(w http.ResponseWriter, r *http.Request) {
	clientID := r.URL.Query().Get("clientId")
	if clientID == "" {
		respondError(w, http.StatusBadRequest, "clientId is required")
		return
	}

	limit := h.cfg.MaxMessages
	if rawLimit := r.URL.Query().Get("limit"); rawLimit != "" {
		if parsedLimit, err := strconv.Atoi(rawLimit); err == nil && parsedLimit > 0 && parsedLimit <= 1000 {
			limit = parsedLimit
		}
	}

	messages, err := h.chat.ListMessages(clientID, limit)
	if err != nil {
		log.Printf("list messages failed: %v", err)
		respondError(w, http.StatusBadRequest, "failed to load messages")
		return
	}

	respondJSON(w, http.StatusOK, messages)
}

func (h *Handler) PostMessage(w http.ResponseWriter, r *http.Request) {
	var req model.PostMessageRequest
	r.Body = http.MaxBytesReader(w, r.Body, int64(h.cfg.MaxRequestBody))
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		if errors.Is(err, io.EOF) {
			respondError(w, http.StatusBadRequest, "empty JSON body")
			return
		}
		respondError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); err != io.EOF {
		respondError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	msg, err := h.chat.PostMessage(req)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	respondJSON(w, http.StatusCreated, msg)
}

func (h *Handler) ClearPrivateChat(w http.ResponseWriter, r *http.Request) {
	selfID := r.URL.Query().Get("selfClientId")
	partnerID := r.URL.Query().Get("partnerClientId")
	if selfID == "" {
		selfID = r.URL.Query().Get("selfSessionId")
	}
	if partnerID == "" {
		partnerID = r.URL.Query().Get("partnerSessionId")
	}

	deleted, err := h.chat.ClearPrivateChat(selfID, partnerID)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}

func (h *Handler) GetGroupAdmin(w http.ResponseWriter, r *http.Request) {
	var req model.GroupAdminGetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	response, err := h.chat.GetGroupAdmin(req.ActorClientID, req.MemberClientIDs)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, response)
}

func (h *Handler) SetGroupAdmin(w http.ResponseWriter, r *http.Request) {
	var req model.GroupAdminSetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	response, err := h.chat.SetGroupAdmin(req.ActorClientID, req.MemberClientIDs, req.AdminClientID)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, response)
}

func (h *Handler) ClearGroupChat(w http.ResponseWriter, r *http.Request) {
	var req model.GroupChatActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	deleted, err := h.chat.ClearGroupChat(req.ActorClientID, req.MemberClientIDs, false)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}

func (h *Handler) DeleteGroupChat(w http.ResponseWriter, r *http.Request) {
	var req model.GroupChatActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	deleted, err := h.chat.ClearGroupChat(req.ActorClientID, req.MemberClientIDs, true)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}

func (h *Handler) GetBroadcastAdmin(w http.ResponseWriter, r *http.Request) {
	var req model.BroadcastAdminGetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	response, err := h.chat.GetBroadcastAdmin(req.ActorClientID)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, response)
}

func (h *Handler) SetBroadcastAdmin(w http.ResponseWriter, r *http.Request) {
	var req model.BroadcastAdminSetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	response, err := h.chat.SetBroadcastAdmin(req.ActorClientID, req.AdminClientID)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, response)
}

func (h *Handler) ClearBroadcastChat(w http.ResponseWriter, r *http.Request) {
	var req model.BroadcastChatActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	deleted, err := h.chat.ClearBroadcastChat(req.ActorClientID, false)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}

func (h *Handler) DeleteBroadcastChat(w http.ResponseWriter, r *http.Request) {
	var req model.BroadcastChatActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	deleted, err := h.chat.ClearBroadcastChat(req.ActorClientID, true)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}

func (h *Handler) FindUsers(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("query")
	exclude := r.URL.Query().Get("excludeClientId")
	users := h.chat.FindUsers(query, exclude)
	respondJSON(w, http.StatusOK, model.UserSearchResponse{Users: users})
}

func (h *Handler) PingPresence(w http.ResponseWriter, r *http.Request) {
	var req model.PresencePingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	if ok := h.chat.TouchUser(req.ClientID); !ok {
		respondError(w, http.StatusNotFound, "user not found")
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) WebSocket(w http.ResponseWriter, r *http.Request) {
	clientID := r.URL.Query().Get("clientId")
	if clientID == "" {
		respondError(w, http.StatusBadRequest, "clientId is required")
		return
	}

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	messages, err := h.chat.Subscribe(clientID)
	if err != nil {
		_ = conn.WriteJSON(map[string]string{"error": err.Error()})
		return
	}
	defer h.chat.Unsubscribe(messages)

	conn.SetReadLimit(1024)
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(_ string) error {
		return conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	})

	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	for msg := range messages {
		if err := conn.WriteJSON(msg); err != nil {
			return
		}
	}
}

func respondJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]string{"error": message})
}
