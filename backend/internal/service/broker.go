package service

import (
	"sync"

	"github.com/youruser/nchat/backend/internal/model"
)

type Broker struct {
	mu      sync.RWMutex
	clients map[chan model.EncryptedMessage]struct{}
}

func NewBroker() *Broker {
	return &Broker{clients: make(map[chan model.EncryptedMessage]struct{})}
}

func (b *Broker) Subscribe() chan model.EncryptedMessage {
	ch := make(chan model.EncryptedMessage, 16)
	b.mu.Lock()
	b.clients[ch] = struct{}{}
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

	for ch := range b.clients {
		select {
		case ch <- message:
		default:
		}
	}
}
