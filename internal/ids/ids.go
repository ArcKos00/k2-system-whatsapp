// Package ids translates between the ids the gateway's callers know (whatsapp-web.js spelling,
// kept from 1.x) and whatsmeow's JIDs.
//
// Callers, the forward allowlist and every published event speak the 1.x dialect:
//
//   - one-to-one chats are <number>@c.us (whatsmeow: <number>@s.whatsapp.net);
//   - groups <id>@g.us, channels <id>@newsletter, broadcasts status@broadcast — unchanged;
//   - linked identities <lid>@lid — used only when no phone number is known for them;
//   - message ids are whatsapp-web.js serialized keys: <fromMe>_<chat>_<stanzaId>[_<participant>].
//
// Keeping the dialect is what lets kk-report, kk-charity, alert-notifier and report-parser move
// to 2.0.0 without a change.
package ids

import (
	"errors"
	"regexp"
	"strings"

	"go.mau.fi/whatsmeow/types"
)

// ErrInvalidChatID is returned for anything that is not a WhatsApp chat id.
var ErrInvalidChatID = errors.New("invalid chat id")

var (
	reGroupBare = regexp.MustCompile(`^\d+-\d+$`)
	reNumber    = regexp.MustCompile(`^\d{5,}$`)
	reUser      = regexp.MustCompile(`^\d+(-\d+)?$`)
)

// Kind of thread an id points at, as GET /chats reports it.
type Kind string

const (
	KindGroup     Kind = "group"
	KindPrivate   Kind = "private"
	KindLID       Kind = "lid"
	KindChannel   Kind = "channel"
	KindBroadcast Kind = "broadcast"
	KindUnknown   Kind = "unknown"
)

// NormalizeChatID applies the 1.x rules: a bare number is <number>@c.us, a bare <a>-<b> is
// <a>-<b>@g.us, s.whatsapp.net is accepted as c.us. It returns the id in the 1.x dialect.
func NormalizeChatID(raw string) (string, error) {
	t := strings.TrimSpace(raw)
	if t == "" {
		return "", ErrInvalidChatID
	}
	at := strings.LastIndexByte(t, '@')
	if at < 0 {
		switch {
		case reGroupBare.MatchString(t):
			return t + "@g.us", nil
		case reNumber.MatchString(t):
			return t + "@c.us", nil
		}
		return "", ErrInvalidChatID
	}
	user, server := t[:at], strings.ToLower(t[at+1:])
	if server == types.DefaultUserServer {
		server = types.LegacyUserServer
	}
	switch server {
	case types.LegacyUserServer, types.GroupServer, types.HiddenUserServer, types.NewsletterServer, types.BroadcastServer:
	default:
		return "", ErrInvalidChatID
	}
	if user == "" || (server != types.BroadcastServer && !reUser.MatchString(user)) {
		return "", ErrInvalidChatID
	}
	return user + "@" + server, nil
}

// ToJID turns a 1.x-dialect chat id into a whatsmeow JID.
func ToJID(chatID string) (types.JID, error) {
	norm, err := NormalizeChatID(chatID)
	if err != nil {
		return types.JID{}, err
	}
	at := strings.LastIndexByte(norm, '@')
	user, server := norm[:at], norm[at+1:]
	if server == types.LegacyUserServer {
		server = types.DefaultUserServer
	}
	return types.NewJID(user, server), nil
}

// FromJID writes a JID in the 1.x dialect. The device part is dropped: a chat is a user, not
// one of their devices.
func FromJID(j types.JID) string {
	if j.IsEmpty() {
		return ""
	}
	server := j.Server
	if server == types.DefaultUserServer {
		server = types.LegacyUserServer
	}
	return j.User + "@" + server
}

// PhoneNumberJID builds <digits>@s.whatsapp.net from a phone number written any way a person
// would write it ("+380 50 123-45-67").
func PhoneNumberJID(phone string) (types.JID, string, bool) {
	var b strings.Builder
	for _, r := range phone {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	digits := b.String()
	if len(digits) < 5 {
		return types.JID{}, digits, false
	}
	return types.NewJID(digits, types.DefaultUserServer), digits, true
}

// KindOf reads the kind of thread off a 1.x-dialect id.
func KindOf(chatID string) Kind {
	at := strings.LastIndexByte(chatID, '@')
	if at < 0 {
		return KindUnknown
	}
	switch chatID[at+1:] {
	case types.GroupServer:
		return KindGroup
	case types.LegacyUserServer, types.DefaultUserServer:
		return KindPrivate
	case types.HiddenUserServer:
		return KindLID
	case types.NewsletterServer:
		return KindChannel
	case types.BroadcastServer:
		return KindBroadcast
	}
	return KindUnknown
}

// UserPart is what is left of an id once its server is cut off.
func UserPart(chatID string) string {
	if at := strings.LastIndexByte(chatID, '@'); at >= 0 {
		return chatID[:at]
	}
	return chatID
}

// MessageKey is a message id in the whatsapp-web.js shape.
type MessageKey struct {
	FromMe bool
	// Chat in the 1.x dialect.
	Chat string
	// ID is WhatsApp's stanza id.
	ID string
	// Participant in the 1.x dialect: the author inside a group, or empty.
	Participant string
}

// String serializes the key the way whatsapp-web.js does (`_serialized`).
func (k MessageKey) String() string {
	var b strings.Builder
	if k.FromMe {
		b.WriteString("true_")
	} else {
		b.WriteString("false_")
	}
	b.WriteString(k.Chat)
	b.WriteByte('_')
	b.WriteString(k.ID)
	if k.Participant != "" {
		b.WriteByte('_')
		b.WriteString(k.Participant)
	}
	return b.String()
}

// ParseMessageKey reads a serialized key. A bare stanza id (no underscores) is accepted too, with
// Chat and Participant left empty for the caller to fill in.
func ParseMessageKey(raw string) (MessageKey, bool) {
	t := strings.TrimSpace(raw)
	if t == "" {
		return MessageKey{}, false
	}
	parts := strings.Split(t, "_")
	if len(parts) == 1 {
		return MessageKey{ID: parts[0]}, true
	}
	if len(parts) < 3 || len(parts) > 4 || (parts[0] != "true" && parts[0] != "false") {
		return MessageKey{}, false
	}
	k := MessageKey{FromMe: parts[0] == "true", Chat: parts[1], ID: parts[2]}
	if len(parts) == 4 {
		k.Participant = parts[3]
	}
	if k.ID == "" || k.Chat == "" {
		return MessageKey{}, false
	}
	return k, true
}
