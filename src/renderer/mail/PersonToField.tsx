import { useEffect, useMemo, useState } from 'react';
import { Check, UserPlus } from 'lucide-react';
import type { InterStemContact, InterStemReach } from '../../shared/types';

// The To field of a mail to a person: their email address, with the user's
// contacts offered as they type and a check, once it looks like an address,
// of whether it reaches someone on Stem. Lookups are rate-limited on the
// relay, so the check waits for a pause in typing (and the server caches it).

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The address out of "Name <address>" (what picking a suggestion can leave), or the text. */
export function addressOf(text: string): string {
  const m = /<([^<>]+)>\s*$/.exec(text);
  return (m ? m[1] : text).trim().toLowerCase();
}

/** Whether the compose form may send to this answer. */
export function sendableReach(reach: InterStemReach | null): boolean {
  return !reach || reach.state === 'reachable' || reach.state === 'unreachable';
}

export function PersonToField({
  value,
  onChange,
  contacts,
  onReach
}: {
  value: string;
  onChange: (text: string) => void;
  contacts: InterStemContact[];
  /** The latest check, or null while unknown. */
  onReach: (reach: InterStemReach | null) => void;
}) {
  const address = addressOf(value);
  const [reach, setReach] = useState<{ address: string; reach: InterStemReach } | null>(null);
  const [invited, setInvited] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const known = useMemo(() => contacts.filter((c) => c.state !== 'blocked'), [contacts]);

  useEffect(() => {
    if (!ADDRESS.test(address)) {
      onReach(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      window.stem
        .interStemLookup(address)
        .then((r) => {
          if (!live) return;
          setReach({ address, reach: r });
          setError(null);
          onReach(r);
        })
        .catch((e) => {
          if (!live) return;
          // Unknown is not a refusal: the send itself finds out.
          setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
          onReach(null);
        });
    }, 700);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [address, onReach]);

  const current = reach?.address === address ? reach.reach : null;
  const contact = known.find((c) => c.address === address);
  const invite = () => {
    setInvited(address);
    window.stem.interStemInvite(address).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="mail-person-to">
      <input
        type="email"
        list="mail-person-contacts"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="their@email.com"
        aria-label="Their email address"
        autoFocus
      />
      <datalist id="mail-person-contacts">
        {known.map((c) => (
          <option key={c.address} value={c.address}>
            {c.name ?? c.address}
          </option>
        ))}
      </datalist>
      {contact?.name && <span className="mail-person-name">{contact.name}</span>}
      {ADDRESS.test(address) && (current || error) && (
        <p className={`mail-person-reach ${current?.state ?? 'unknown'}`} aria-live="polite">
          {error && !current ? (
            <>Couldn’t check yet ({error}). You can still send.</>
          ) : current?.state === 'reachable' ? (
            <>
              <Check size={12} /> On Stem
            </>
          ) : current?.state === 'unreachable' ? (
            <>
              Not on Stem yet. Your mail waits here, and Stem tells you when it can reach them.
              {invited === address ? (
                <span className="muted"> Invite sent.</span>
              ) : (
                <button type="button" className="push" onClick={invite}>
                  <UserPlus size={12} /> Invite them
                </button>
              )}
            </>
          ) : current?.state === 'self' ? (
            <>That’s your own address.</>
          ) : current?.state === 'blocked' ? (
            <>You blocked them. Unblock them in Settings → Features first.</>
          ) : current?.state === 'refused' ? (
            <>{current.reason}</>
          ) : null}
        </p>
      )}
    </div>
  );
}
