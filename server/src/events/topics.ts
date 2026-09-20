// The built-in topic taxonomy. Custom topics (anything `con event emit`
// publishes that is not listed here) register themselves on first sight.

import type { TopicDoc } from './types.js'

export const BUILTIN_TOPICS: TopicDoc[] = [
  { topic: 'webhook.received', description: 'An inbound /hook/<project> delivery was archived. Listeners that match it replace the owner-wake; unmatched deliveries still wake the project owner.',
    fields: { project: 'vault project slug', subpath: 'path after /hook/<project>', method: 'HTTP method', deliveryId: 'con webhook show <id>', contentType: 'request content-type', headers: 'sanitised provider headers, e.g. x-github-event', bodyPreview: 'first 1 KB of a text body', json: 'parsed body when it is JSON (≤ 8 KB)' } },
  { topic: 'mail.received', description: 'A new message landed in a mailbox the hub syncs: Gmail (source gmail:<address>, account = the address) or an agent IMAP box held in IDLE (source imap:<name>, account = the short name al | ceo | mai, address = the mailbox).',
    fields: { account: 'Gmail address, or the IMAP account name (al, ceo, mai)', address: 'IMAP only: the mailbox address', id: 'Gmail message id, or the IMAP UID', threadId: 'Gmail only', messageId: 'IMAP only: Message-ID header', inReplyTo: 'IMAP only', from: 'From header', fromName: 'display name', fromEmail: 'address only', to: 'To header', subject: 'Subject', snippet: 'Gmail snippet / first 240 chars of the IMAP text part', date: 'IMAP only: ISO header date', labels: 'Gmail label ids', hasAttachments: 'IMAP only', unread: 'IMAP only: \\Seen not set' } },
  { topic: 'chat.message', description: 'A conversation event arrived in a Matrix room (WhatsApp/Beeper bridges included). Emitted for every room, muted or not, including your own sends (isSelf).',
    fields: { room: 'Matrix room id', roomName: 'display name when known', sender: 'Matrix user id', senderName: 'display name when known', isSelf: 'true when you sent it', isDirect: 'DM room', body: 'text preview (≤ 500 chars)', eventId: 'Matrix event id', msgtype: 'm.text, m.image, …' } },
  { topic: 'cal.event.created', description: 'A calendar event appeared in the ±60 d sync window that was not there on the previous sync.',
    fields: { account: 'Google account', calendarId: 'calendar', id: 'event id', summary: 'title', start: 'ISO start', end: 'ISO end', location: 'location string', attendees: 'attendee count' } },
  { topic: 'cal.event.updated', description: 'A tracked calendar event changed (time, title, location, attendees…).',
    fields: { account: 'Google account', calendarId: 'calendar', id: 'event id', summary: 'title', start: 'ISO start', end: 'ISO end', location: 'location string' } },
  { topic: 'cal.event.starting', description: 'A reminder fired for an event about to start (the same moments the phone gets a push).',
    fields: { account: 'Google account', calendarId: 'calendar', id: 'event id', summary: 'title', start: 'ISO start', minutesBefore: 'reminder lead time', location: 'location string' } },
  { topic: 'location.fix', description: 'A new OwnTracks fix reached the hub. High volume — ring-buffered, never written to the daily log.', logged: false,
    fields: { device: 'OwnTracks device', lat: 'latitude', lon: 'longitude', acc: 'accuracy m', tst: 'unix seconds', vel: 'km/h', batt: 'battery %' } },
  { topic: 'geo.enter', description: 'Yousef entered a geofence (`con location geofence list`).',
    fields: { fence: 'fence id', fenceName: 'fence name', lat: 'fix latitude', lon: 'fix longitude', acc: 'fix accuracy m', dwellS: 'seconds spent outside before this', eventId: 'con location events', test: 'true for a synthetic transition' } },
  { topic: 'geo.leave', description: 'Yousef left a geofence.',
    fields: { fence: 'fence id', fenceName: 'fence name', lat: 'fix latitude', lon: 'fix longitude', acc: 'fix accuracy m', dwellS: 'seconds spent inside', eventId: 'con location events', test: 'true for a synthetic transition' } },
  { topic: 'board.card.moved', description: 'A dispatched board card changed column (review / done / blocked / reopened).',
    fields: { project: 'board project', boardPath: 'vault-relative board path', cardId: '^id', text: 'card text', to: 'review | done | blocked | reopened', agentKey: 'assignee' } },
  { topic: 'board.card.edited', description: 'An in-flight card\'s content was edited.',
    fields: { project: 'board project', boardPath: 'vault-relative board path', cardId: '^id', text: 'card text', agentKey: 'assignee' } },
  { topic: 'board.card.dispatched', description: 'A card was handed to an agent (fork or direct wake).',
    fields: { project: 'board project', boardPath: 'vault-relative board path', cardId: '^id', text: 'card text', agentKey: 'worker agentKey', column: 'column' } },
  { topic: 'agent.session.ended', description: 'A hub agent session ended.',
    fields: { agentKey: 'agentKey', csid: 'claudeSessionId', name: 'session name' } },
  { topic: 'listener.fired', description: 'A listener\'s action ran (meta — lets one rule watch another).',
    fields: { listenerId: 'listener id', action: 'action type', events: 'event ids coalesced into this action' } },
  { topic: 'listener.paused', description: 'A listener exceeded its per-hour ceiling and paused itself.',
    fields: { listenerId: 'listener id', firedLastHour: 'count', maxPerHour: 'ceiling' } },
  { topic: 'expect.missed', description: 'An expectation\'s deadline passed with no matching event (`con listen expect`). Its --else ran on this event unless reason is "hub down".',
    fields: { listenerId: 'listener id', expect: 'one-line rule', on: 'awaited topic', deadlineAt: 'epoch ms', armedAt: 'epoch ms', reason: 'deadline | hub down', acted: 'false when the deadline was >24 h stale on restart', lateMs: 'present when judged late', confidence: 'fresh | stale — geo topics only, stale = last fix >30 min old', triggerEventId: 'the --after event, if any', trigger: 'that event\'s data', sinceLastSatisfiedMs: 'ms since it was last satisfied' } },
  { topic: 'expect.satisfied', description: 'An expectation\'s awaited event arrived in time.',
    fields: { listenerId: 'listener id', expect: 'one-line rule', eventId: 'the satisfying event', deadlineAt: 'the tick it satisfied (absolute)', triggerEventIds: 'the --after events it disarmed (relative)' } },
  { topic: 'hub.started', description: 'The hub finished booting. Fires once per process — the hook for catch-up scripts after downtime.',
    fields: { downSince: 'epoch ms of the last heartbeat before the restart (null on first boot)', downMs: 'downtime length', pid: 'process id' } },
]

export const BUILTIN_TOPIC_NAMES = new Set(BUILTIN_TOPICS.map((t) => t.topic))
