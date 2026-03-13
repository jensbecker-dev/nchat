package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	chatv1 "github.com/youruser/nchat/backend/gen/chat/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	sub := os.Args[1]
	switch sub {
	case "send":
		runSend(os.Args[2:])
	case "list":
		runList(os.Args[2:])
	case "stream":
		runStream(os.Args[2:])
	default:
		fmt.Printf("unknown command: %s\n\n", sub)
		printUsage()
		os.Exit(1)
	}
}

func runSend(args []string) {
	fs := flag.NewFlagSet("send", flag.ExitOnError)
	addr := fs.String("addr", "localhost:9090", "gRPC target address")
	sender := fs.String("sender", "operator", "message sender")
	ciphertext := fs.String("ciphertext", "", "ciphertext payload")
	nonce := fs.String("nonce", "", "nonce value")
	timeout := fs.Duration("timeout", 5*time.Second, "request timeout")
	_ = fs.Parse(args)

	if strings.TrimSpace(*ciphertext) == "" || strings.TrimSpace(*nonce) == "" {
		log.Fatal("send requires -ciphertext and -nonce")
	}

	client, conn := mustClient(*addr)
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	resp, err := client.SendMessage(ctx, &chatv1.SendMessageRequest{
		Sender:     *sender,
		Ciphertext: *ciphertext,
		Nonce:      *nonce,
	})
	if err != nil {
		log.Fatalf("send failed: %v", err)
	}

	msg := resp.GetMessage()
	fmt.Printf("sent id=%d sender=%s created_at=%s\n", msg.GetId(), msg.GetSender(), msg.GetCreatedAt())
}

func runList(args []string) {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	addr := fs.String("addr", "localhost:9090", "gRPC target address")
	limit := fs.Int("limit", 50, "max messages")
	timeout := fs.Duration("timeout", 5*time.Second, "request timeout")
	_ = fs.Parse(args)

	client, conn := mustClient(*addr)
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	resp, err := client.ListMessages(ctx, &chatv1.ListMessagesRequest{Limit: int32(*limit)})
	if err != nil {
		log.Fatalf("list failed: %v", err)
	}

	for _, msg := range resp.GetMessages() {
		fmt.Printf("id=%d sender=%s created_at=%s\n", msg.GetId(), msg.GetSender(), msg.GetCreatedAt())
		fmt.Printf("  ciphertext=%s\n", msg.GetCiphertext())
		fmt.Printf("  nonce=%s\n", msg.GetNonce())
	}
}

func runStream(args []string) {
	fs := flag.NewFlagSet("stream", flag.ExitOnError)
	addr := fs.String("addr", "localhost:9090", "gRPC target address")
	_ = fs.Parse(args)

	client, conn := mustClient(*addr)
	defer conn.Close()

	stream, err := client.StreamMessages(context.Background(), &chatv1.ListMessagesRequest{})
	if err != nil {
		log.Fatalf("stream failed: %v", err)
	}

	fmt.Println("streaming encrypted messages (Ctrl+C to stop)")
	for {
		msg, err := stream.Recv()
		if err != nil {
			log.Fatalf("stream recv failed: %v", err)
		}
		fmt.Printf("id=%d sender=%s created_at=%s ciphertext=%s nonce=%s\n", msg.GetId(), msg.GetSender(), msg.GetCreatedAt(), msg.GetCiphertext(), msg.GetNonce())
	}
}

func mustClient(addr string) (chatv1.ChatRelayServiceClient, *grpc.ClientConn) {
	conn, err := grpc.Dial(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("failed to connect to %s: %v", addr, err)
	}
	return chatv1.NewChatRelayServiceClient(conn), conn
}

func printUsage() {
	fmt.Println("nchatctl - gRPC helper client")
	fmt.Println("")
	fmt.Println("Usage:")
	fmt.Println("  nchatctl send -addr localhost:9090 -sender op -ciphertext <b64> -nonce <b64>")
	fmt.Println("  nchatctl list -addr localhost:9090 -limit 50")
	fmt.Println("  nchatctl stream -addr localhost:9090")
}
