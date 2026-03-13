package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	chatv1 "github.com/youruser/nchat/backend/gen/chat/v1"
	"github.com/youruser/nchat/backend/internal/config"
	grpcapi "github.com/youruser/nchat/backend/internal/grpcapi"
	httpapi "github.com/youruser/nchat/backend/internal/http"
	"github.com/youruser/nchat/backend/internal/service"
	"github.com/youruser/nchat/backend/internal/store"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"
)

func main() {
	cfg := config.Load()

	db, err := store.NewSQLiteStore(cfg.DBPath)
	if err != nil {
		log.Fatalf("failed to initialize store: %v", err)
	}
	defer db.Close()

	chatService := service.NewChatService(db)
	router := httpapi.NewRouter(cfg, chatService)
	grpcSrv := grpc.NewServer()
	chatv1.RegisterChatRelayServiceServer(grpcSrv, grpcapi.NewChatServer(chatService))
	reflection.Register(grpcSrv)

	grpcListener, err := net.Listen("tcp", cfg.GRPCAddr)
	grpcEnabled := err == nil
	if err != nil {
		log.Printf("warning: gRPC disabled (listen failed on %s): %v", cfg.GRPCAddr, err)
	}

	server := &http.Server{
		Addr:         cfg.HTTPAddr,
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("NCHAT backend listening on %s", cfg.HTTPAddr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server failed: %v", err)
		}
	}()

	if grpcEnabled {
		go func() {
			log.Printf("NCHAT gRPC listening on %s", cfg.GRPCAddr)
			if err := grpcSrv.Serve(grpcListener); err != nil {
				log.Printf("warning: grpc server stopped: %v", err)
			}
		}()
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
	if grpcEnabled {
		grpcSrv.GracefulStop()
	}
}
