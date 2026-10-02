/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, iq } from '../src/sdb';
import {
  buildPromptFromNode, createBranchingSession, getStore, loadBranchingSession,
  saveTurnNode, validateToolMessages,
  type ChatMessage, type ToolMessage, type TurnNode,
} from '../src/recr';

const SID = 'sess-test';

function node(id: string, parentId: string | null, extra: Partial<TurnNode> = {}): TurnNode {
  return {
    id, parentId, version: 1, timestamp: Date.now(),
    userMessage: { role: 'user', content: `ask ${id}` },
    assistantResponse: { role: 'assistant', content: `reply ${id}` },
    toolResults: [],
    metadata: {},
    ...extra,
  };
}

async function seed(nodes: TurnNode[]) {
  const session = createBranchingSession(SID);
  for (const n of nodes) await saveTurnNode(getStore(), session, n);
  return session;
}

beforeEach(async () => {
  await db.das.clear();
});

describe('branch persistence', () => {
  it('keeps sessions, nodes, and head under recr refs in db.das', async () => {
    await seed([node('n1', null)]);

    const meta = await db.das.where('[ref+type]').equals([`sess/${SID}/meta`, 'recr']).first();
    expect(JSON.parse(meta!.txt).currentHeadId).toBe('n1');

    const stored = await db.das.where('[ref+type]').equals([`sess/${SID}/node/n1`, 'recr']).first();
    expect(stored?.tags).toBeUndefined();
    expect((JSON.parse(stored!.txt) as TurnNode).userMessage.content).toBe('ask n1');
  });

  it('advances the head to the newest node', async () => {
    await seed([node('n1', null), node('n2', 'n1')]);
    const session = await loadBranchingSession(getStore(), SID);
    expect(session.currentHeadId).toBe('n2');
  });

  it('replays user, assistant, and tool turns in order from the head', async () => {
    const tool: ToolMessage = { role: 'tool', tool_call_id: 'c1', content: 'file body' };
    await seed([
      node('n1', null),
      node('n2', 'n1', {
        assistantResponse: { role: 'assistant', content: 'used a tool'
          , tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        toolResults: [tool],
      }),
    ]);

    const messages = await buildPromptFromNode('n2', await loadBranchingSession(getStore(), SID)
      , getStore(), 'system prompt', []);

    expect(messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'tool']);
    expect(messages[1]).toEqual({ role: 'user', content: 'ask n1' });
    expect(messages[4]).toMatchObject({ content: 'used a tool' });
    expect(messages[5]).toEqual(tool);
  });

  it('replays the same branch the same way twice', async () => {
    const session = await seed([node('n1', null), node('n2', 'n1')]);
    const first = await buildPromptFromNode('n2', session, getStore(), '', []);
    const second = await buildPromptFromNode('n2', session, getStore(), '', []);
    expect(second).toEqual(first);
  });

  it('starts a new session when the store holds no meta row', async () => {
    const session = await loadBranchingSession(getStore(), 'never-seen');
    expect(session.currentHeadId).toBeNull();
    expect(session.id).toBe('never-seen');
  });

  it('hides recr rows from the tag query the UI reads', async () => {
    await seed([node('n1', null)]);
    await db.das.put({ ref: 'src/a.ts', type: 'src', txt: 'body', rec: {}, tags: ['ai'] });

    const rows = await iq([]);
    expect(rows.map(r => r.ref)).toEqual(['src/a.ts']);
  });
});

describe('validateToolMessages', () => {
  /** Fresh per test: the strip step mutates the assistant it is given. */
  const toolCallAssistant = (): ChatMessage => ({ role: 'assistant', content: null
    , tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });

  it('drops a tool result with no matching tool call', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'orphan', content: 'lost' },
    ];
    expect(validateToolMessages(messages)).toHaveLength(1);
  });

  it('strips tool calls that lost their results', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }, toolCallAssistant()];
    const kept = validateToolMessages(messages, { stripOrphanedToolCalls: true });
    expect(kept).toHaveLength(2);
    expect((kept[1] as { tool_calls?: unknown }).tool_calls).toBeUndefined();
  });

  it('keeps a tool call whose result follows it', () => {
    const messages: ChatMessage[] = [
      toolCallAssistant(), { role: 'tool', tool_call_id: 'c1', content: 'body' },
    ];
    const kept = validateToolMessages(messages, { stripOrphanedToolCalls: true });
    expect(kept).toHaveLength(2);
    expect((kept[0] as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1);
  });
});
