// Package config reads the gateway's settings from the environment.
//
// Names are kept from 1.x wherever the setting still means the same thing (PORT, PATH_BASE,
// WHATSAPP_MESSAGE_DELAY_MS, RABBITMQ_*, IDEMPOTENCY_TTL_MS, LOG_LEVEL), so an existing
// ConfigMap keeps working. Everything that only existed for Chromium, Puppeteer or the
// WhatsApp Web build is gone; see the 2.0.0 notes in README.md.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port     int
	PathBase string
	LogLevel string

	// DatabaseURL is a Postgres DSN. It must reach the database directly, not through
	// pgbouncer in transaction mode: the single-owner lock is a session advisory lock.
	DatabaseURL string
	// ClientID names the session. Two instances with different ids never contend for the
	// owner lock and keep separate devices in the same database.
	ClientID string

	MessageDelay   time.Duration
	LoginWait      time.Duration
	DeviceName     string
	MessageTTL     time.Duration
	IdempotencyTTL time.Duration
	// InFlightTimeout is how long a claimed idempotency key may stay unfinished before a
	// retry is let through (the process that claimed it is presumed dead).
	InFlightTimeout time.Duration

	Rabbit RabbitConfig
}

type RabbitConfig struct {
	URL            string
	Exchange       string
	ReconnectDelay time.Duration
	ConnectTimeout time.Duration
	ChatIDs        []string
	// PublishBatch caps how many outbox rows one publish pass takes.
	PublishBatch int
}

func Load() (Config, error) {
	c := Config{
		Port:            num("PORT", 3000),
		PathBase:        NormalizePathBase(os.Getenv("PATH_BASE")),
		LogLevel:        strings.ToLower(str("LOG_LEVEL", "info")),
		DatabaseURL:     strings.TrimSpace(os.Getenv("DATABASE_URL")),
		ClientID:        str("WHATSAPP_CLIENT_ID", "default"),
		MessageDelay:    ms("WHATSAPP_MESSAGE_DELAY_MS", 3000),
		LoginWait:       ms("WHATSAPP_LOGIN_WAIT_MS", 60000),
		DeviceName:      str("WHATSAPP_DEVICE_NAME", "K2 WhatsApp Gateway"),
		MessageTTL:      time.Duration(num("WHATSAPP_HISTORY_RETENTION_SEC", 7*24*3600)) * time.Second,
		IdempotencyTTL:  ms("IDEMPOTENCY_TTL_MS", 7*24*3600*1000),
		InFlightTimeout: ms("IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS", 5*60*1000),
		Rabbit: RabbitConfig{
			URL:            strings.TrimSpace(os.Getenv("RABBITMQ_URL")),
			Exchange:       str("RABBITMQ_EXCHANGE", "whatsapp.messages"),
			ReconnectDelay: ms("RABBITMQ_RECONNECT_DELAY_MS", 5000),
			ConnectTimeout: ms("RABBITMQ_CONNECT_TIMEOUT_MS", 10000),
			ChatIDs:        list("RABBITMQ_CHAT_IDS"),
			PublishBatch:   num("RABBITMQ_PUBLISH_BATCH", 100),
		},
	}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("DATABASE_URL is required: the WhatsApp session, the idempotency keys and the outbox live in Postgres")
	}
	return c, nil
}

// NormalizePathBase turns "whatsapp/", "/whatsapp" and "/whatsapp/" into "/whatsapp", and "" or
// "/" into "".
func NormalizePathBase(raw string) string {
	t := strings.TrimSpace(raw)
	if t == "" || t == "/" {
		return ""
	}
	if !strings.HasPrefix(t, "/") {
		t = "/" + t
	}
	return strings.TrimRight(t, "/")
}

func str(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

func num(name string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func ms(name string, fallback int) time.Duration {
	return time.Duration(num(name, fallback)) * time.Millisecond
}

func list(name string) []string {
	var out []string
	for _, item := range strings.Split(os.Getenv(name), ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}
