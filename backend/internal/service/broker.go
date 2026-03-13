package service

import (
	"sync"

	"github.com/youruser/nchat/backend/internal/model"
)

type Broker struct {
	mu      sync.RWMutex
	clients map[chan model.EncryptedMessage]string
}

func NewBroker() *Broker {
	return &Broker{clients: make(map[chan model.EncryptedMessage]string)}
}

func (b *Broker) Subscribe(clientID string) chan model.EncryptedMessage {
	ch := make(chan model.EncryptedMessage, 16)
	b.mu.Lock()
	b.clients[ch] = clientID
	b.mu.Unlock()
	return ch
}

func (b *Broker) Unsubscribe(ch chan model.EncryptedMessage) {
	b.mu.Lock()
	if _, ok := b.clients[ch]; ok {
		delete(b.clients, ch)
		close(ch)
	}
	b.mu.Unlock()
}

func (b *Broker) Broadcast(message model.EncryptedMessage) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	for ch, clientID := range b.clients {
		if !shouldDeliverMessage(message, clientID) {
			continue
		}
		select {
		case ch <- message:
		default:
		}
	}
}

func shouldDeliverMessage(message model.EncryptedMessage, clientID string) bool {
	if clientID == "" {
		return false
	}

	if message.ChatType == "public" {
		return true
	}

	if message.SenderClientID == clientID {
		return true
	}

	for _, recipient := range message.RecipientClientIDs {
		if recipient == clientID {
			return true
		}
	}

	return false
}
