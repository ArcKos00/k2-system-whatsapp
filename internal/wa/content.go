package wa

import (
	"bytes"
	"mime"
	"net/http"
	"path/filepath"
	"strings"

	"go.mau.fi/whatsmeow/proto/waE2E"
)

// content is what an event says about a message: whatsapp-web.js's `type`, `body` and
// `hasMedia`, so consumers written against 1.x read 2.0 events the same way.
type content struct {
	Type     string
	Body     string
	HasMedia bool
}

// describe maps a decrypted message to its 1.x description. ok is false for messages 1.x never
// published as a `message` event: reactions, poll votes, key distribution, protocol messages,
// pins and the like.
func describe(m *waE2E.Message) (c content, ok bool) {
	if m == nil {
		return c, false
	}
	switch {
	case m.Conversation != nil:
		return content{Type: "chat", Body: m.GetConversation()}, true
	case m.ExtendedTextMessage != nil:
		return content{Type: "chat", Body: m.GetExtendedTextMessage().GetText()}, true
	case m.ImageMessage != nil:
		return content{Type: "image", Body: m.GetImageMessage().GetCaption(), HasMedia: true}, true
	case m.VideoMessage != nil:
		return content{Type: "video", Body: m.GetVideoMessage().GetCaption(), HasMedia: true}, true
	case m.PtvMessage != nil:
		return content{Type: "video", Body: m.GetPtvMessage().GetCaption(), HasMedia: true}, true
	case m.AudioMessage != nil:
		t := "audio"
		if m.GetAudioMessage().GetPTT() {
			t = "ptt"
		}
		return content{Type: t, HasMedia: true}, true
	case m.DocumentMessage != nil:
		return content{Type: "document", Body: m.GetDocumentMessage().GetCaption(), HasMedia: true}, true
	case m.StickerMessage != nil:
		return content{Type: "sticker", HasMedia: true}, true
	case m.LocationMessage != nil:
		l := m.GetLocationMessage()
		return content{Type: "location", Body: firstNonEmpty(l.GetComment(), l.GetName(), l.GetAddress())}, true
	case m.LiveLocationMessage != nil:
		return content{Type: "location", Body: m.GetLiveLocationMessage().GetCaption()}, true
	case m.ContactMessage != nil:
		return content{Type: "vcard", Body: m.GetContactMessage().GetVcard()}, true
	case m.ContactsArrayMessage != nil:
		var cards []string
		for _, c := range m.GetContactsArrayMessage().GetContacts() {
			cards = append(cards, c.GetVcard())
		}
		return content{Type: "multi_vcard", Body: strings.Join(cards, "\n")}, true
	case m.PollCreationMessage != nil:
		return content{Type: "poll_creation", Body: m.GetPollCreationMessage().GetName()}, true
	case m.PollCreationMessageV2 != nil:
		return content{Type: "poll_creation", Body: m.GetPollCreationMessageV2().GetName()}, true
	case m.PollCreationMessageV3 != nil:
		return content{Type: "poll_creation", Body: m.GetPollCreationMessageV3().GetName()}, true
	case m.ButtonsResponseMessage != nil:
		return content{Type: "buttons_response", Body: m.GetButtonsResponseMessage().GetSelectedDisplayText()}, true
	case m.ListResponseMessage != nil:
		return content{Type: "list_response", Body: m.GetListResponseMessage().GetTitle()}, true
	case m.TemplateButtonReplyMessage != nil:
		return content{Type: "template_button_reply", Body: m.GetTemplateButtonReplyMessage().GetSelectedDisplayText()}, true
	case m.GroupInviteMessage != nil:
		return content{Type: "groups_v4_invite", Body: m.GetGroupInviteMessage().GetCaption()}, true
	case m.EventMessage != nil:
		return content{Type: "event_creation", Body: m.GetEventMessage().GetName()}, true
	}
	return c, false
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// mediaKind is how an attachment goes out.
type mediaKind int

const (
	kindDocument mediaKind = iota
	kindImage
	kindVideo
	kindAudio
)

// inline types render as a picture or a player in the chat; everything else, GIF included, goes as
// a document (1.x behaviour).
var inlineKinds = map[string]mediaKind{
	"image/jpeg": kindImage,
	"image/png":  kindImage,
	"image/webp": kindImage,
	"video/mp4":  kindVideo,
	"video/3gpp": kindVideo,
}

// detectMedia settles an attachment's mimetype and how it is sent. The first bytes have the final
// say over the declared type (a video saved as .jpeg goes out as a video); a generic
// application/octet-stream is replaced by what the extension implies.
func detectMedia(declared, filename string, data []byte) (string, mediaKind) {
	mt := strings.ToLower(strings.TrimSpace(declared))
	if i := strings.IndexByte(mt, ';'); i >= 0 && !strings.HasPrefix(mt, "audio/ogg") {
		mt = strings.TrimSpace(mt[:i])
	}
	if mt == "" || mt == "application/octet-stream" {
		if byExt := mime.TypeByExtension(strings.ToLower(filepath.Ext(filename))); byExt != "" {
			mt = strings.SplitN(byExt, ";", 2)[0]
		}
	}
	if sniffed := sniff(data); sniffed != "" && sniffed != mt {
		_, sniffedInline := inlineKinds[sniffed]
		_, declaredInline := inlineKinds[mt]
		switch {
		case sniffedInline || strings.HasPrefix(sniffed, "audio/"):
			// Trust the content for the families rendered inline.
			mt = sniffed
		case declaredInline:
			// Declared as a photo or video but it is not one: send it as what it is.
			mt = sniffed
		}
	}
	if mt == "" {
		mt = "application/octet-stream"
	}
	if k, ok := inlineKinds[mt]; ok {
		return mt, k
	}
	if strings.HasPrefix(mt, "audio/") {
		return mt, kindAudio
	}
	return mt, kindDocument
}

func sniff(data []byte) string {
	if len(data) >= 12 {
		switch {
		case bytes.HasPrefix(data, []byte("OggS")):
			return "audio/ogg; codecs=opus"
		case bytes.Equal(data[4:8], []byte("ftyp")):
			brand := string(data[8:12])
			if strings.HasPrefix(brand, "3g") {
				return "video/3gpp"
			}
			if brand == "M4A " {
				return "audio/mp4"
			}
			return "video/mp4"
		case bytes.HasPrefix(data, []byte("ID3")) || (data[0] == 0xFF && data[1]&0xE0 == 0xE0):
			return "audio/mpeg"
		}
	}
	got := strings.SplitN(http.DetectContentType(data), ";", 2)[0]
	if got == "application/octet-stream" || strings.HasPrefix(got, "text/plain") {
		return ""
	}
	return got
}
