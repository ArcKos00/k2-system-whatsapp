// Command wa-reader is the K2 WhatsApp API Gateway, 2.x: REST for sending, RabbitMQ for inbound
// messages, one linked WhatsApp device driven through whatsmeow.
//
// Start order: the HTTP server comes up at once (health, Swagger, session endpoints answer while
// WhatsApp connects), then the process waits for the owner lock in Postgres, and only the owner
// connects WhatsApp and drains the outbox. A second replica therefore idles as a warm standby
// and takes over within seconds when the owner goes away.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/TacticalDevsBattalion/k2-system-whatsapp/internal/api"
	"github.com/TacticalDevsBattalion/k2-system-whatsapp/internal/config"
	"github.com/TacticalDevsBattalion/k2-system-whatsapp/internal/rabbit"
	"github.com/TacticalDevsBattalion/k2-system-whatsapp/internal/store"
	"github.com/TacticalDevsBattalion/k2-system-whatsapp/internal/wa"
)

// Version is set at build time (-ldflags "-X main.Version=…"); VERSION in the repo is the source.
var Version = "dev"

type health struct {
	owner atomic.Bool
	pub   *rabbit.Publisher
}

func (h *health) Owner() bool           { return h.owner.Load() }
func (h *health) RabbitEnabled() bool   { return h.pub.Enabled() }
func (h *health) RabbitConnected() bool { return h.pub.Connected() }

func main() {
	if err := run(); err != nil {
		slog.Error("wa-reader stopped", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level(cfg.LogLevel)})).
		With("service", "wa-reader", "version", Version)
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.Migrate(ctx); err != nil {
		return err
	}

	pub := rabbit.New(cfg.Rabbit, st, log.With("module", "rabbitmq"))
	mgr := wa.NewManager(cfg, st, pub, log.With("module", "whatsapp"))
	h := &health{pub: pub}

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           api.New(cfg, mgr, st, h, log.With("module", "http"), Version).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// Sends wait for the throttle and for WhatsApp's ack; uploads can be 25 MB.
		WriteTimeout: 5 * time.Minute,
	}
	srvErr := make(chan error, 1)
	go func() {
		log.Info("HTTP listening", "port", cfg.Port, "pathBase", cfg.PathBase)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			srvErr <- err
		}
	}()

	lock, err := st.AcquireOwnerLock(ctx, cfg.ClientID, func() {
		log.Info("Another replica owns the WhatsApp session; standing by", "clientId", cfg.ClientID)
	})
	if err != nil {
		if ctx.Err() != nil {
			return shutdown(srv, log)
		}
		return err
	}
	log.Info("Owner lock acquired", "clientId", cfg.ClientID)

	// The session's work (WhatsApp, the outbox pump, pruning) runs under its own context, cancelled
	// the moment ownership ends — before HTTP is drained, so no second owner overlaps with us.
	ownerCtx, endOwnership := context.WithCancel(ctx)
	defer endOwnership()
	if err := mgr.Start(ownerCtx); err != nil {
		// The session store is unusable; holding the lock would keep any other replica out too.
		lock.Release()
		_ = shutdown(srv, log)
		return fmt.Errorf("whatsapp start: %w", err)
	}
	h.owner.Store(true)
	go pub.Run(ownerCtx)
	go prune(ownerCtx, st, cfg, log)

	stopSession := func() {
		h.owner.Store(false)
		endOwnership()
		mgr.Stop()
		lock.Release()
	}
	select {
	case <-ctx.Done():
		log.Info("Shutting down")
		// In-flight sends finish first (they need the session), then the session stops.
		err := shutdown(srv, log)
		stopSession()
		return err
	case err := <-srvErr:
		stopSession()
		_ = shutdown(srv, log)
		return err
	case <-lock.Lost:
		log.Error("Lost the owner lock; stopping the session at once so another replica can take over")
		stopSession()
		_ = shutdown(srv, log)
		return errors.New("owner lock lost")
	}
}

func shutdown(srv *http.Server, log *slog.Logger) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	err := srv.Shutdown(ctx)
	log.Info("HTTP stopped")
	return err
}

func prune(ctx context.Context, st *store.Store, cfg config.Config, log *slog.Logger) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if err := st.Prune(ctx, cfg.MessageTTL, cfg.IdempotencyTTL); err != nil && ctx.Err() == nil {
			log.Warn("Prune failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func level(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	}
	return slog.LevelInfo
}
