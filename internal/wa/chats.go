package wa

import (
	"context"
	"sort"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"

	"github.com/TacticalDevsBattalion/k2-system-whatsapp/internal/ids"
)

// ChatSummary is the 1.x ChatSummaryDto.
type ChatSummary struct {
	ID               string   `json:"id"`
	Name             string   `json:"name,omitempty"`
	DisplayName      string   `json:"displayName"`
	NameSource       string   `json:"nameSource,omitempty"`
	Kind             ids.Kind `json:"kind"`
	IsGroup          bool     `json:"isGroup,omitempty"`
	Subject          string   `json:"subject,omitempty"`
	Description      string   `json:"description,omitempty"`
	ParticipantCount int      `json:"participantCount,omitempty"`
	PhoneNumber      string   `json:"phoneNumber,omitempty"`
	PushName         string   `json:"pushName,omitempty"`
	VerifiedName     string   `json:"verifiedName,omitempty"`
	IsMyContact      bool     `json:"isMyContact,omitempty"`
	IsReadOnly       bool     `json:"isReadOnly,omitempty"`
	Archived         bool     `json:"archived,omitempty"`
	Timestamp        int64    `json:"timestamp,omitempty"`
	UnreadCount      int      `json:"unreadCount,omitempty"`
	Forwarded        bool     `json:"forwarded"`
}

// ChatList is the 1.x ChatListResponse.
type ChatList struct {
	Chats             []ChatSummary `json:"chats"`
	UnreadableChatIDs []string      `json:"unreadableChatIds"`
	Allowlist         []string      `json:"allowlist"`
	UnnamedCount      int           `json:"unnamedCount"`
}

// ListChats lists every chat the account is known to have: the groups it is in (from WhatsApp,
// always current), and the one-to-one chats from history sync and live traffic.
func (m *Manager) ListChats(ctx context.Context) (ChatList, error) {
	cli, err := m.requireReady()
	if err != nil {
		return ChatList{}, err
	}
	byID := map[string]*ChatSummary{}

	groups, err := m.groups.all(ctx, cli)
	if err != nil {
		return ChatList{}, err
	}
	own := cli.Store.ID.ToNonAD()
	for _, g := range groups {
		id := ids.FromJID(g.JID)
		s := &ChatSummary{ID: id, Kind: ids.KindGroup, IsGroup: true, Subject: g.Name, Description: g.Topic,
			ParticipantCount: len(g.Participants)}
		if g.Name != "" {
			s.Name, s.NameSource = g.Name, "subject"
		}
		if g.IsAnnounce {
			s.IsReadOnly = !isAdmin(g, own, cli)
		}
		if !g.GroupCreated.IsZero() {
			s.Timestamp = g.GroupCreated.Unix()
		}
		byID[id] = s
	}

	contacts, _ := cli.Store.Contacts.GetAllContacts(ctx)
	known, err := m.st.ListChats(ctx)
	if err != nil {
		return ChatList{}, err
	}
	for _, c := range known {
		s, ok := byID[c.ID]
		if !ok {
			s = &ChatSummary{ID: c.ID, Kind: ids.KindOf(c.ID), IsGroup: ids.KindOf(c.ID) == ids.KindGroup}
			byID[c.ID] = s
		}
		if c.LastTime != nil && c.LastTime.Unix() > s.Timestamp {
			s.Timestamp = c.LastTime.Unix()
		}
		if c.Archived != nil {
			s.Archived = *c.Archived
		}
		if c.UnreadCount != nil {
			s.UnreadCount = *c.UnreadCount
		}
		if s.Kind == ids.KindPrivate || s.Kind == ids.KindLID {
			describeContact(s, contacts)
		}
		if s.Name == "" && c.Name != nil && *c.Name != "" {
			s.Name, s.NameSource = *c.Name, "title"
		}
	}

	out := ChatList{Chats: make([]ChatSummary, 0, len(byID)), UnreadableChatIDs: []string{}, Allowlist: m.cfg.Rabbit.ChatIDs}
	if out.Allowlist == nil {
		out.Allowlist = []string{}
	}
	for _, s := range byID {
		if s.Name == "" && s.PhoneNumber != "" {
			s.Name, s.NameSource = s.PhoneNumber, "number"
		}
		s.DisplayName = s.Name
		if s.DisplayName == "" {
			s.DisplayName, s.NameSource = ids.UserPart(s.ID), "fallback"
			out.UnnamedCount++
		}
		s.Forwarded = m.allowed(s.ID)
		out.Chats = append(out.Chats, *s)
	}
	sort.Slice(out.Chats, func(i, j int) bool {
		if out.Chats[i].Timestamp != out.Chats[j].Timestamp {
			return out.Chats[i].Timestamp > out.Chats[j].Timestamp
		}
		return out.Chats[i].ID < out.Chats[j].ID
	})
	return out, nil
}

func describeContact(s *ChatSummary, contacts map[types.JID]types.ContactInfo) {
	jid, err := ids.ToJID(s.ID)
	if err != nil {
		return
	}
	if jid.Server == types.DefaultUserServer {
		s.PhoneNumber = jid.User
	}
	ci, ok := contacts[jid]
	if !ok || !ci.Found {
		return
	}
	s.PushName, s.VerifiedName = ci.PushName, ci.BusinessName
	switch {
	case ci.FullName != "":
		s.Name, s.NameSource, s.IsMyContact = ci.FullName, "contact", true
	case ci.FirstName != "":
		s.Name, s.NameSource, s.IsMyContact = ci.FirstName, "contact", true
	case ci.BusinessName != "":
		s.Name, s.NameSource = ci.BusinessName, "verifiedName"
	case ci.PushName != "":
		s.Name, s.NameSource = ci.PushName, "pushname"
	}
}

func isAdmin(g *types.GroupInfo, own types.JID, cli *whatsmeow.Client) bool {
	lid := cli.Store.GetLID()
	for _, p := range g.Participants {
		if p.JID.ToNonAD() == own || (!lid.IsEmpty() && p.LID.ToNonAD() == lid.ToNonAD()) {
			return p.IsAdmin || p.IsSuperAdmin
		}
	}
	return false
}

// groupCache keeps the joined groups for a minute: the send path checks a group id against it,
// and every lookup is a round trip to WhatsApp otherwise.
type groupCache struct {
	mu      sync.Mutex
	at      time.Time
	byJID   map[types.JID]*types.GroupInfo
	ordered []*types.GroupInfo
}

// reset forgets the cached groups (a new client may be a different account).
func (c *groupCache) reset() {
	c.mu.Lock()
	c.byJID, c.ordered, c.at = nil, nil, time.Time{}
	c.mu.Unlock()
}

func (c *groupCache) all(ctx context.Context, cli *whatsmeow.Client) ([]*types.GroupInfo, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.at) < time.Minute && c.byJID != nil {
		return c.ordered, nil
	}
	groups, err := cli.GetJoinedGroups(ctx)
	if err != nil {
		return nil, err
	}
	c.byJID = make(map[types.JID]*types.GroupInfo, len(groups))
	for _, g := range groups {
		c.byJID[g.JID] = g
	}
	c.ordered, c.at = groups, time.Now()
	return groups, nil
}

func (c *groupCache) get(ctx context.Context, cli *whatsmeow.Client, jid types.JID) (*types.GroupInfo, error) {
	if _, err := c.all(ctx, cli); err != nil {
		return nil, err
	}
	c.mu.Lock()
	g, ok := c.byJID[jid]
	c.mu.Unlock()
	if ok {
		return g, nil
	}
	// Joined since the last refresh: ask for this one group.
	return cli.GetGroupInfo(ctx, jid)
}
