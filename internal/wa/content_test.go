package wa

import (
	"bytes"
	"image"
	"image/png"
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

func TestDescribe(t *testing.T) {
	cases := []struct {
		name string
		msg  *waE2E.Message
		want content
		ok   bool
	}{
		{"text", &waE2E.Message{Conversation: proto.String("Привіт")}, content{Type: "chat", Body: "Привіт"}, true},
		{"extended", &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("reply")}}, content{Type: "chat", Body: "reply"}, true},
		{"image", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Caption: proto.String("фото")}}, content{Type: "image", Body: "фото", HasMedia: true}, true},
		{"voice", &waE2E.Message{AudioMessage: &waE2E.AudioMessage{PTT: proto.Bool(true)}}, content{Type: "ptt", HasMedia: true}, true},
		{"document", &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{}}, content{Type: "document", HasMedia: true}, true},
		{"location", &waE2E.Message{LocationMessage: &waE2E.LocationMessage{Name: proto.String("Позиція")}}, content{Type: "location", Body: "Позиція"}, true},
		{"reaction is not a message", &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Text: proto.String("👍")}}, content{}, false},
		{"protocol is not a message", &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{}}, content{}, false},
		{"nil", nil, content{}, false},
	}
	for _, c := range cases {
		got, ok := describe(c.msg)
		if ok != c.ok || got != c.want {
			t.Errorf("%s: describe = %+v %v, want %+v %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func pngBytes(t *testing.T) []byte {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 200, 100))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestDetectMedia(t *testing.T) {
	pngData := pngBytes(t)
	mp4 := append([]byte{0, 0, 0, 0x18}, []byte("ftypisom\x00\x00\x00\x00")...)
	pdf := []byte("%PDF-1.7\n%âãÏÓ\n1 0 obj")
	ogg := []byte("OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00")
	cases := []struct {
		name, mt, file string
		data           []byte
		wantMT         string
		wantKind       mediaKind
	}{
		{"png inline", "image/png", "a.png", pngData, "image/png", kindImage},
		{"octet-stream by extension", "application/octet-stream", "doc.pdf", pdf, "application/pdf", kindDocument},
		{"video named jpeg", "image/jpeg", "clip.jpeg", mp4, "video/mp4", kindVideo},
		{"html saved as jpeg goes as a document", "image/jpeg", "err.jpeg", []byte("<!DOCTYPE html><html><body>502</body></html>"), "text/html", kindDocument},
		{"voice note", "audio/ogg", "v.ogg", ogg, "audio/ogg; codecs=opus", kindAudio},
		{"gif stays a document", "image/gif", "a.gif", []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), "image/gif", kindDocument},
		{"office file keeps its type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx", []byte("PK\x03\x04\x14\x00\x06\x00"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kindDocument},
	}
	for _, c := range cases {
		mt, k := detectMedia(c.mt, c.file, c.data)
		if mt != c.wantMT || k != c.wantKind {
			t.Errorf("%s: detectMedia = %q %v, want %q %v", c.name, mt, k, c.wantMT, c.wantKind)
		}
	}
}

func TestThumbnail(t *testing.T) {
	thumb, w, h, ok := thumbnail(pngBytes(t))
	if !ok || w != 200 || h != 100 || len(thumb) == 0 {
		t.Fatalf("thumbnail = %d bytes %dx%d %v", len(thumb), w, h, ok)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(thumb))
	if err != nil || cfg.Width != 72 || cfg.Height != 36 {
		t.Fatalf("thumb %+v %v", cfg, err)
	}
	if _, _, _, ok := thumbnail([]byte("not an image")); ok {
		t.Fatal("garbage accepted")
	}
}
