package crypto

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
)

func GenerateRoomKey() ([]byte, error) {
	key := make([]byte, 32)
	_, err := rand.Read(key)
	if err != nil {
		return nil, err
	}
	return key, nil
}

func EncryptRoomKeyWithRSAPublicPEM(publicKeyPEM string, roomKey []byte) (string, error) {
	block, _ := pem.Decode([]byte(publicKeyPEM))
	if block == nil {
		return "", errors.New("invalid PEM public key")
	}

	var parsedKey any
	var err error
	if block.Type == "PUBLIC KEY" {
		parsedKey, err = x509.ParsePKIXPublicKey(block.Bytes)
	} else {
		parsedKey, err = x509.ParsePKCS1PublicKey(block.Bytes)
	}
	if err != nil {
		return "", err
	}

	rsaKey, ok := parsedKey.(*rsa.PublicKey)
	if !ok {
		return "", errors.New("public key is not RSA")
	}

	ciphertext, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, rsaKey, roomKey, nil)
	if err != nil {
		return "", err
	}

	return base64.StdEncoding.EncodeToString(ciphertext), nil
}
