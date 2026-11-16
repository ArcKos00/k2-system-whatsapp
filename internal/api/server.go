// Package api is the REST surface, route for route and code for code the 1.x one: same paths,
// same bodies, same error envelope ({message, code, details?}), same status codes.
package api

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	swaggerFiles "github.com/swaggo/files/v2"

	"github.com/TacticalDevsBattalion/k2-system-whatsapp/internal/config"
	"github.com/TacticalDevsBattalion/k2-system-whatsapp/internal/store"
	"github.com/TacticalDevsBattalion/k2-system-whatsapp/internal/wa"
)

//go:embed openapi.json
var openapiSpec []byte

const maxBody = 25 << 20 // 1.x: express json/urlencoded limit 25mb

// Health is what the rest of the process reports to /health.
type Health interface {
	Owner() bool
	RabbitEnabled() bool
	RabbitConnected() bool
}

type Server struct {
	cfg    config.Config
	wa     *wa.Manager
	st     *store.Store
	health Health
	log    *slog.Logger
	spec   []byte
}

func New(cfg config.Config, m *wa.Manager, st *store.Store, h Health, log *slog.Logger, version string) *Server {
	return &Server{cfg: cfg, wa: m, st: st, health: h, log: log, spec: specFor(cfg.PathBase, version)}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.getHealth)
	mux.HandleFunc("GET /ready", s.getReady)
	mux.HandleFunc("GET /health/owner", s.getOwner)
	mux.HandleFunc("GET /qr", s.getQR)
	mux.HandleFunc("GET /session", s.getSession)
	mux.HandleFunc("POST /session/login", s.postLogin)
	mux.HandleFunc("POST /session/logout", s.postLogout)
	mux.HandleFunc("POST /session/pair-code", s.postPairCode)
	mux.HandleFunc("GET /session/qr", s.getSessionQR)
	mux.HandleFunc("GET /chats", s.getChats)
	mux.HandleFunc("POST /messages/send", s.postSend)
	mux.HandleFunc("POST /messages/send-with-files", s.postSendWithFiles)
	mux.HandleFunc("POST /messages/chat/send", s.postChatSend)
	mux.HandleFunc("POST /messages/chat/send-with-files", s.postChatSendWithFiles)
	mux.HandleFunc("GET /openapi.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(s.spec)
	})
	mux.HandleFunc("GET /docs", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, s.cfg.PathBase+"/docs/", http.StatusMovedPermanently)
	})
	mux.HandleFunc("GET /docs/{$}", s.getDocs)
	mux.HandleFunc("GET /docs/init.js", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		spec, _ := json.Marshal(s.cfg.PathBase + "/openapi.json")
		_, _ = fmt.Fprintf(w, `window.ui = SwaggerUIBundle({url: %s, dom_id: "#swagger-ui", deepLinking: true,
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset], layout: "StandaloneLayout"});`, spec)
	})
	mux.Handle("GET /docs/", http.StripPrefix("/docs/", http.FileServerFS(swaggerAssets())))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", fmt.Sprintf("Route not found: %s %s", r.Method, r.URL.Path), nil)
	})
	return s.recoverer(pathBase(s.cfg.PathBase, mux))
}

// pathBase strips PATH_BASE like ASP.NET UsePathBase: /whatsapp/messages/send and /messages/send
// both reach the route, so probes on the pod need no prefix.
func pathBase(base string, next http.Handler) http.Handler {
	if base == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if p == base || strings.HasPrefix(p, base+"/") {
			r2 := r.Clone(r.Context())
			r2.URL.Path = strings.TrimPrefix(p, base)
			if r2.URL.Path == "" {
				r2.URL.Path = "/"
			}
			r2.URL.RawPath = ""
			r = r2
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				s.log.Error("Unhandled panic", "method", r.Method, "path", r.URL.Path, "panic", fmt.Sprint(v))
				writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error", nil)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// ── health ──────────────────────────────────────────────────────────────────

func (s *Server) getHealth(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{"status": "ok", "whatsapp": s.wa.Status(), "owner": s.health.Owner()}
	if s.health.RabbitEnabled() {
		body["rabbitmq"] = map[bool]string{true: "connected", false: "disconnected"}[s.health.RabbitConnected()]
	} else {
		body["rabbitmq"] = "disabled"
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if n, age, err := s.st.OutboxBacklog(ctx); err == nil {
		outbox := map[string]any{"pending": n, "oldestSec": int64(age.Seconds())}
		if u, err := s.st.Unrouted(ctx); err == nil {
			outbox["unroutedLastDay"] = u
		}
		body["outbox"] = outbox
	}
	if e := s.wa.LastError(); e != "" {
		body["lastError"] = e
	}
	writeJSON(w, http.StatusOK, body)
}

// getOwner is the readiness probe: 200 only on the replica that owns the WhatsApp session, logged
// in or not (Swagger, /qr and /session/login must stay reachable while it is logged out), so the
// Service never routes a send to a standby.
func (s *Server) getOwner(w http.ResponseWriter, _ *http.Request) {
	if !s.health.Owner() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"owner": false, "whatsapp": s.wa.Status()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"owner": true, "whatsapp": s.wa.Status()})
}

func (s *Server) getReady(w http.ResponseWriter, _ *http.Request) {
	st := s.wa.Status()
	if !s.wa.Ready() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "not_ready", "whatsapp": st})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "whatsapp": st})
}

// ── session ─────────────────────────────────────────────────────────────────

func (s *Server) sessionState() map[string]any {
	st := map[string]any{"status": s.wa.Status(), "qrPending": s.wa.QR() != nil}
	if s.wa.QR() != nil {
		st["qrUrl"] = s.cfg.PathBase + "/qr"
	}
	return st
}

func (s *Server) getQR(w http.ResponseWriter, _ *http.Request) {
	png := s.wa.QR()
	if png == nil {
		writeErr(w, http.StatusNotFound, "QR_NOT_AVAILABLE", fmt.Sprintf("No QR pending (WhatsApp status: %s)", s.wa.Status()), nil)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(png)
}

func (s *Server) getSession(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.sessionState())
}

func (s *Server) postLogin(w http.ResponseWriter, r *http.Request) {
	if !s.ownerOr503(w) {
		return
	}
	if _, err := s.wa.Login(r.Context()); err != nil {
		s.log.Warn("Login did not start", "err", err)
	}
	writeJSON(w, http.StatusOK, s.sessionState())
}

func (s *Server) postLogout(w http.ResponseWriter, r *http.Request) {
	if !s.ownerOr503(w) {
		return
	}
	unlinked, err := s.wa.Logout(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	st := s.sessionState()
	st["deviceUnlinked"] = unlinked
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) getSessionQR(w http.ResponseWriter, r *http.Request) {
	if s.wa.QR() == nil {
		writeErr(w, http.StatusNotFound, "QR_NOT_AVAILABLE",
			fmt.Sprintf("No QR pending (WhatsApp status: %s). Call POST /session/login to start a session.", s.wa.Status()), nil)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, s.cfg.PathBase+"/qr", http.StatusFound)
}

// postPairCode is new in 2.0: link by a code typed on the phone instead of scanning the QR.
func (s *Server) postPairCode(w http.ResponseWriter, r *http.Request) {
	if !s.ownerOr503(w) {
		return
	}
	var body struct {
		PhoneNumber string `json:"phoneNumber"`
	}
	if !decode(w, r, &body) {
		return
	}
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, body.PhoneNumber)
	if len(digits) < 8 {
		validation(w, map[string]any{"body.phoneNumber": map[string]string{"message": "phone number in international format is required"}})
		return
	}
	code, err := s.wa.PairCode(r.Context(), digits)
	if err != nil {
		if errors.Is(err, wa.ErrNoPendingLogin) {
			writeErr(w, http.StatusConflict, "SESSION_LINKED", "The session is already linked or connecting; log out first.", nil)
			return
		}
		writeErr(w, http.StatusBadGateway, "WA_PAIR_FAILED", "Pairing code request failed: "+err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"code": code, "status": s.wa.Status()})
}

// ownerOr503 refuses session changes on a standby replica: only the owner holds the session.
func (s *Server) ownerOr503(w http.ResponseWriter) bool {
	if s.health.Owner() {
		return true
	}
	writeErr(w, http.StatusServiceUnavailable, "WA_NOT_READY", "This replica is on standby: another one owns the WhatsApp session.", nil)
	return false
}

// ── chats ───────────────────────────────────────────────────────────────────

func (s *Server) getChats(w http.ResponseWriter, r *http.Request) {
	list, err := s.wa.ListChats(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// ── messages ────────────────────────────────────────────────────────────────

type fileDTO struct {
	Base64   string `json:"base64"`
	Mimetype string `json:"mimetype"`
	Filename string `json:"filename"`
}

type sendBody struct {
	PhoneNumber     *string   `json:"phoneNumber"`
	ChatID          *string   `json:"chatId"`
	Message         string    `json:"message"`
	Files           []fileDTO `json:"files"`
	QuotedMessageID string    `json:"quotedMessageId"`
	IdempotencyKey  string    `json:"idempotencyKey"`
}

func (s *Server) postSend(w http.ResponseWriter, r *http.Request) {
	var b sendBody
	if !decode(w, r, &b) {
		return
	}
	if b.PhoneNumber == nil || strings.TrimSpace(*b.PhoneNumber) == "" {
		validation(w, map[string]any{"body.phoneNumber": map[string]string{"message": "'phoneNumber' is required"}})
		return
	}
	files, ok := decodeFiles(w, b.Files)
	if !ok {
		return
	}
	s.idempotent(w, r, b.IdempotencyKey, func(ctx context.Context) (wa.SendResult, error) {
		return s.wa.SendToNumber(ctx, *b.PhoneNumber, b.Message, files)
	})
}

func (s *Server) postChatSend(w http.ResponseWriter, r *http.Request) {
	var b sendBody
	if !decode(w, r, &b) {
		return
	}
	if b.ChatID == nil || strings.TrimSpace(*b.ChatID) == "" {
		validation(w, map[string]any{"body.chatId": map[string]string{"message": "'chatId' is required"}})
		return
	}
	files, ok := decodeFiles(w, b.Files)
	if !ok {
		return
	}
	s.idempotent(w, r, b.IdempotencyKey, func(ctx context.Context) (wa.SendResult, error) {
		return s.wa.SendToChat(ctx, *b.ChatID, b.Message, files, b.QuotedMessageID)
	})
}

func (s *Server) postSendWithFiles(w http.ResponseWriter, r *http.Request) {
	form, files, ok := s.multipart(w, r)
	if !ok {
		return
	}
	phone := form("phoneNumber")
	if phone == "" {
		validation(w, map[string]any{"phoneNumber": map[string]string{"message": "'phoneNumber' is required"}})
		return
	}
	s.idempotent(w, r, form("idempotencyKey"), func(ctx context.Context) (wa.SendResult, error) {
		return s.wa.SendToNumber(ctx, phone, form("message"), files)
	})
}

func (s *Server) postChatSendWithFiles(w http.ResponseWriter, r *http.Request) {
	form, files, ok := s.multipart(w, r)
	if !ok {
		return
	}
	chatID := form("chatId")
	if chatID == "" {
		validation(w, map[string]any{"chatId": map[string]string{"message": "'chatId' is required"}})
		return
	}
	s.idempotent(w, r, form("idempotencyKey"), func(ctx context.Context) (wa.SendResult, error) {
		return s.wa.SendToChat(ctx, chatID, form("message"), files, form("quotedMessageId"))
	})
}

func (s *Server) multipart(w http.ResponseWriter, r *http.Request) (func(string) string, []wa.Attachment, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	if err := r.ParseMultipartForm(maxBody); err != nil {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid multipart body: "+err.Error(), nil)
		return nil, nil, false
	}
	var out []wa.Attachment
	for _, fh := range r.MultipartForm.File["files"] {
		f, err := fh.Open()
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_ATTACHMENT", "Invalid attachment: "+err.Error(), nil)
			return nil, nil, false
		}
		data, err := io.ReadAll(f)
		_ = f.Close()
		if err != nil || len(data) == 0 {
			writeErr(w, http.StatusBadRequest, "BAD_ATTACHMENT", fmt.Sprintf("Invalid attachment: %s is empty", fh.Filename), nil)
			return nil, nil, false
		}
		out = append(out, wa.Attachment{Data: data, Mimetype: fh.Header.Get("Content-Type"), Filename: fh.Filename})
	}
	return func(k string) string { return strings.TrimSpace(r.FormValue(k)) }, out, true
}

func decodeFiles(w http.ResponseWriter, in []fileDTO) ([]wa.Attachment, bool) {
	out := make([]wa.Attachment, 0, len(in))
	for i, f := range in {
		raw := f.Base64
		if j := strings.Index(raw, ";base64,"); j >= 0 && strings.HasPrefix(raw, "data:") {
			raw = raw[j+len(";base64,"):]
		}
		data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
		if err != nil {
			data, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(strings.TrimSpace(raw), "="))
		}
		if err != nil {
			writeErr(w, http.StatusBadRequest, "BAD_ATTACHMENT", fmt.Sprintf("Invalid attachment: files[%d] is not valid base64", i), nil)
			return nil, false
		}
		if len(data) == 0 {
			writeErr(w, http.StatusBadRequest, "BAD_ATTACHMENT", fmt.Sprintf("Invalid attachment: files[%d] (%s) is empty", i, f.Filename), nil)
			return nil, false
		}
		out = append(out, wa.Attachment{Data: data, Mimetype: f.Mimetype, Filename: f.Filename})
	}
	return out, true
}

// idempotent runs send under the caller's key: an unseen key dispatches (202), a key that already
// succeeded replays its result (200, deduplicated), a key still in flight is refused (409).
// A key whose send fails is released, so the retry goes through.
func (s *Server) idempotent(w http.ResponseWriter, r *http.Request, rawKey string, send func(context.Context) (wa.SendResult, error)) {
	key := strings.TrimSpace(rawKey)
	// Once started, a send runs to the end even if the caller hangs up: WhatsApp may already have the
	// message, and a cancelled send would release the key and let the retry deliver it twice.
	sendCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 3*time.Minute)
	defer cancel()
	if key == "" {
		res, err := send(sendCtx)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		writeJSON(w, http.StatusAccepted, res)
		return
	}
	prev, err := s.st.ClaimKey(r.Context(), key, s.cfg.InFlightTimeout)
	switch {
	case errors.Is(err, store.ErrInFlight):
		writeErr(w, http.StatusConflict, "WA_SEND_IN_FLIGHT",
			fmt.Sprintf("A send with idempotency key '%s' is already in progress. Retry once it settles.", key), nil)
		return
	case err != nil:
		s.fail(w, r, err)
		return
	case prev != nil:
		writeJSON(w, http.StatusOK, wa.SendResult{Success: true, ChatID: prev.Chat, SentMessages: prev.SentMessages,
			MessageID: prev.MessageID, Deduplicated: true})
		return
	}
	res, err := send(sendCtx)
	if err != nil {
		if rerr := s.st.ReleaseKey(context.WithoutCancel(r.Context()), key); rerr != nil {
			s.log.Warn("Idempotency key not released", "key", key, "err", rerr)
		}
		s.fail(w, r, err)
		return
	}
	if err := s.st.CompleteKey(context.WithoutCancel(r.Context()), key, store.CompletedSend{
		Chat: res.ChatID, SentMessages: res.SentMessages, MessageID: res.MessageID,
	}); err != nil {
		s.log.Error("Send delivered but its idempotency key was not recorded", "key", key, "err", err)
	}
	writeJSON(w, http.StatusAccepted, res)
}

// fail maps an error to the 1.x code.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var se *wa.SendError
	switch {
	case errors.Is(err, wa.ErrNotLoggedIn), errors.Is(err, wa.ErrNotStarted):
		writeErr(w, http.StatusServiceUnavailable, "WA_NOT_LOGGED_IN", fmt.Sprintf(
			"WhatsApp is not logged in (status: %s). Call POST /session/login and scan the QR at GET /session/qr.", s.wa.Status()), nil)
	case errors.Is(err, wa.ErrNotReady):
		writeErr(w, http.StatusServiceUnavailable, "WA_NOT_READY", fmt.Sprintf(
			"WhatsApp client is not connected (status: %s). Wait for reconnection.", s.wa.Status()), nil)
	case errors.Is(err, wa.ErrInvalidChatID):
		writeErr(w, http.StatusUnprocessableEntity, "WA_CHAT_ID_INVALID",
			"Not a WhatsApp chat id. Expected '<id>@c.us' (one-to-one), '<id>@g.us' (group), '<id>@lid', '<id>@newsletter' or '<id>@broadcast'.", nil)
	case errors.Is(err, wa.ErrNumberNotFound):
		writeErr(w, http.StatusNotFound, "WA_NUMBER_NOT_FOUND", "Phone number is not registered on WhatsApp", nil)
	case errors.Is(err, wa.ErrChatNotFound):
		writeErr(w, http.StatusNotFound, "WA_CHAT_NOT_FOUND", "Chat is not available to the linked WhatsApp account", nil)
	case errors.Is(err, wa.ErrBadAttachment):
		writeErr(w, http.StatusBadRequest, "BAD_ATTACHMENT", "Invalid attachment: "+err.Error(), nil)
	case errors.Is(err, wa.ErrEmptyMessage):
		validation(w, map[string]any{"body.message": map[string]string{"message": "'message' or at least one file is required"}})
	case errors.As(err, &se):
		s.log.Warn("Send failed", "path", r.URL.Path, "err", err)
		writeErr(w, http.StatusBadGateway, "WA_SEND_FAILED", "Failed to send WhatsApp message: "+err.Error(), nil)
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		writeErr(w, http.StatusServiceUnavailable, "WA_NOT_READY", "Request cancelled before WhatsApp answered.", nil)
	default:
		s.log.Error("Unhandled error", "method", r.Method, "path", r.URL.Path, "err", err)
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error", nil)
	}
}

// ── plumbing ────────────────────────────────────────────────────────────────

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeErr(w, http.StatusRequestEntityTooLarge, "BAD_REQUEST", "request entity too large", nil)
			return false
		}
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid JSON body: "+err.Error(), nil)
		return false
	}
	return true
}

func validation(w http.ResponseWriter, details any) {
	writeErr(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Validation failed", details)
}

func writeErr(w http.ResponseWriter, status int, code, msg string, details any) {
	body := map[string]any{"message": msg, "code": code}
	if details != nil {
		body["details"] = details
	}
	writeJSON(w, status, body)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func swaggerAssets() fs.FS { return swaggerFiles.FS }

func (s *Server) getDocs(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, `<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp API Gateway</title>
<link rel="stylesheet" href="swagger-ui.css"></head><body><div id="swagger-ui"></div>
<script src="swagger-ui-bundle.js"></script><script src="swagger-ui-standalone-preset.js"></script>
<script src="init.js"></script></body></html>`)
}

// specFor sets servers to PATH_BASE so "Try it out" targets the right URL, and the version.
func specFor(base, version string) []byte {
	var doc map[string]any
	if err := json.Unmarshal(openapiSpec, &doc); err != nil {
		return openapiSpec
	}
	if info, ok := doc["info"].(map[string]any); ok {
		info["version"] = version
	}
	if base != "" {
		doc["servers"] = []map[string]string{{"url": base}}
	}
	out, err := json.Marshal(doc)
	if err != nil {
		return openapiSpec
	}
	return out
}
