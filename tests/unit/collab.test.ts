import { describe, expect, it } from 'vitest';
import { parseCollab, refreshCollab } from '../../src/server/interstem/collab';
import { appendMailItem, createConversation, readMail, releaseExternalItems } from '../../src/server/workspace/mail';

// Where a conversation with another person stands: written only from mail the
// user's agents may read, rewritten only when there is newer readable mail.

const martin = 'martin@example.test';

describe('collaboration state', () => {
  it('parses and trims what the model wrote, and refuses junk', () => {
    const c = parseCollab('{"goal":"Record the podcast","agreed":["Sunday 15:00"," "],"open":["Topic list"],"next":""}', 'i1', 5);
    expect(c).toEqual({ goal: 'Record the podcast', agreed: ['Sunday 15:00'], open: ['Topic list'], basedOn: 'i1', updatedAt: 5 });
    expect(parseCollab('no json here', 'i1', 5)).toBeNull();
    expect(parseCollab('{"agreed":[]}', 'i1', 5)).toBeNull();
  });

  it('reads only released mail, and only writes again when there is newer mail', async () => {
    const conv = await createConversation('Podcast', [], 'x', { external: { address: martin, thread: 'b'.repeat(32), self: 'me@example.test' } });
    const held = (await appendMailItem({ conversationId: conv.id, from: martin, to: ['user'], body: 'SECRET Sunday?', external: { held: true } })).items.at(-1)!;
    const prompts: string[] = [];
    const llm = { complete: async (p: string) => (prompts.push(p), '{"goal":"Pick a recording day","agreed":[],"open":["Day"],"next":"Answer Martin"}') };
    expect(await refreshCollab(llm, conv.id)).toBe(false);
    expect(prompts).toHaveLength(0);
    await releaseExternalItems(conv.id, held.id);
    expect(await refreshCollab(llm, conv.id)).toBe(true);
    expect(prompts[0]).toContain('SECRET Sunday?');
    // Their words sit inside a random fence; they can't pass for the user's.
    expect(prompts[0]).toMatch(/<outside-mail-[0-9a-f]{12} from="them"/);
    expect((await readMail()).conversations.find((c) => c.id === conv.id)?.collab).toMatchObject({ goal: 'Pick a recording day', basedOn: held.id });
    expect(await refreshCollab(llm, conv.id)).toBe(false);
    expect(prompts).toHaveLength(1);
  });
});
