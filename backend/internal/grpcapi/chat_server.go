package grpcapi

import (
	"context"
	"time"

	chatv1 "github.com/youruser/nchat/backend/gen/chat/v1"
	"github.com/youruser/nchat/backend/internal/model"
	"github.com/youruser/nchat/backend/internal/service"
)

type ChatServer struct {
	chatv1.UnimplementedChatRelayServiceServer
	chat *service.ChatService
}

func NewChatServer(chat *service.ChatService) *ChatServer {
	return &ChatServer{chat: chat}
}

func (s *ChatServer) SendMessage(_ context.Context, req *chatv1.SendMessageRequest) (*chatv1.SendMessageResponse, error) {
	stored, err := s.chat.PostMessage(model.PostMessageRequest{
		Sender:     req.GetSender(),
		Ciphertext: req.GetCiphertext(),
		Nonce:      req.GetNonce(),
	})
	if err != nil {
		return nil, err
	}

	return &chatv1.SendMessageResponse{Message: toProtoMessage(stored)}, nil
}

func (s *ChatServer) ListMessages(_ context.Context, req *chatv1.ListMessagesRequest) (*chatv1.ListMessagesResponse, error) {
	messages, err := s.chat.ListMessages(int(req.GetLimit()))
	if err != nil {
		return nil, err
	}

	out := make([]*chatv1.EncryptedMessage, 0, len(messages))
	for _, msg := range messages {
		out = append(out, toProtoMessage(msg))
	}
	return &chatv1.ListMessagesResponse{Messages: out}, nil
}

func (s *ChatServer) StreamMessages(_ *chatv1.ListMessagesRequest, stream chatv1.ChatRelayService_StreamMessagesServer) error {
	updates := s.chat.Subscribe()
	defer s.chat.Unsubscribe(updates)

	for {
		select {
		case <-stream.Context().Done():
			return nil
		case msg, ok := <-updates:
			if !ok {
				return nil
			}
			if err := stream.Send(toProtoMessage(msg)); err != nil {
				return err
			}
		}
	}
}

func toProtoMessage(msg model.EncryptedMessage) *chatv1.EncryptedMessage {
	return &chatv1.EncryptedMessage{
		Id:         msg.ID,
		Sender:     msg.Sender,
		Ciphertext: msg.Ciphertext,
		Nonce:      msg.Nonce,
		CreatedAt:  msg.CreatedAt.Format(time.RFC3339Nano),
	}
}
