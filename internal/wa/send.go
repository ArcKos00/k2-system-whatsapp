package wa

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png" // decoders for thumbnails
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"

	"github.com/TacticalDevsBattalion/k2-system-whatsapp/internal/ids"
	"github.com/TacticalDevsBattalion/k2-system-whatsapp/internal/store"
)

// Attachment is one file to send.
type Attachment struct {
	Data     []byte
	Mimetype string
	Filename string
}

// SendResult is the 1.x SendMessageResponse.
type SendResult struct {
	Success      bool   `json:"success"`
	ChatID       string `json:"chatId"`
	SentMessages int    `json:"sentMessages"`
	MessageID    string `json:"messageId,omitempty"`
	Deduplicated bool   `json:"deduplicated,omitempty"`
}

// Errors the API turns into the 1.x error codes.
var (
	ErrNotLoggedIn    = errors.New("whatsapp not logged in")
	ErrNotReady       = errors.New("whatsapp not ready")
	ErrNumberNotFound = errors.New("number not on whatsapp")
	ErrChatNotFound   = errors.New("chat not available")
	ErrInvalidChatID  = ids.ErrInvalidChatID
	ErrBadAttachment  = errors.New("bad attachment")
	ErrEmptyMessage   = errors.New("nothing to send")
)

// SendError wraps a failed dispatch (502 WA_SEND_FAILED).
type SendError struct{ Err error }

func (e *SendError) Error() string { return e.Err.Error() }
func (e *SendError) Unwrap() error { return e.Err }

func (m *Manager) requireReady() (*whatsmeow.Client, error) {
	cli := m.cli()
	if cli == nil || cli.Store.ID == nil {
		return nil, ErrNotLoggedIn
	}
	if !m.Ready() {
		return nil, ErrNotReady
	}
	return cli, nil
}

// SendToNumber sends to a phone number (POST /messages/send*).
func (m *Manager) SendToNumber(ctx context.Context, phone, text string, files []Attachment) (SendResult, error) {
	cli, err := m.requireReady()
	if err != nil {
		return SendResult{}, err
	}
	jid, _, ok := ids.PhoneNumberJID(phone)
	if !ok {
		return SendResult{}, ErrNumberNotFound
	}
	jid, err = m.registered(ctx, cli, jid)
	if err != nil {
		return SendResult{}, err
	}
	return m.dispatch(ctx, cli, jid, ids.FromJID(jid), text, files, "")
}

// SendToChat sends to a chat id (POST /messages/chat/send*), optionally as a reply.
func (m *Manager) SendToChat(ctx context.Context, chatID, text string, files []Attachment, quoted string) (SendResult, error) {
	norm, err := ids.NormalizeChatID(chatID)
	if err != nil {
		return SendResult{}, err
	}
	cli, err := m.requireReady()
	if err != nil {
		return SendResult{}, err
	}
	jid, _ := ids.ToJID(norm)
	switch jid.Server {
	case types.GroupServer:
		if _, err := m.groups.get(ctx, cli, jid); err != nil {
			return SendResult{}, ErrChatNotFound
		}
	case types.DefaultUserServer:
		// A @c.us id the account never talked to still goes out if the number is on WhatsApp.
		if jid, err = m.registered(ctx, cli, jid); err != nil {
			if errors.Is(err, ErrNumberNotFound) {
				return SendResult{}, ErrChatNotFound
			}
			return SendResult{}, err
		}
	}
	return m.dispatch(ctx, cli, jid, norm, text, files, quoted)
}

func (m *Manager) registered(ctx context.Context, cli *whatsmeow.Client, jid types.JID) (types.JID, error) {
	res, err := cli.IsOnWhatsApp(ctx, []string{"+" + jid.User})
	if err != nil {
		if errors.Is(err, whatsmeow.ErrNotConnected) || errors.Is(err, whatsmeow.ErrNotLoggedIn) {
			return jid, ErrNotReady
		}
		return jid, &SendError{fmt.Errorf("number check: %w", err)}
	}
	if len(res) == 0 || !res[0].IsIn {
		return jid, ErrNumberNotFound
	}
	return res[0].JID.ToNonAD(), nil
}

// throttle keeps WHATSAPP_MESSAGE_DELAY_MS between sends, across all callers.
func (m *Manager) throttle(ctx context.Context) error {
	wait := time.Until(m.lastSend.Add(m.cfg.MessageDelay))
	if wait <= 0 {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(wait):
		return nil
	}
}

func (m *Manager) dispatch(ctx context.Context, cli *whatsmeow.Client, to types.JID, chat, text string, files []Attachment, quoted string) (SendResult, error) {
	if text == "" && len(files) == 0 {
		return SendResult{}, ErrEmptyMessage
	}
	for _, f := range files {
		if len(f.Data) == 0 {
			return SendResult{}, fmt.Errorf("%w: %s is empty", ErrBadAttachment, f.Filename)
		}
	}
	m.sendMu.Lock()
	defer m.sendMu.Unlock()

	ctxInfo := m.quoteContext(ctx, cli, chat, quoted)
	res := SendResult{Success: true, ChatID: chat}
	type outgoing struct {
		msg  *waE2E.Message
		alt  func() (*waE2E.Message, error) // fallback: the same file as a document
		kind string
	}
	var queue []outgoing
	if len(files) == 0 {
		queue = append(queue, outgoing{msg: textMessage(text, ctxInfo), kind: "chat"})
	}
	for i, f := range files {
		caption := ""
		var ci *waE2E.ContextInfo
		if i == 0 {
			caption, ci = text, ctxInfo
		}
		msg, kind, err := m.mediaMessage(ctx, cli, f, caption, ci, false)
		if err != nil {
			return res, &SendError{err}
		}
		f, caption, ci := f, caption, ci
		o := outgoing{msg: msg, kind: kind}
		if kind != "document" {
			o.alt = func() (*waE2E.Message, error) {
				msg, _, err := m.mediaMessage(ctx, cli, f, caption, ci, true)
				return msg, err
			}
		}
		queue = append(queue, o)
	}

	for i, o := range queue {
		if err := m.throttle(ctx); err != nil {
			return res, err
		}
		resp, err := cli.SendMessage(ctx, to, o.msg)
		if err != nil && i == 0 && ctxInfo != nil {
			// The message counts for more than the quote (1.x): send it unquoted.
			m.log.Warn("Quoted send failed; sending without the quote", "chatId", chat, "err", err)
			stripQuote(o.msg)
			resp, err = cli.SendMessage(ctx, to, o.msg)
		}
		if err != nil && o.alt != nil {
			m.log.Warn("Inline media refused; re-sending as a document", "chatId", chat, "kind", o.kind, "err", err)
			if alt, aerr := o.alt(); aerr == nil {
				o.msg = alt
				resp, err = cli.SendMessage(ctx, to, alt)
			}
		}
		m.lastSend = time.Now()
		if err != nil {
			if res.SentMessages > 0 {
				m.log.Warn("Send stopped part way; the caller's retry re-sends the whole message (at-least-once)",
					"chatId", chat, "sent", res.SentMessages, "of", len(queue))
			}
			if errors.Is(err, whatsmeow.ErrNotLoggedIn) || errors.Is(err, whatsmeow.ErrNotConnected) {
				return res, ErrNotReady
			}
			return res, &SendError{err}
		}
		res.SentMessages++
		key := ids.MessageKey{FromMe: true, Chat: chat, ID: resp.ID}
		if to.Server == types.GroupServer || to.Server == types.BroadcastServer {
			key.Participant = ids.FromJID(cli.Store.ID.ToNonAD())
		}
		if i == 0 {
			res.MessageID = key.String()
		}
		m.recordSent(ctx, cli, chat, resp, o.msg)
	}
	m.log.Info("Message sent", "chatId", chat, "messages", res.SentMessages, "messageId", res.MessageID)
	return res, nil
}

func (m *Manager) recordSent(ctx context.Context, cli *whatsmeow.Client, chat string, resp whatsmeow.SendResponse, msg *waE2E.Message) {
	c, _ := describe(msg)
	raw, _ := proto.Marshal(msg)
	body := c.Body
	err := m.st.SaveSent(ctx, store.Message{
		Chat: chat, ID: resp.ID, Sender: ids.FromJID(cli.Store.ID.ToNonAD()), Time: resp.Timestamp,
		Type: c.Type, Body: &body, HasMedia: c.HasMedia, Raw: raw,
	})
	if err != nil {
		m.log.Warn("Sent message not recorded (replies to it will go unquoted)", "chatId", chat, "id", resp.ID, "err", err)
	}
}

// quoteContext builds the reply context for quotedMessageId, or nil when the message cannot be
// found — the send then goes out unquoted, as in 1.x.
func (m *Manager) quoteContext(ctx context.Context, cli *whatsmeow.Client, chat, quoted string) *waE2E.ContextInfo {
	if quoted == "" {
		return nil
	}
	if ids.KindOf(chat) == ids.KindChannel {
		return nil
	}
	key, ok := ids.ParseMessageKey(quoted)
	if !ok {
		m.log.Warn("quotedMessageId is not a message id; sending unquoted", "quotedMessageId", quoted)
		return nil
	}
	rec, err := m.st.FindMessage(ctx, chat, key.ID)
	if err != nil {
		m.log.Warn("Quoted message not known to this gateway; sending unquoted", "chatId", chat, "quotedMessageId", quoted)
		return nil
	}
	var q waE2E.Message
	if len(rec.Raw) > 0 {
		_ = proto.Unmarshal(rec.Raw, &q)
	}
	sender := rec.Sender
	if rec.FromMe {
		sender = ids.FromJID(cli.Store.ID.ToNonAD())
	}
	participant, err := ids.ToJID(sender)
	if err != nil {
		return nil
	}
	return &waE2E.ContextInfo{
		StanzaID:      proto.String(rec.ID),
		Participant:   proto.String(participant.String()),
		QuotedMessage: &q,
	}
}

func textMessage(text string, ci *waE2E.ContextInfo) *waE2E.Message {
	if ci == nil {
		return &waE2E.Message{Conversation: proto.String(text)}
	}
	return &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(text), ContextInfo: ci}}
}

func stripQuote(msg *waE2E.Message) {
	if t := msg.GetExtendedTextMessage(); t != nil {
		msg.Conversation, msg.ExtendedTextMessage = t.Text, nil
	}
	if v := msg.GetImageMessage(); v != nil {
		v.ContextInfo = nil
	}
	if v := msg.GetVideoMessage(); v != nil {
		v.ContextInfo = nil
	}
	if v := msg.GetAudioMessage(); v != nil {
		v.ContextInfo = nil
	}
	if v := msg.GetDocumentMessage(); v != nil {
		v.ContextInfo = nil
	}
}

// mediaMessage uploads f and builds the message. asDocument forces the document form.
func (m *Manager) mediaMessage(ctx context.Context, cli *whatsmeow.Client, f Attachment, caption string, ci *waE2E.ContextInfo, asDocument bool) (*waE2E.Message, string, error) {
	mt, kind := detectMedia(f.Mimetype, f.Filename, f.Data)
	if asDocument {
		kind = kindDocument
	}
	appInfo := map[mediaKind]whatsmeow.MediaType{
		kindImage: whatsmeow.MediaImage, kindVideo: whatsmeow.MediaVideo,
		kindAudio: whatsmeow.MediaAudio, kindDocument: whatsmeow.MediaDocument,
	}[kind]
	up, err := cli.Upload(ctx, f.Data, appInfo)
	if err != nil {
		return nil, "", fmt.Errorf("upload %s: %w", f.Filename, err)
	}
	var capt *string
	if caption != "" {
		capt = proto.String(caption)
	}
	switch kind {
	case kindImage:
		img := &waE2E.ImageMessage{
			Caption: capt, Mimetype: proto.String(mt), URL: &up.URL, DirectPath: &up.DirectPath,
			MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256,
			FileLength: proto.Uint64(up.FileLength), ContextInfo: ci,
		}
		if thumb, w, h, ok := thumbnail(f.Data); ok {
			img.JPEGThumbnail, img.Width, img.Height = thumb, proto.Uint32(w), proto.Uint32(h)
		}
		return &waE2E.Message{ImageMessage: img}, "image", nil
	case kindVideo:
		return &waE2E.Message{VideoMessage: &waE2E.VideoMessage{
			Caption: capt, Mimetype: proto.String(mt), URL: &up.URL, DirectPath: &up.DirectPath,
			MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256,
			FileLength: proto.Uint64(up.FileLength), ContextInfo: ci,
		}}, "video", nil
	case kindAudio:
		// Audio carries no caption in WhatsApp; the text goes on as its own message is not 1.x
		// behaviour either, so a caption on audio is dropped like whatsapp-web.js did.
		return &waE2E.Message{AudioMessage: &waE2E.AudioMessage{
			Mimetype: proto.String(mt), URL: &up.URL, DirectPath: &up.DirectPath,
			MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256,
			FileLength: proto.Uint64(up.FileLength), ContextInfo: ci,
		}}, "audio", nil
	}
	name := f.Filename
	if name == "" {
		name = "file"
	}
	return &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
		Caption: capt, Title: proto.String(name), FileName: proto.String(name), Mimetype: proto.String(mt),
		URL: &up.URL, DirectPath: &up.DirectPath, MediaKey: up.MediaKey, FileEncSHA256: up.FileEncSHA256,
		FileSHA256: up.FileSHA256, FileLength: proto.Uint64(up.FileLength), ContextInfo: ci,
	}}, "document", nil
}

// thumbnail renders a small JPEG preview (WhatsApp shows it until the photo downloads).
func thumbnail(data []byte) ([]byte, uint32, uint32, bool) {
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0, false
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w == 0 || h == 0 {
		return nil, 0, 0, false
	}
	const edge = 72
	tw, th := edge, edge*h/w
	if h > w {
		tw, th = edge*w/h, edge
	}
	tw, th = max(tw, 1), max(th, 1)
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	for y := 0; y < th; y++ {
		for x := 0; x < tw; x++ {
			dst.Set(x, y, src.At(b.Min.X+x*w/tw, b.Min.Y+y*h/th))
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 60}); err != nil {
		return nil, 0, 0, false
	}
	return buf.Bytes(), uint32(w), uint32(h), true
}
