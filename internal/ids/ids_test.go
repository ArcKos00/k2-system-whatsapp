package ids

import (
	"testing"

	"go.mau.fi/whatsmeow/types"
)

func TestNormalizeChatID(t *testing.T) {
	cases := map[string]string{
		"380500000000":                  "380500000000@c.us",
		" 380500000000@c.us ":           "380500000000@c.us",
		"380500000000@s.whatsapp.net":   "380500000000@c.us",
		"120363000000000000@g.us":       "120363000000000000@g.us",
		"380500000000-1600000000":       "380500000000-1600000000@g.us",
		"123456789012345@lid":           "123456789012345@lid",
		"120363000000000001@newsletter": "120363000000000001@newsletter",
		"status@broadcast":              "status@broadcast",
		"120363000000000000@G.US":       "120363000000000000@g.us",
	}
	for in, want := range cases {
		got, err := NormalizeChatID(in)
		if err != nil || got != want {
			t.Errorf("NormalizeChatID(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "abc", "123", "abc@c.us", "380500000000@example.com", "@g.us"} {
		if _, err := NormalizeChatID(bad); err == nil {
			t.Errorf("NormalizeChatID(%q) accepted", bad)
		}
	}
}

func TestJIDRoundTrip(t *testing.T) {
	j, err := ToJID("380500000000@c.us")
	if err != nil || j.Server != types.DefaultUserServer || j.User != "380500000000" {
		t.Fatalf("ToJID: %v %v", j, err)
	}
	if got := FromJID(j); got != "380500000000@c.us" {
		t.Fatalf("FromJID = %q", got)
	}
	dev := types.JID{User: "380500000000", Server: types.DefaultUserServer, Device: 3}
	if got := FromJID(dev); got != "380500000000@c.us" {
		t.Fatalf("device part kept: %q", got)
	}
}

func TestMessageKey(t *testing.T) {
	k := MessageKey{FromMe: true, Chat: "120363000000000000@g.us", ID: "3EB0AAAA", Participant: "380500000000@c.us"}
	s := k.String()
	if s != "true_120363000000000000@g.us_3EB0AAAA_380500000000@c.us" {
		t.Fatalf("String = %q", s)
	}
	back, ok := ParseMessageKey(s)
	if !ok || back != k {
		t.Fatalf("Parse(%q) = %+v %v", s, back, ok)
	}
	if k, ok := ParseMessageKey("false_380500000000@c.us_ABC"); !ok || k.FromMe || k.Participant != "" || k.ID != "ABC" {
		t.Fatalf("1:1 key: %+v %v", k, ok)
	}
	if k, ok := ParseMessageKey("ABC123"); !ok || k.ID != "ABC123" || k.Chat != "" {
		t.Fatalf("bare id: %+v %v", k, ok)
	}
	for _, bad := range []string{"", "maybe_x_y", "true__"} {
		if _, ok := ParseMessageKey(bad); ok {
			t.Errorf("Parse(%q) accepted", bad)
		}
	}
}

func TestPhoneNumberJID(t *testing.T) {
	j, digits, ok := PhoneNumberJID("+380 (50) 000-00-00")
	if !ok || digits != "380500000000" || j.String() != "380500000000@s.whatsapp.net" {
		t.Fatalf("got %v %q %v", j, digits, ok)
	}
	if _, _, ok := PhoneNumberJID("12"); ok {
		t.Fatal("short number accepted")
	}
}

func TestKindOf(t *testing.T) {
	for id, want := range map[string]Kind{
		"1@g.us": KindGroup, "1@c.us": KindPrivate, "1@lid": KindLID,
		"1@newsletter": KindChannel, "status@broadcast": KindBroadcast, "x": KindUnknown,
	} {
		if got := KindOf(id); got != want {
			t.Errorf("KindOf(%q) = %q, want %q", id, got, want)
		}
	}
}
