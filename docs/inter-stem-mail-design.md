# Inter-Stem mail design

Status: decided 2026-10-13, revised the same day after review (discoverability,
sender authentication) and after the Stem chat "Stem Inter-Stem Mail Design"
(purpose, full memory by default). Phase 1 built 2026-10-14; the practical
pass of 2026-10-25 is under "Build notes (2026-10-25)". Builds on the mail system
(`src/server/mail/router.ts`, `MailItem` in `src/shared/types.ts`) and the
Inbox, which was groundwork for this from 0.4.0.

## Goal

Not another email. Email and messaging apps already carry words between
people. What Stem adds is that **each side has an assistant that already
knows its owner's situation**, so two people can work something out without
either one packaging all the context or relaying every clarification:

- **Making plans together.** "Find a weekend activity for our families."
  Each Stem knows its own family's constraints and proposes what fits,
  without handing the other side its owner's personal context.
- **Delegating across people.** A colleague asks for a review of an
  infrastructure change. Their Stem brings the proposal and background;
  yours investigates, asks for what's missing, and returns your conclusions.
- **Keeping a shared commitment moving.** "We agreed to record a podcast
  next month." Each Stem tracks its owner's part, gathers material and flags
  blockers.

The model is **humans let in, agents prepare, humans release.** Your agents use your full
memory and tools to prepare each reply; you review the exact outgoing mail
and send it. The value isn't fewer clicks, it's no work behind each click:
gathering context, investigating, comparing options, remembering what's
still open.

A remote conversation is therefore shown as an **ongoing collaboration with
a goal and pending decisions** ("Podcast recording: waiting for Martin's
availability"), not just a thread of messages.

Mail between Stems uses the email addresses people already have, reaches the
person rather than their agents, and is end-to-end encrypted.

## Settled decisions

1. **One person per Stem.** No shared multi-user servers. Most Stems run
   embedded in the desktop app on a laptop, so they are often asleep or
   offline. A VPS-hosted Stem is the same thing, just always on.
2. **Addresses are real email addresses** (`martin.mrkvicka@gmail.com`), not
   relay handles. Owning the address is proven by an emailed code or link.
3. **Relays.** Awantech runs the global relay. A company can run a private
   relay for its own domain. Both run the same software.
4. **End-to-end encrypted.** A relay sees who mails whom, when, and how big
   the mail is. It never sees subject, body or attachments.
5. **Every incoming mail is approved by the human before any agent sees
   it**, including mail from accepted contacts and mid-collaboration
   replies. An incoming mail never starts a persona turn on its own.
6. **Every outbound persona mail to another Stem is approved by the human**,
   whether it is a reply the human asked for or a mail the persona started.
7. **The relay only carries mail in transit.** It deletes a mail once the
   recipient's Stem confirms it has it, or when the wait runs out. It is not a
   mailbox.
8. **Losing the laptop loses everything**, the key included, the same as the
   rest of Stem. There is no key backup. Recovery is setting up again and
   verifying the address again.
9. **Your agents use your full memory in external conversations, by
   default.** Nothing is shared with the other Stem except what you approve
   in an outgoing mail. The other side's agents never get access to your
   memory.
10. **Membership is not hidden** from people who know an address, unless the
    owner turns on Unlisted.
11. **A sender's address is vouched for by its home relay** with short-lived
    certificates; DNS is the trust root, as for email.
12. **Every outgoing mail is approved, in full**, for now. Bounded
    collaborations where agents handle routine exchanges themselves are a
    later step.
13. **Exits other than mail are enforced in code** in external conversations
    (tool set), since approval only covers mail.

## Identity and keys

- Each Stem has one keypair: X25519 for encryption, Ed25519 for signing. The
  private key never leaves the Stem.
- A Stem can register several addresses (work and personal) with the same
  key.
- Registration: Stem sends `{address, publicKey}` to the relay. The relay
  emails a code or link to the address. Confirming it publishes the mapping
  address → key.
- The relay answers every registration with "code sent", whether the address
  is new or already registered. If it is registered, the email tells the
  owner someone tried to add a key and to ignore it unless it was them.
- A new key (new laptop) goes through the same email verification. Contacts
  see a key-change notice in the conversation.

### The relay vouches for keys

Because the relay maps addresses to keys, whoever runs the relay could hand
out a false key and read mail. The design limits this:

- **Pinning.** A Stem pins a contact's key on first contact. A changed
  key is shown loudly in the conversation, and nothing is sent to the new
  key until the user acknowledges the change.
- **In-person verification.** Comparing a fingerprint or scanning a QR code
  upgrades a contact from "verified by email" to "verified by you".
- **Key log (later).** An append-only public log of address → key mappings,
  which Stems check, so a false key handed to one person is detectable. This
  is what makes "the relay can't read your mail" true even about the operator.

## Relays and routing

- Which relay serves an address comes from its domain. A TXT record at
  `_stem.<domain>` names the domain's relay. Without a record, the address
  belongs to the global relay (gmail.com and everything else).
- The global relay refuses to register addresses in any domain that has its
  own record, so nobody can claim `martin@acme.com` before Acme sets up.
- A private relay verifies its people however it likes: email codes first,
  SSO later.
- Stems connect outward only: each Stem holds a long-lived connection to the
  relay of each of its addresses. No open ports, works behind NAT and company
  firewalls.
- Sending to an address on another relay goes to that relay directly. Relays
  don't forward to each other.
- **A company can keep Stem mail inside.** Three locks, each usable alone:
  - a **policy file** on company machines (`docs/stem-policy.md`) turns
    inter-Stem mail off, or allows only the company's domains through the
    company relay. The app then never contacts the global relay (push
    gateway included), and the user can't loosen it from Settings;
  - a **closed relay** (`closed = true`) refuses every sender outside its
    domains and named partners, and answers their lookups as "not on Stem";
  - `access=closed` in the `_stem` record makes every other relay, the
    global one first, refuse the domain's people as senders, which also
    covers employees whose Stem has no policy file.

### Delivery

1. The sender's Stem looks up the recipient's key (cached and pinned after
   the first time), seals the mail to it, signs it, attaches its sender
   certificate (see Sender authentication), and posts it to the
   recipient's relay.
2. The relay checks the certificate, then holds the sealed mail until the
   recipient's Stem collects it and confirms it has stored it, then deletes
   it. The wait is capped at 7 days; an expired mail is deleted, and between
   accepted contacts the sender's Stem marks it not delivered.
3. Approved sends made while offline queue on the sender's Stem and go out
   when it reconnects.
4. A lookup that finds no key means "not reachable": the address isn't on
   Stem, or its owner is unlisted (see Discoverability). The sender's Stem
   can't tell which. It offers "invite them to Stem"; the relay emails an
   invite only if the address is unregistered and the invite limits allow,
   and never reports whether it did. The mail is kept on the sender's Stem
   and offered for sending once that address becomes reachable.

The global relay needs a transactional mail provider (Postmark or SES) for
verification and invite emails; a bare VPS lands in spam.

### What the relay knows

Registered addresses and keys, and who mailed whom, when, and the size. Under
real email addresses this is a social graph. The privacy note says so.

## Sender authentication

An envelope signature proves the sender has a key, not that they own the
address in `from`. The sender's **home relay** (the relay that verified the
address) vouches for that, the same way DKIM lets a domain vouch for mail:

- **Relay signing keys.** Every relay has a long-lived signing key. A private
  relay publishes it in its `_stem.<domain>` TXT record (alongside the relay
  URL). The global relay's key ships inside Stem and is also served at
  `/.well-known/stem-relay`. DNS is the trust root for a domain, as it is for
  email; no relay vouches for addresses outside its domains.
- **Sender certificates.** The home relay issues each verified Stem a
  certificate per address: `{address, key fingerprint, issuing relay,
  expires}` signed by the relay's key, valid 24 hours and refreshed
  automatically while the Stem is connected.
- **On send,** the envelope carries the certificate and is signed with the
  key it names. The receiving relay checks: the certificate's issuer is the
  authority for the address's domain (DNS record, or the global relay when
  there is none), the issuer signature, expiry, and the envelope signature
  against the certified key. Anything that fails is refused.
- **The recipient's Stem checks the same things itself**, and doesn't trust
  its own relay's word. It also compares the certified key with the pinned
  one, so a key change shows as a key-change notice.
- **Revocation is expiry.** Certificates live a day, so a lost or replaced
  key stops being vouched for within 24 hours without any revocation list.
  For an immediate cut-off, the home relay marks the key revoked and
  receiving relays and Stems that look up the sender see it; a sender
  lookup happens on first contact and whenever a certificate names a key
  different from the pinned one.
- **Relay key rotation.** A relay publishes the next signing key alongside
  the current one for an overlap period (two DNS records); certificates
  signed by either are accepted until the old one is removed.
- **Relay-to-relay limits.** A receiving relay rate-limits per issuing relay
  as well as per sender, and a closed private relay accepts only its own
  domains and named partner domains (see "A company can keep Stem mail
  inside").
- **Replay.** Envelope ids are unique and carry a timestamp; relays and Stems
  drop duplicates and envelopes older than the 7-day transit cap.

## The relay software

Goal: easy to install, and dumb enough that Stem releases never touch it.

### Build and install

- **Go**, one static binary, plus a small Docker image. No Node, no npm.
- Built-in Let's Encrypt (autocert): point a domain at the box, run
  `stem-relay init`, fill in the mail settings, start it.
- Storage is one embedded SQLite file through a pure-Go driver, so the binary
  stays a single file and needs no database server.
- Lives in `relay/` in this repo as its own Go module, released on its own
  tags (`relay-v1.0.0`). Stem's CI builds it and runs the mail tests against
  the real binary.
- The protocol is a written spec plus shared test vectors (envelopes,
  signatures, sender certificates) that both the Go relay and Stem's
  TypeScript client test against. No shared code.

### Dumb by design

The relay sees only an envelope:

```
outer (relay reads):  version · to · from · id · timestamp · size ·
                      sender certificate · signature
inner (sealed):       everything else: subject, body, attachments,
                      threading, mail kinds
```

Rules that keep Stem changes away from the relay:

1. **The relay never looks inside the sealed part**, not even at its
   version. Stems agree on the inner format between themselves; a Stem that
   gets an inner version it doesn't know shows "this mail needs a newer
   Stem" instead of failing.
2. **Key material is an opaque signed blob per address**, not named fields.
   New key types or forward-secrecy prekeys are a new blob from Stems, not a
   relay change.
3. **The protocol only grows.** Paths under `/v1/`, new fields optional,
   unknown fields ignored on both sides. `/v1/info` lists what the relay
   supports; Stem feature-detects and never needs the newest relay for core
   mail.
4. **Policy is config, not code.** Every abuse number (invite budget, sender
   and queue quotas, one knock, circuit-breaker thresholds, lookup limits)
   lives in the config file. Tuning the global relay is a config edit.
5. **Optional features are switched in config.** Invites, complaint
   webhooks and the circuit breaker are on for the global relay; a private
   relay usually leaves them off.

### What still forces an update

- **Security fixes** in Go or a dependency. The image and binary check for
  new versions and can update themselves; database migrations only go
  forward.
- **Real protocol additions**, expected to be rare. The key log is the only
  one planned, and it is a new endpoint.

An ordinary Stem release changes nothing on the relay.

## Abuse

The relay can't read mail, so it can't filter content. Every defence works on
identity, counts and sizes. Numbers below are starting values, tuned on the
global relay; a private relay sets its own.

### No mail without a key

A sender can only seal to a key the relay returned, so there is nothing to
send to an unregistered or unlisted address, and the relay never stores mail
for one. An invite request (below) is the only thing a sender can ask for
such an address.

### Verification emails

The one email the relay sends, and the one a stranger can trigger by typing
someone else's address:

- at most 3 codes per address per day, and per requesting Stem and IP;
- every verification email carries a "this wasn't me, never email me again"
  link that puts the address on a suppression list (lifted only by the
  owner verifying from that address later);
- registration needs a small proof-of-work from the Stem, so mass
  registration costs CPU.

### Invite emails

Invites are the one way a sender makes the relay email a stranger, so they
get the tightest limits:

- **An invite request counts as a knock.** It uses the sender's first-contact
  allowance and the one-knock rule like a mail does.
- **Per recipient address: one invite email per 30 days**, whoever asks.
  Further senders in that window are batched into the next one ("Vlado and
  2 others want to reach you on Stem"). After 3 invites with no
  registration, the address gets no more.
- **Per sender: 5 invites per day, 20 per month.** Addresses verified in the
  last 7 days can't trigger invites at all.
- **Fixed template.** The sender controls nothing in it but their verified
  address; no free text, no display name, nothing to phish with.
- **Unsubscribe.** Every invite carries "never email me again", which puts
  the address on the same suppression list as verification emails.
- **Bounces and complaints.** A hard bounce suppresses the address. A spam
  complaint against an invite costs that sender their invite rights; repeat
  complaints count as blocks (see below).
- **Global budget.** The relay sends at most a fixed number of invites per
  day across all senders (start at 200, raise slowly as the sending
  reputation builds). Invites over budget wait in a queue and expire with
  the 30-day window; verification emails never wait behind invites.
- **Circuit breaker.** Invites pause automatically when, over a rolling 7
  days, hard bounces exceed 2% or spam complaints exceed 0.1% (Gmail's
  bulk-sender line is 0.3%), and the operator is alerted. Verification
  emails keep going.
- **Separate sending identity.** Invites go out from their own subdomain and
  the provider's separate stream for marketing-like mail, never from
  `awantech.sk` itself or the verification stream, with SPF, DKIM and DMARC
  set up. If invites ever get blocklisted, company mail and verification
  codes are unaffected.
- **Private relays send no invites** unless their operator turns them on;
  colleagues are expected to be on the relay already.

### One knock before acceptance

A sender can have **one undelivered or unanswered mail** waiting for a
recipient who hasn't accepted them. Further mail to that recipient is
refused until the recipient accepts the Request, replies, or the knock
expires. The relay enforces this from metadata it already has (has this
recipient ever mailed this sender?). Strangers get one chance, not a flood.

### Sender limits

- New first-contact recipients per sender: 20 per day.
- New addresses (first 7 days after verification) get a quarter of the
  normal limits.
- Total mails per sender per hour, regardless of recipient.

### Queue quotas

For mail held while a recipient is offline:

- per mail: size cap (attachments included), 25 MB;
- per recipient: total held, 200 MB / 1,000 mails; past that a contact's
  mail is refused as "recipient's queue is full", a stranger's is silently
  dropped;
- per sender toward one recipient: a share of that queue, so one sender
  can't fill someone's queue and block everyone else.

### Blocks feed back to the relay

Blocking a sender in Requests or a conversation tells the relay. The relay
then silently drops that sender's mail to that recipient for good. When many
distinct recipients block the same sender in a short window, the relay
throttles and then suspends that address, which can appeal by verifying
again.

### Directory lookups

Lookups need an authenticated, registered Stem and are rate-limited per Stem
(100 per day, burst 20), so bulk enumeration is slow and visible. They don't
hide who is listed; see Discoverability.

### Known gap

Free email providers make new identities cheap. Proof-of-work, new-address
limits, the one-knock rule and block feedback raise the cost; they don't stop
a determined spammer with many verified mailboxes. If that becomes real, the
next step is reputation (age, accepted contacts) gating first-contact sends.

## Discoverability

A key directory can't hide who is in it. Fake keys for unregistered
addresses were considered and rejected: a modified client can re-look up an
address and see the fake key become a real one when the person registers,
and with several accounts it can compare answers. Hiding membership
robustly would need something like private set intersection, which is out
of scope. So the design is honest instead, the way Signal is about phone
numbers:

- **Listed (default).** Anyone who knows your address can learn that you use
  Stem and send you one knock. That's what "people can reach me at my
  address" means.
- **Unlisted.** Settings switch "Only people I've mailed can reach me". The
  relay returns your key only to senders you've mailed first (it knows this
  from delivery metadata). To everyone else a lookup answers exactly like an
  unregistered address: same response, same timing, and no invite is sent.
  Because "no key" covers both cases, an unlisted user is indistinguishable
  from a non-user.
- **Registration replies identically** whether the address is new or taken
  (see Identity and keys), so registering isn't a membership oracle either.
- **No status toward strangers.** A stranger sees only "sent", never
  "delivered", "queue full" or "blocked". This hides blocks and the
  recipient's activity, not membership.

What leaks, accepted: listed users are discoverable one address at a time
(rate-limited); the relay operator knows who is registered; a
`_stem.<domain>` record shows a company uses Stem.

## Encryption

Each mail is sealed to the recipient's key and signed with the sender's key.
Attachments travel inside the sealed envelope, with a size cap. No forward
secrecy in v1: mail sits decrypted in both Stems' stores anyway, and a
ratchet can come later as a new envelope version.

## Inbound

- External mail lands in the Inbox addressed to `user`, badged as external,
  with the sender's state: verified by email, verified by you, or key
  changed.
- First mail from an unknown sender goes to **Requests**. The user accepts
  (sender becomes a contact) or blocks (reported to the relay, see Abuse).
- **Incoming approval.** Every external mail is held from agents until the
  user releases it, every time: first contact, accepted contacts, and new
  replies inside a collaboration a persona is already working on. Until
  then it is shown only to the user; no recall, capture, persona turn or
  draft touches it. Releasing it is the user saying "my agents may act on
  this".
- Releasing doesn't make it safe: a person can miss a prompt injection, so
  the exit gating (Outbound) applies to every external-context turn
  regardless.
- On a released mail the user can:
  - reply by hand;
  - ask a persona to draft a reply;
  - bring it into an internal conversation with personas.
- External addresses are mail participants like `user` and persona ids. They
  are told apart by the `@` (agent ids use `~`).

## Outbound

- A persona's `send_mail` to an external address creates a draft, never a
  send. The draft shows in the conversation and in an Approvals view; the
  user edits, sends or discards it. This reuses `MailApproval`.
- The user's own replies send directly.
- Approval is the main defence against prompt injection in external mail:
  nothing leaves through mail without the user.

### External conversations: full memory, gated exits

A conversation that contains external mail is **external context**, and so
is every turn in it: the driver's, other personas', spawned agents', and any
internal conversation the user brings external mail into (the mark travels
with the mail).

**What the agents get, by default:** everything a normal turn gets for
reading: recall, the user summary, standing answers, `read_past_chat`,
memory tools, and reading connected folders. That is what lets them answer
and coordinate well. Disclosure is controlled at the one place content
leaves, the outgoing mail, which the human approves.

**What is gated, in code at `before_agent_start`, because approval doesn't
see it:** every other way out. External mail can carry a prompt injection,
and a turn with full memory is exactly the turn an attacker wants to make
leak through a side channel:

- web reads and fetches always ask (a URL can carry data out); automatic
  approval tiers are off for the turn;
- file and folder writes, `run_command`, coding agents, computer and browser
  control, MCP tools, skill writes and `schedule_task` are removed;
- a persona can be granted specific ones back ("in external conversations
  this persona may use: <MCP server>, <folder, writable>"), default none.

**What the approver sees:** the exact outgoing mail, body and every
attachment, not a summary of it. Later the approval may distinguish
**disclosure** ("may this be shared?") from **commitment** ("may Stem agree
to this or promise this work?"): "Sunday works for me" is not the same
approval as "I've booked Sunday".

## Memory

- Your agents read your full memory in external conversations (above). The
  other Stem only ever receives approved mail; no memory, recall or files
  are shared between Stems.
- Facts learned from external mail are tagged with that contact and recalled
  only in conversations with that contact, so an outsider can't plant facts
  that surface elsewhere. Capture of the owner's own messages in an external
  conversation works as normal.
- Company memory, later, is a **team Stem**: a Stem on the company's private
  relay with its own memory, skills and personas, which colleagues mail like
  anyone else. Its owner can switch on auto-answer for members of that relay,
  the one place where unattended replies make sense. Personal memory stays on
  personal Stems.

## Build notes (phase 1, 2026-10-14)

Where the first build is stricter or narrower than the design above:

- **Web is removed, not "ask".** A persona's draft runs unattended, so there
  is nobody to ask; external-context turns get only the read-only allowlist
  (`EXTERNAL_TOOLS` in `stem-mcp-extension.mjs`: read/grep/find/ls, memory
  search, `read_past_chat`, `read_notes`, `send_mail`). New tools start closed.
- **No capture at all yet.** External-context turns are tainted out of Recall
  entirely; contact-tagged facts are a later step.
- **Text only.** Attachments to and from other Stems aren't sent yet.
- **One counterpart per conversation.** An external conversation is with
  exactly one address; personas join it only to draft.
- **Global relay keys** ship in the build for `relay.stem.awantech.sk`
  (`GLOBAL_RELAY_KEYS` in `relay-client.ts`). A relay named by
  `STEM_GLOBAL_RELAY_URL` brings its keys in `STEM_GLOBAL_RELAY_KEYS` or is
  learned from its `/.well-known` on first use and pinned.

## Build notes (2026-10-25)

What changed to make person mail practical, and where it differs from the
sections above:

- **Sending.** Contacts can be named; compose suggests them and checks
  whether an address is on Stem as you type (cached ten minutes; lookups
  are rate-limited). A From picker appears with several addresses.
- **Not on Stem yet.** The mail is kept ("waiting") and looked up every
  six hours for 30 days. When they join it shows "Ready to send" and the
  user sends it with one click — offered, never sent blind. Failed and
  unsent mail can be sent again. Replying to a Request accepts it.
- **One step to a draft.** "Read it and draft a reply" releases the held
  mail and starts the draft. The persona that drafted last for a contact
  is the default.
- **Auto-draft (per contact).** Only for a contact whose key the user
  checked in person, and only while no key change is pending: their new
  mail is released and drafted at once. Only the triggering mail is
  released, and only when it is the one mail still held. Every send still
  waits for the user. Unverifying, a key change or a first key pinned
  after the check turns it off.
- **Notifications.** A desktop notification names the sender; the phone
  push says who wrote (through the relay's gateway no label travels).
- **Memory.** Facts about the person and what was agreed are extracted
  from released mail (and the user's own) into source `contact:<address>`
  at confidence 0.75. They are injected and searchable only in turns with
  that person (search_facts gets the contact stamped by the bridge from the
  turn gate); the user summary, tidy, merges, neighbour sweeps, the deep
  check and the distiller leave them out. Settings → contacts can forget
  them. The user's own words in these conversations are still not captured
  as user facts.
- **Bringing mail to personas.** Forward works on released person mail;
  the new conversation carries `outside: {address}`, so its turns are
  external context. It can't be shared publicly, and it feeds no persona
  notes or standing answers.
- **Files.** Sealed inside the mail (17 MB in all; the relay takes 25 MB
  sealed). Kept in a private mail-file store, fetched as
  `GET /files/stem-mailfile:<id>`. Received pictures show inline only for
  PNG/JPEG/GIF/WebP, from the raw bytes; nothing is converted before the
  user looks. A persona sees files only when drafting after release.
- **Collaboration card.** Goal, agreed, open and next, written by the
  memory model from readable mail; whose turn it is comes from who wrote
  last.
- **Phone.** Requests, Accept/Block, key-change notice, held mail, drafts
  with editing, send states, names, auto-draft, compose to a person,
  files, the collaboration card. Forwarding is desktop only.

## Phases

1. **Transport.** Keypair, address registration with email codes, relay
   (single binary, global and private), DNS routing, sealed delivery with
   confirm-and-delete, external mail in the Inbox, Requests, hand-written
   replies, sender certificates and relay signing keys, key pinning and
   change notices, the unlisted switch, invite emails, the abuse limits
   (verification and invite caps, one knock, sender and queue quotas, block
   feedback, lookup limits). External-context exit gating lands here too,
   since phase 1 already lets the user bring external mail to personas.
2. **Collaborations.** Persona drafts, the Approvals view (exact content and
   attachments), the per-persona tool grants, contact-tagged facts, and
   remote conversations shown as collaborations with a goal and pending
   decisions.
3. **Teams and scopes.** Bounded collaborations ("coordinate this recording
   with Martin; you may discuss availability, topics and past episodes")
   where agents send routine replies within the scope without asking;
   disclosure vs commitment approvals; private-relay member directory; the
   team Stem with opt-in auto-answer for members; iOS support; the key log.

## Open questions

- Hosting of the global relay on the Awantech side.

Resolved during the build: envelopes use Ed25519 signatures and an
X25519 + HKDF-SHA256 + AES-256-GCM seal (ChaCha20 is missing from Electron's BoringSSL) (no libraries beyond the Go
and Node standard crypto); the relay connection is SSE plus POST. Both are
specified in `relay/PROTOCOL.md`.
- Attachment size cap.
- Whether contacts and Requests sync to the phone in phase 1.
