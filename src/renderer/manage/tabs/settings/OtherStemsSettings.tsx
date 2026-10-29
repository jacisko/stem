import { useState } from 'react';
import { BrainCircuit, Check, Pencil, ShieldCheck, Sparkles, Trash2, UserX } from 'lucide-react';
import { InfoTip } from '../../../ui/InfoTip';
import { DisclosureRow, ValueRow } from './rows';
import { formatFingerprint, useInterStem } from '../../../mail/useInterStem';
import { PERSON_MAIL_BETA_TITLE } from '../../../chats/ChatList';

/**
 * Settings → Features → Your email address: the verified addresses this Stem
 * goes by — other Stems write to it, and public share links carry it — who can
 * find it, and the contacts with their keys.
 */
export function OtherStemsSection() {
  const { status } = useInterStem();
  const [address, setAddress] = useState('');
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [naming, setNaming] = useState<{ address: string; name: string } | null>(null);
  // Forget what Stem learned from mail with someone: asked once, with the count.
  const [forgetting, setForgetting] = useState<{ address: string; facts: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (status.policy?.mode === 'off') {
    return (
      <>
        <div className="grp-head">
        Your email address
        <span className="beta-pill" title={PERSON_MAIL_BETA_TITLE}>
          Beta
        </span>
      </div>
        <div className="group">
          <ValueRow label="Turned off by your organization" hint="No mail with other Stems and no public links" />
        </div>
      </>
    );
  }
  const allowed = status.policy?.mode === 'restricted' ? status.policy.domains : null;

  const verified = status.addresses.filter((a) => a.state === 'verified');
  const contacts = status.contacts.filter((c) => c.state !== 'blocked');
  const blocked = status.contacts.filter((c) => c.state === 'blocked');

  return (
    <>
      <div className="grp-head">
        Your email address
        <span className="beta-pill" title={PERSON_MAIL_BETA_TITLE}>
          Beta
        </span>
      </div>
      <div className="group">
        {allowed && (
          <ValueRow
            label="Limited by your organization"
            hint={`Only addresses at ${allowed.join(', ')}, through your organization's relay`}
          />
        )}
        {status.addresses.map((a) => (
          <ValueRow
            key={a.address}
            label={a.address}
            hint={a.state === 'verified' ? (status.connected ? 'Connected' : 'Connecting…') : 'Waiting for the code we emailed'}
          >
            {a.state === 'pending' ? (
              <span className="row-inline">
                <input
                  className="vfield"
                  inputMode="numeric"
                  placeholder="Code"
                  aria-label={`Code for ${a.address}`}
                  value={codes[a.address] ?? ''}
                  onChange={(e) => setCodes((c) => ({ ...c, [a.address]: e.target.value }))}
                  style={{ width: '6.5em' }}
                />
                <button
                  className="icon-action sm"
                  disabled={busy || !(codes[a.address] ?? '').trim()}
                  title="Confirm the code"
                  aria-label="Confirm the code"
                  onClick={() => void run(() => window.stem.interStemVerifyAddress(a.address, codes[a.address] ?? ''))}
                >
                  <Check size={14} />
                </button>
                <button
                  className="icon-action sm"
                  disabled={busy}
                  title="I used the link in the email instead"
                  aria-label="I used the link in the email"
                  onClick={() => void run(() => window.stem.interStemCheckLink(a.address))}
                >
                  <ShieldCheck size={14} />
                </button>
              </span>
            ) : (
              <button
                className="icon-action sm"
                disabled={busy}
                title="Stop using this address with other Stems"
                aria-label={`Remove ${a.address}`}
                onClick={() => void run(() => window.stem.interStemRemoveAddress(a.address))}
              >
                <Trash2 size={14} />
              </button>
            )}
          </ValueRow>
        ))}
        <ValueRow
          stacked
          label={status.addresses.length ? 'Add another address' : 'Add an address'}
          hint={
            <>
              Other Stems write to you at it, and your shared links show it{' '}
              <InfoTip label="About your email address">
                We email a code to prove the address is yours. Mail between Stems is end-to-end encrypted: the relay
                carrying it can't read it. Mail from others reaches you first; your agents only see what you release,
                and nothing is sent without you. Public links you share carry this address, so every link traces back
                to a real person.
              </InfoTip>
            </>
          }
        >
          <span className="row-inline">
            <input
              className="vfield"
              type="email"
              placeholder={`you@${allowed?.[0] ?? 'example.com'}`}
              aria-label="Your email address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <button
              className="icon-action sm"
              disabled={busy || !address.includes('@')}
              title="Email me a code"
              aria-label="Email me a code"
              onClick={() =>
                void run(async () => {
                  await window.stem.interStemAddAddress(address);
                  setAddress('');
                })
              }
            >
              <Check size={14} />
            </button>
          </span>
        </ValueRow>
        {verified.length > 0 && (
          <ValueRow
            label="Only people I've written to can reach me"
            hint="Everyone else can't tell you use Stem at all"
          >
            <button
              className={`switch${status.unlisted ? ' on' : ''}`}
              role="switch"
              aria-checked={status.unlisted}
              aria-label="Only people I've written to can reach me"
              disabled={busy}
              onClick={() => void run(() => window.stem.interStemSetUnlisted(!status.unlisted))}
            />
          </ValueRow>
        )}
        {verified.length > 0 && (
          <ValueRow label="Your key" hint="Compare it in person to verify each other">
            <code className="vval">{formatFingerprint(status.fingerprint)}</code>
          </ValueRow>
        )}
        {contacts.length > 0 && (
          <DisclosureRow label="Contacts" value={String(contacts.length)}>
            {contacts.map((c) => (
              <ValueRow
                key={c.address}
                label={
                  naming?.address === c.address ? (
                    <input
                      className="mail-ext-rename"
                      value={naming.name}
                      autoFocus
                      placeholder="Their name"
                      aria-label={`Name for ${c.address}`}
                      onChange={(e) => setNaming({ address: c.address, name: e.target.value })}
                      onBlur={() => {
                        const next = naming.name;
                        setNaming(null);
                        if (next.trim() !== (c.name ?? '')) void run(() => window.stem.interStemSetContact(c.address, { name: next }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                      }}
                    />
                  ) : (
                    c.name ?? c.address
                  )
                }
                hint={
                  c.keyChanged
                    ? 'Their key changed — check before writing'
                    : [
                        c.name ? c.address : null,
                        c.state === 'request' ? 'Request' : null,
                        c.verifiedByUser ? 'Verified by you' : c.keyFp ? 'Verified by email' : 'Not written yet',
                        c.autoDraft ? 'Auto-draft on' : null,
                        c.keyFp ? formatFingerprint(c.keyFp) : null
                      ]
                        .filter(Boolean)
                        .join(' · ')
                }
              >
                <span className="row-inline">
                  <button
                    className="icon-action sm"
                    disabled={busy}
                    title={c.name ? 'Rename' : 'Give them a name'}
                    aria-label={`Name ${c.address}`}
                    onClick={() => setNaming({ address: c.address, name: c.name ?? '' })}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className={`icon-action sm${c.autoDraft ? ' on' : ''}`}
                    disabled={busy || !c.verifiedByUser}
                    aria-pressed={!!c.autoDraft}
                    title={
                      !c.verifiedByUser
                        ? 'Auto-draft needs a key you checked with them in person (the shield)'
                        : c.autoDraft
                          ? 'Auto-draft is on: their mail is read by your agents at once and a draft waits for you. Click to turn off.'
                          : 'Auto-draft: when they write, your agents read it and draft a reply for you to send'
                    }
                    aria-label={`Auto-draft for ${c.address}`}
                    onClick={() => void run(() => window.stem.interStemSetContact(c.address, { autoDraft: !c.autoDraft }))}
                  >
                    <Sparkles size={14} />
                  </button>
                  <button
                    className="icon-action sm"
                    disabled={busy}
                    title={c.verifiedByUser ? 'Mark as not checked in person' : 'I compared this key with them in person'}
                    aria-label={c.verifiedByUser ? 'Unverify' : 'Mark verified'}
                    onClick={() => void run(() => window.stem.interStemContact(c.verifiedByUser ? 'unverify' : 'verify', c.address))}
                  >
                    <ShieldCheck size={14} />
                  </button>
                  {forgetting?.address === c.address ? (
                    <span className="row-inline">
                      {forgetting.facts === 0 ? (
                        <span className="muted">Nothing learned yet</span>
                      ) : (
                        <button
                          type="button"
                          className="push danger"
                          disabled={busy}
                          onClick={() => void run(() => window.stem.interStemForgetContact(c.address)).then(() => setForgetting(null))}
                        >
                          Forget {forgetting.facts} {forgetting.facts === 1 ? 'fact' : 'facts'}
                        </button>
                      )}
                      <button type="button" className="push" onClick={() => setForgetting(null)}>
                        {forgetting.facts === 0 ? 'OK' : 'Keep'}
                      </button>
                    </span>
                  ) : (
                    <button
                      className="icon-action sm"
                      disabled={busy}
                      title="What Stem learned from mail with them (used only when you write with them) — forget it"
                      aria-label={`Forget what Stem learned from ${c.address}`}
                      onClick={() =>
                        void run(async () => setForgetting({ address: c.address, facts: (await window.stem.interStemContactMemory(c.address)).facts }))
                      }
                    >
                      <BrainCircuit size={14} />
                    </button>
                  )}
                  <button
                    className="icon-action sm"
                    disabled={busy}
                    title="Block — their mail is dropped and they aren't told"
                    aria-label={`Block ${c.address}`}
                    onClick={() => void run(() => window.stem.interStemContact('block', c.address))}
                  >
                    <UserX size={14} />
                  </button>
                </span>
              </ValueRow>
            ))}
          </DisclosureRow>
        )}
        {blocked.length > 0 && (
          <DisclosureRow label="Blocked" value={String(blocked.length)}>
            {blocked.map((c) => (
              <ValueRow key={c.address} label={c.address}>
                <button
                  className="icon-action sm"
                  disabled={busy}
                  title="Unblock"
                  aria-label={`Unblock ${c.address}`}
                  onClick={() => void run(() => window.stem.interStemContact('unblock', c.address))}
                >
                  <Check size={14} />
                </button>
              </ValueRow>
            ))}
          </DisclosureRow>
        )}
        {error && <p className="task-failed">{error}</p>}
      </div>
    </>
  );
}
