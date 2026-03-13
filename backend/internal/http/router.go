package http

import (
	"net/http"

	"github.com/youruser/nchat/backend/internal/config"
	"github.com/youruser/nchat/backend/internal/service"
)

func NewRouter(cfg config.Config, chat *service.ChatService) http.Handler {
	h := NewHandler(cfg, chat)
	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", requireMethod(http.MethodGet, h.Healthz))
	mux.HandleFunc("/api/v1/key-exchange", requireMethod(http.MethodPost, h.KeyExchange))
	mux.HandleFunc("/api/v1/messages", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.ListMessages(w, r)
		case http.MethodPost:
			h.PostMessage(w, r)
		default:
			methodNotAllowed(w, http.MethodGet, http.MethodPost)
		}
	})
	mux.HandleFunc("/api/v1/messages/private", requireMethod(http.MethodDelete, h.ClearPrivateChat))
	mux.HandleFunc("/api/v1/messages/broadcast/clear", requireMethod(http.MethodPost, h.ClearBroadcastChat))
	mux.HandleFunc("/api/v1/messages/broadcast/delete", requireMethod(http.MethodPost, h.DeleteBroadcastChat))
	mux.HandleFunc("/api/v1/messages/group/clear", requireMethod(http.MethodPost, h.ClearGroupChat))
	mux.HandleFunc("/api/v1/messages/group/delete", requireMethod(http.MethodPost, h.DeleteGroupChat))
	mux.HandleFunc("/api/v1/broadcast/admin/get", requireMethod(http.MethodPost, h.GetBroadcastAdmin))
	mux.HandleFunc("/api/v1/broadcast/admin/set", requireMethod(http.MethodPut, h.SetBroadcastAdmin))
	mux.HandleFunc("/api/v1/groups/admin/get", requireMethod(http.MethodPost, h.GetGroupAdmin))
	mux.HandleFunc("/api/v1/groups/admin/set", requireMethod(http.MethodPut, h.SetGroupAdmin))
	mux.HandleFunc("/api/v1/users", requireMethod(http.MethodGet, h.FindUsers))
	mux.HandleFunc("/api/v1/presence", requireMethod(http.MethodPost, h.PingPresence))
	mux.HandleFunc("/ws", requireMethod(http.MethodGet, h.WebSocket))

	return withCORS(cfg.CORSOrigin, mux)
}

func requireMethod(method string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != method {
			methodNotAllowed(w, method)
			return
		}
		next(w, r)
	}
}

func methodNotAllowed(w http.ResponseWriter, allowed ...string) {
	if len(allowed) > 0 {
		w.Header().Set("Allow", allowed[0])
		for i := 1; i < len(allowed); i++ {
			w.Header().Add("Allow", allowed[i])
		}
	}
	w.WriteHeader(http.StatusMethodNotAllowed)
}

func withCORS(origin string, next http.Handler) http.Handler {
	if origin == "" {
		origin = "*"
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
