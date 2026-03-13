package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"github.com/youruser/nchat/backend/internal/model"
)

type SQLiteStore struct {
	db *sql.DB
}

func NewSQLiteStore(path string) (*SQLiteStore, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}

	db, err := sql.Open("sqlite3", path)
	if err != nil {
		return nil, err
	}

	store := &SQLiteStore{db: db}
	if err := store.initSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}

	return store, nil
}

func (s *SQLiteStore) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *SQLiteStore) SaveMessage(msg model.EncryptedMessage) (model.EncryptedMessage, error) {
	if msg.Sender == "" || msg.Ciphertext == "" || msg.Nonce == "" {
		return model.EncryptedMessage{}, errors.New("sender, ciphertext and nonce are required")
	}

	now := time.Now().UTC()
	recipientsJSON := "[]"
	if len(msg.RecipientClientIDs) > 0 {
		encoded, err := json.Marshal(msg.RecipientClientIDs)
		if err != nil {
			return model.EncryptedMessage{}, err
		}
		recipientsJSON = string(encoded)
	}

	chatType := strings.TrimSpace(msg.ChatType)
	if chatType == "" {
		chatType = "public"
	}

	result, err := s.db.Exec(
		`INSERT INTO messages (sender, sender_client_id, chat_type, group_key, recipient_client_ids, ciphertext, nonce, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		msg.Sender,
		msg.SenderClientID,
		chatType,
		msg.GroupKey,
		recipientsJSON,
		msg.Ciphertext,
		msg.Nonce,
		now,
	)
	if err != nil {
		return model.EncryptedMessage{}, err
	}

	id, err := result.LastInsertId()
	if err != nil {
		return model.EncryptedMessage{}, err
	}

	msg.ID = id
	msg.ChatType = chatType
	msg.CreatedAt = now
	return msg, nil
}

func (s *SQLiteStore) ListMessages(limit int) ([]model.EncryptedMessage, error) {
	if limit <= 0 {
		limit = 200
	}

	rows, err := s.db.Query(
		`SELECT id, sender, sender_client_id, chat_type, group_key, recipient_client_ids, ciphertext, nonce, created_at
		 FROM messages
		 ORDER BY id DESC
		 LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	messages := make([]model.EncryptedMessage, 0, limit)
	for rows.Next() {
		var msg model.EncryptedMessage
		var recipientsRaw string
		if err := rows.Scan(&msg.ID, &msg.Sender, &msg.SenderClientID, &msg.ChatType, &msg.GroupKey, &recipientsRaw, &msg.Ciphertext, &msg.Nonce, &msg.CreatedAt); err != nil {
			return nil, err
		}
		if recipientsRaw != "" {
			_ = json.Unmarshal([]byte(recipientsRaw), &msg.RecipientClientIDs)
		}
		if msg.ChatType == "" {
			msg.ChatType = "public"
		}
		messages = append(messages, msg)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	return messages, nil
}

func (s *SQLiteStore) DeletePrivateConversation(selfClientID, partnerClientID string) (int64, error) {
	selfRecipients, err := json.Marshal([]string{partnerClientID})
	if err != nil {
		return 0, err
	}
	partnerRecipients, err := json.Marshal([]string{selfClientID})
	if err != nil {
		return 0, err
	}

	result, err := s.db.Exec(
		`DELETE FROM messages
		 WHERE chat_type = 'private'
		   AND ((sender_client_id = ? AND recipient_client_ids = ?)
		        OR (sender_client_id = ? AND recipient_client_ids = ?))`,
		selfClientID,
		string(selfRecipients),
		partnerClientID,
		string(partnerRecipients),
	)
	if err != nil {
		return 0, err
	}

	return result.RowsAffected()
}

func (s *SQLiteStore) DeleteGroupConversation(groupKey string) (int64, error) {
	result, err := s.db.Exec(`DELETE FROM messages WHERE chat_type = 'group' AND group_key = ?`, groupKey)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (s *SQLiteStore) DeletePublicConversation() (int64, error) {
	result, err := s.db.Exec(`DELETE FROM messages WHERE chat_type = 'public'`)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (s *SQLiteStore) GetGroupAdmin(groupKey string) (string, error) {
	var adminID string
	err := s.db.QueryRow(`SELECT admin_client_id FROM group_admins WHERE group_key = ?`, groupKey).Scan(&adminID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return adminID, nil
}

func (s *SQLiteStore) SetGroupAdmin(groupKey, adminClientID string) error {
	_, err := s.db.Exec(
		`INSERT INTO group_admins (group_key, admin_client_id, updated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(group_key) DO UPDATE SET admin_client_id = excluded.admin_client_id, updated_at = excluded.updated_at`,
		groupKey,
		adminClientID,
		time.Now().UTC(),
	)
	return err
}

func (s *SQLiteStore) DeleteGroupAdmin(groupKey string) error {
	_, err := s.db.Exec(`DELETE FROM group_admins WHERE group_key = ?`, groupKey)
	return err
}

func (s *SQLiteStore) initSchema() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			sender TEXT NOT NULL,
			sender_client_id TEXT NOT NULL DEFAULT '',
			chat_type TEXT NOT NULL DEFAULT 'public',
			group_key TEXT NOT NULL DEFAULT '',
			recipient_client_ids TEXT NOT NULL DEFAULT '[]',
			ciphertext TEXT NOT NULL,
			nonce TEXT NOT NULL,
			created_at DATETIME NOT NULL
		);
	`)
	if err != nil {
		return err
	}

	if err := s.ensureColumn("messages", "sender_client_id", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := s.ensureColumn("messages", "chat_type", "TEXT NOT NULL DEFAULT 'public'"); err != nil {
		return err
	}
	if err := s.ensureColumn("messages", "group_key", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := s.ensureColumn("messages", "recipient_client_ids", "TEXT NOT NULL DEFAULT '[]'"); err != nil {
		return err
	}

	_, err = s.db.Exec(`
		CREATE TABLE IF NOT EXISTS group_admins (
			group_key TEXT PRIMARY KEY,
			admin_client_id TEXT NOT NULL,
			updated_at DATETIME NOT NULL
		);
	`)
	if err != nil {
		return err
	}

	return nil
}

func (s *SQLiteStore) ensureColumn(table, column, definition string) error {
	rows, err := s.db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name string
		var ctype string
		var notnull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	_, err = s.db.Exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition)
	return err
}
