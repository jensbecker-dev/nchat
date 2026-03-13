package grpcapi

import (
	"context"
	"time"

	chatv1 "github.com/youruser/nchat/backend/gen/chat/v1"
	"github.com/youruser/nchat/backend/internal/model"
	"github.com/youruser/nchat/backend/internal/service"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type ChatServer struct {
	chatv1.UnimplementedChatRelayServiceServer
	chat *service.ChatService
}

func NewChatServer(chat *service.ChatService) *ChatServer {
	return &ChatServer{chat: chat}
}

func (s *ChatServer) SendMessage(_ context.Context, req *chatv1.SendMessageRequest) (*chatv1.SendMessageResponse, error) {
	_ = req
	return nil, status.Error(codes.FailedPrecondition, "gRPC SendMessage requires senderClientId/chatType/recipients; use REST /api/v1/messages")
}

func (s *ChatServer) ListMessages(_ context.Context, req *chatv1.ListMessagesRequest) (*chatv1.ListMessagesResponse, error) {
	_ = req
	return nil, status.Error(codes.FailedPrecondition, "gRPC ListMessages requires client identity; use REST /api/v1/messages?clientId=...")
}

func (s *ChatServer) StreamMessages(_ *chatv1.ListMessagesRequest, stream chatv1.ChatRelayService_StreamMessagesServer) error {
	_ = stream
	return status.Error(codes.FailedPrecondition, "gRPC StreamMessages requires client identity; use WebSocket /ws?clientId=...")
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
