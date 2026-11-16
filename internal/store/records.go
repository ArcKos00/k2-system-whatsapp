package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Message is one row of wa_messages. Chat and Sender are in the 1.x id dialect (see package ids).
type Message struct {
	Chat     string
	ID       string
	Sender   string
	FromMe   bool
	Time     time.Time
	Type     string
	Body     *string
	HasMedia bool
	// Raw is the protobuf-encoded waE2E.Message: what a reply quotes, what a retry re-sends.
	Raw []byte
}

// OutboxEvent is an event owed to RabbitMQ.
type OutboxEvent struct {
	Seq           int64
	AMQPMessageID string
	Chat          string
	Event         string
	Payload       json.RawMessage
}

// SaveInbound records a message and, when publish is not nil, the event owed for it, in one
// transaction. It reports false when the message was already recorded (a redelivery after a
// crash): the event was written the first time, so nothing is owed twice.
func (s *Store) SaveInbound(ctx context.Context, m Message, publish *OutboxEvent) (bool, error) {
	fresh := false
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		// Deduplicate on the stanza id alone: the same message redelivered after a LID got mapped to
		// a phone number comes with a different chat id (…@lid → …@c.us).
		var seen bool
		// Stanza ids are random (16–20 hex digits), so the id alone is a safe key.
		if err := tx.QueryRow(ctx, `select exists(select 1 from wa_messages where id = $1)`, m.ID).Scan(&seen); err != nil {
			return err
		}
		if seen {
			return nil
		}
		tag, err := tx.Exec(ctx, `insert into wa_messages (chat_id, id, sender, from_me, ts, type, body, has_media, raw)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (chat_id, id) do nothing`,
			m.Chat, m.ID, m.Sender, m.FromMe, m.Time, m.Type, m.Body, m.HasMedia, m.Raw)
		if err != nil {
			return err
		}
		fresh = tag.RowsAffected() == 1
		if !fresh || publish == nil {
			return nil
		}
		return enqueue(ctx, tx, *publish)
	})
	return fresh, err
}

// SaveEvent records an event against an existing message (an edit or a deletion) and applies the
// change to the cached copy. It reports false for a duplicate of an event already owed.
func (s *Store) SaveEvent(ctx context.Context, chat, id string, newBody *string, newType string, publish *OutboxEvent) (bool, error) {
	fresh := false
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if publish != nil {
			var exists bool
			if err := tx.QueryRow(ctx, `select exists(select 1 from wa_outbox where amqp_message_id = $1)`, publish.AMQPMessageID).Scan(&exists); err != nil {
				return err
			}
			if exists {
				return nil
			}
		}
		fresh = true
		if _, err := tx.Exec(ctx, `update wa_messages set body = coalesce($3, body), type = coalesce(nullif($4, ''), type)
			where chat_id = $1 and id = $2`, chat, id, newBody, newType); err != nil {
			return err
		}
		if publish == nil {
			return nil
		}
		return enqueue(ctx, tx, *publish)
	})
	return fresh, err
}

func enqueue(ctx context.Context, tx pgx.Tx, e OutboxEvent) error {
	_, err := tx.Exec(ctx, `insert into wa_outbox (amqp_message_id, chat_id, event, payload) values ($1, $2, $3, $4)
		on conflict (amqp_message_id) do nothing`, e.AMQPMessageID, e.Chat, e.Event, e.Payload)
	return err
}

// SaveSent records a message this gateway sent, so a reply can quote it and a recipient's retry
// receipt can be answered after a restart.
func (s *Store) SaveSent(ctx context.Context, m Message) error {
	_, err := s.Pool.Exec(ctx, `insert into wa_messages (chat_id, id, sender, from_me, ts, type, body, has_media, raw)
		values ($1, $2, $3, true, $4, $5, $6, $7, $8) on conflict (chat_id, id) do nothing`,
		m.Chat, m.ID, m.Sender, m.Time, m.Type, m.Body, m.HasMedia, m.Raw)
	return err
}

// FindMessage looks a message up by stanza id, preferring the given chat (the same message can
// sit under its @lid and its @c.us id).
func (s *Store) FindMessage(ctx context.Context, chat, id string) (Message, error) {
	var m Message
	row := s.Pool.QueryRow(ctx, `select chat_id, id, sender, from_me, ts, type, body, has_media, raw from wa_messages
		where id = $1 order by (chat_id = $2) desc, ts desc limit 1`, id, chat)
	err := row.Scan(&m.Chat, &m.ID, &m.Sender, &m.FromMe, &m.Time, &m.Type, &m.Body, &m.HasMedia, &m.Raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}

// PendingOutbox returns the oldest events not yet confirmed by the broker.
func (s *Store) PendingOutbox(ctx context.Context, limit int) ([]OutboxEvent, error) {
	rows, err := s.Pool.Query(ctx, `select seq, amqp_message_id, chat_id, event, payload from wa_outbox
		where published_at is null order by seq limit $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OutboxEvent
	for rows.Next() {
		var e OutboxEvent
		if err := rows.Scan(&e.Seq, &e.AMQPMessageID, &e.Chat, &e.Event, &e.Payload); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// MarkPublished records the broker's confirm; unrouted says no queue took the event.
func (s *Store) MarkPublished(ctx context.Context, seq int64, unrouted bool) error {
	_, err := s.Pool.Exec(ctx, `update wa_outbox set published_at = now(), unrouted = $2 where seq = $1`, seq, unrouted)
	return err
}

// Unrouted counts events of the last day the broker confirmed but routed to no queue.
func (s *Store) Unrouted(ctx context.Context) (int64, error) {
	var n int64
	err := s.Pool.QueryRow(ctx, `select count(*) from wa_outbox where unrouted and published_at > now() - interval '1 day'`).Scan(&n)
	return n, err
}

// OutboxBacklog is how many events wait for the broker, and how old the oldest is.
func (s *Store) OutboxBacklog(ctx context.Context) (int64, time.Duration, error) {
	var n int64
	var oldest *time.Time
	err := s.Pool.QueryRow(ctx, `select count(*), min(created_at) from wa_outbox where published_at is null`).Scan(&n, &oldest)
	if err != nil || oldest == nil {
		return n, 0, err
	}
	return n, time.Since(*oldest), nil
}

// Prune forgets messages and published events older than ttl, and idempotency keys older than
// keyTTL. Unpublished events are never pruned: they are still owed.
func (s *Store) Prune(ctx context.Context, ttl, keyTTL time.Duration) error {
	if _, err := s.Pool.Exec(ctx, `delete from wa_messages where ts < now() - $1::interval`, interval(ttl)); err != nil {
		return err
	}
	if _, err := s.Pool.Exec(ctx, `delete from wa_outbox where published_at is not null and published_at < now() - $1::interval`, interval(ttl)); err != nil {
		return err
	}
	_, err := s.Pool.Exec(ctx, `delete from wa_idempotency where claimed_at < now() - $1::interval`, interval(keyTTL))
	return err
}

func interval(d time.Duration) string { return fmt.Sprintf("%d milliseconds", d.Milliseconds()) }

// CompletedSend is what a replayed idempotency key answers with.
type CompletedSend struct {
	Chat         string
	SentMessages int
	MessageID    string
}

// ErrInFlight means another request with the same key is being sent right now.
var ErrInFlight = errors.New("send in flight")

// ClaimKey claims an idempotency key. It returns the earlier result for a key that already
// completed, ErrInFlight for one still running, and (nil, nil) when the caller should send.
// A claim older than inFlightTimeout that never completed is taken over: the process that made
// it is gone.
func (s *Store) ClaimKey(ctx context.Context, key string, inFlightTimeout time.Duration) (*CompletedSend, error) {
	var res *CompletedSend
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `insert into wa_idempotency (key) values ($1) on conflict (key) do nothing`, key)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 1 {
			return nil
		}
		var chat, msgID *string
		var sent *int
		var completed *time.Time
		var claimed time.Time
		if err := tx.QueryRow(ctx, `select chat_id, sent_messages, message_id, completed_at, claimed_at from wa_idempotency
			where key = $1 for update`, key).Scan(&chat, &sent, &msgID, &completed, &claimed); err != nil {
			return err
		}
		if completed != nil {
			res = &CompletedSend{Chat: deref(chat), SentMessages: derefInt(sent), MessageID: deref(msgID)}
			return nil
		}
		if time.Since(claimed) < inFlightTimeout {
			return ErrInFlight
		}
		_, err = tx.Exec(ctx, `update wa_idempotency set claimed_at = now() where key = $1`, key)
		return err
	})
	return res, err
}

func (s *Store) CompleteKey(ctx context.Context, key string, r CompletedSend) error {
	_, err := s.Pool.Exec(ctx, `update wa_idempotency set chat_id = $2, sent_messages = $3, message_id = nullif($4, ''),
		completed_at = now() where key = $1`, key, r.Chat, r.SentMessages, r.MessageID)
	return err
}

// ReleaseKey drops a claim whose send failed, so the caller's retry goes through.
func (s *Store) ReleaseKey(ctx context.Context, key string) error {
	_, err := s.Pool.Exec(ctx, `delete from wa_idempotency where key = $1 and completed_at is null`, key)
	return err
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefInt(n *int) int {
	if n == nil {
		return 0
	}
	return *n
}

// Chat is one row of wa_chats.
type Chat struct {
	ID          string
	Name        *string
	LastTime    *time.Time
	Archived    *bool
	UnreadCount *int
}

// UpsertChat records what is known about a chat; nil fields keep what was there, and the last
// activity time only ever moves forward.
func (s *Store) UpsertChat(ctx context.Context, c Chat) error {
	_, err := s.Pool.Exec(ctx, `insert into wa_chats (chat_id, name, last_ts, archived, unread_count) values ($1, $2, $3, $4, $5)
		on conflict (chat_id) do update set
			name = coalesce(nullif(excluded.name, ''), wa_chats.name),
			last_ts = greatest(wa_chats.last_ts, excluded.last_ts),
			archived = coalesce(excluded.archived, wa_chats.archived),
			unread_count = coalesce(excluded.unread_count, wa_chats.unread_count)`,
		c.ID, c.Name, c.LastTime, c.Archived, c.UnreadCount)
	return err
}

func (s *Store) ListChats(ctx context.Context) ([]Chat, error) {
	rows, err := s.Pool.Query(ctx, `select chat_id, name, last_ts, archived, unread_count from wa_chats`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Chat
	for rows.Next() {
		var c Chat
		if err := rows.Scan(&c.ID, &c.Name, &c.LastTime, &c.Archived, &c.UnreadCount); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
