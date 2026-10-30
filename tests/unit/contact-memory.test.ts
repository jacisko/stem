import { describe, expect, it } from 'vitest';
import { learnFromPersonMail, CONTACT_FACT_CONFIDENCE } from '../../src/server/interstem/contact-memory';
import { recallStore } from '../../src/server/recall/store';
import { ftsSearchFacts } from '../../src/server/recall/search-core';
import { appendMailItem, createConversation, releaseExternalItems } from '../../src/server/workspace/mail';
import { recallToolParams } from '../../src/server/pi/stem-mcp-extension.mjs';

// Facts learned from mail with another person: only from mail the user let
// their agents read, tagged with that person, and recalled only with them.

const martin = 'martin@example.test';

describe('contact memory', () => {
  it('learns only from released mail, and keeps the facts to turns with that person', async () => {
    const conv = await createConversation('Podcast', [], 'x', { external: { address: martin, thread: 'a'.repeat(32), self: 'me@example.test' } });
    await appendMailItem({ conversationId: conv.id, from: martin, to: ['user'], body: 'I can only record on Sunday afternoons.', external: { held: true } });
    const prompts: string[] = [];
    const llm = {
      complete: async (p: string) => {
        prompts.push(p);
        return JSON.stringify({ claims: [{ text: 'Prefers to record podcasts on Sunday afternoons.', category: 'preference', sensitivity: 'standard', validUntil: null }] });
      }
    };
    // Held: the model never sees it.
    expect(await learnFromPersonMail(llm, conv.id)).toBe(0);
    expect(prompts).toHaveLength(0);

    const held = (await appendMailItem({ conversationId: conv.id, from: 'user', to: [martin], body: 'Sunday works.', external: { status: 'sent' } })).items;
    await releaseExternalItems(conv.id, held.find((i) => i.from === martin)!.id);
    expect(await learnFromPersonMail(llm, conv.id)).toBe(1);
    expect(prompts[0]).toContain('Sunday afternoons');
    // Nothing new since: no second call.
    expect(await learnFromPersonMail(llm, conv.id)).toBe(0);
    expect(prompts).toHaveLength(1);

    const fact = recallStore.getAllFacts().find((f) => f.source === `contact:${martin}`)!;
    expect(fact.text).toBe(`${martin}: Prefers to record podcasts on Sunday afternoons.`);
    expect(fact.confidence).toBe(CONTACT_FACT_CONFIDENCE);

    // Injected only in a turn with Martin.
    expect(recallStore.getInjectableFacts().some((f) => f.id === fact.id)).toBe(false);
    expect(recallStore.getInjectableFacts('eva@example.test').some((f) => f.id === fact.id)).toBe(false);
    expect(recallStore.getInjectableFacts(martin).some((f) => f.id === fact.id)).toBe(true);
    // search_facts the same way.
    // A real corpus: BM25 over a single row scores ~0, under the search's floor.
    for (const t of ['The user drives a blue Skoda.', 'The user has two children.', 'The user works at Awantech.', 'The user likes jazz.'])
      recallStore.upsertFact(t, { source: 'explicit' });
    const db = recallStore.dbHandle();
    expect(ftsSearchFacts(db, 'podcasts Sunday', 10).some((h) => h.id === fact.id)).toBe(false);
    expect(ftsSearchFacts(db, 'podcasts Sunday', 10, martin).some((h) => h.id === fact.id)).toBe(true);
  });

  it('stamps the turn’s contact on search_facts and drops one the model made up', () => {
    expect(recallToolParams('stem-recall', 'search_facts', { query: 'x', __contact: 'eva@example.test' }, { contact: martin })).toEqual({
      query: 'x',
      __contact: martin
    });
    expect(recallToolParams('stem-recall', 'search_facts', { query: 'x', __contact: martin }, { contact: null })).toEqual({
      query: 'x',
      __contact: null
    });
    expect(recallToolParams('stem-recall', 'search_past_chats', { query: 'x', __contact: martin }, null)).toEqual({ query: 'x' });
  });
});
