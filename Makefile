SHELL := /bin/bash

.PHONY: dev backend frontend launch stop backend-launch backend-stop backend-status tidy test proto nchatctl install-nchatctl

dev:
	@echo "Starting backend and frontend in two terminals is recommended."
	@echo "Backend: make backend"
	@echo "Frontend: make frontend"

backend:
	cd backend && go run ./cmd/nchatd

frontend:
	cd frontend && npm run dev

launch:
	bash ./scripts/launch-nchat.sh

stop:
	bash ./scripts/stop-nchat.sh

backend-launch:
	bash ./scripts/launch-backend.sh

backend-stop:
	bash ./scripts/stop-backend.sh

backend-status:
	bash ./scripts/status-backend.sh

nchatctl:
	cd backend && go run ./cmd/nchatctl --help

install-nchatctl:
	cd backend && go install ./cmd/nchatctl

tidy:
	cd backend && go mod tidy
	cd frontend && npm install

test:
	cd backend && go test ./...
	cd frontend && npm run build

proto-tools:
	cd backend && mkdir -p .tools && curl -L -o .tools/protoc.zip https://github.com/protocolbuffers/protobuf/releases/download/v25.3/protoc-25.3-linux-x86_64.zip && unzip -o .tools/protoc.zip -d .tools/protoc
	cd backend && GOBIN=$$(pwd)/.tools/bin go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.31.0
	cd backend && GOBIN=$$(pwd)/.tools/bin go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.3.0

proto: proto-tools
	cd backend && mkdir -p gen
	cd backend && PATH=$$(pwd)/.tools/bin:$$PATH ./.tools/protoc/bin/protoc -I ./api/proto --go_out=./gen --go_opt=paths=source_relative --go-grpc_out=./gen --go-grpc_opt=paths=source_relative ./api/proto/chat/v1/chat.proto
