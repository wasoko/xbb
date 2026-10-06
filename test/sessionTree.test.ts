/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/sdb';
import { getStore } from '../src/recr';
import {
  buildSessionTree, listSessions, loadSessionNodes, loadSessionTree, metaTitle, openNodeId,
  parseRecrTabRef, parseSessionRef, pathToNode, recrRowLabel, recrTabRef, recrTargetOf,
  siblingLabel, siblingsOf, type SessionNode,
} from '../src/sessionTree';
import { listAllSessions, loadTreeFor, registerSessionSource } from '../src/sessionSource';

const SID = 'sess-a';

async function putRow(ref: string, txt: string): Promise<void> {
  await db.das.put({ ref, type: 'recr', txt, rec: {} });
}

const putMeta = (id: string, title = 'New Session'): Promise<void> =>
  putRow(`sess/${id}/meta`, JSON.stringify({
    id, rootNodeId: null, currentHeadId: null, title, source: 'recr', createdAt: 0, updatedAt: 0,
  }));

const putNode = (
  sid: string, id: string, parentId: string | null, timestamp: number
  , prompt = `ask ${id}`, reply = `reply ${id}`,
): Promise<void> =>
  putRow(`sess/${sid}/node/${id}`, JSON.stringify({
    id, parentId, version: 1, timestamp,
    userMessage: { role: 'user', content: prompt },
    assistantResponse: { role: 'assistant', content: reply },
    toolResults: [],
    metadata: {},
  }));

/** Node records of one session, keyed by id, for the pure tree functions. */
const records = (...items: [string, string | null, number][]) =>
  items.map(([id, parentId, timestamp]) =>
    ({ id, parentId, timestamp, prompt: `ask ${id}`, reply: `reply ${id}` }));

beforeEach(async () => {
  await db.das.clear();
});

describe('parseSessionRef', () => {
  it('splits a meta ref and a node ref', () => {
    expect(parseSessionRef('sess/abc/meta')).toEqual({ sessionId: 'abc', kind: 'meta' });
    expect(parseSessionRef('sess/abc/node/n1')).toEqual({ sessionId: 'abc', kind: 'node', nodeId: 'n1' });
  });

  it('rejects a ref that is not a session row', () => {
    for (const ref of ['settings/main', 'src/a.ts', 'sess/abc', 'sess/abc/node', 'sess/abc/node/n1/deep']) {
      expect(parseSessionRef(ref)).toBeUndefined();
    }
  });
});

describe('recr row targets', () => {
  it('round-trips a recr tab ref', () => {
    expect(parseRecrTabRef(recrTabRef('settings/main'))).toBe('settings/main');
    expect(parseRecrTabRef('src/a.ts')).toBeUndefined();
    expect(parseRecrTabRef('recr|')).toBeUndefined();
  });

  it('sends a session row to the session, a node row to the node, and the rest to a tab', () => {
    expect(recrTargetOf(`sess/${SID}/meta`)).toEqual({ kind: 'session', sessionId: SID });
    expect(recrTargetOf(`sess/${SID}/node/n1`)).toEqual({ kind: 'node', sessionId: SID, nodeId: 'n1' });
    expect(recrTargetOf('settings/main')).toEqual({ kind: 'tab', ref: 'settings/main' });
    expect(recrTargetOf('tools/read_file')).toEqual({ kind: 'tab', ref: 'tools/read_file' });
  });
});

describe('buildSessionTree', () => {
  it('places children under their parent and numbers the sibling run', () => {
    const tree = buildSessionTree(records(['n1', null, 1], ['n2', 'n1', 2], ['n3', 'n1', 3]));
    expect(tree.map((n) => [n.id, n.depth])).toEqual([['n1', 0], ['n2', 1], ['n3', 1]]);
    expect(tree[0].childCount).toBe(2);
    expect(tree.slice(1).map((n) => [n.siblingIndex, n.siblingCount, siblingLabel(n)]))
      .toEqual([[0, 2, 'v1/2'], [1, 2, 'v2/2']]);
    expect(tree[0].siblingCount).toBe(1);
    expect(siblingLabel(tree[0])).toBe('');
  });

  it('orders siblings by timestamp, not by arrival', () => {
    const tree = buildSessionTree(records(['n1', null, 1], ['late', 'n1', 30], ['early', 'n1', 10]));
    expect(tree.slice(1).map((n) => n.id)).toEqual(['early', 'late']);
  });

  it('treats a parentId the session does not hold as a root', () => {
    const tree = buildSessionTree(records(['ghost-child', 'missing', 1], ['n1', null, 2]));
    expect(tree.map((n) => [n.id, n.depth])).toEqual([['ghost-child', 0], ['n1', 0]]);
  });

  it('keeps both nodes of a parent cycle', () => {
    const tree = buildSessionTree(records(['a', 'b', 1], ['b', 'a', 2]));
    expect(tree.map((n) => n.id).sort()).toEqual(['a', 'b']);
    // the entry node renders as a root and the other hangs under it, so neither is dropped
    expect(tree[0]).toMatchObject({ id: 'a', depth: 0, childCount: 1 });
    expect(tree[1]).toMatchObject({ id: 'b', depth: 1 });
  });

  it('returns nothing for no records', () => {
    expect(buildSessionTree([])).toEqual([]);
  });
});

describe('siblingsOf and pathToNode', () => {
  const tree: SessionNode[] = buildSessionTree(
    records(['n1', null, 1], ['n2', 'n1', 2], ['n3', 'n1', 3], ['n4', 'n3', 4]),
  );

  it('returns the whole sibling run in order', () => {
    expect(siblingsOf(tree, 'n2').map((n) => n.id)).toEqual(['n2', 'n3']);
    expect(siblingsOf(tree, 'n4').map((n) => n.id)).toEqual(['n4']);
  });

  it('walks from the root to the node', () => {
    expect(pathToNode(tree, 'n4').map((n) => n.id)).toEqual(['n1', 'n3', 'n4']);
  });

  it('returns empty for a node the tree does not hold', () => {
    expect(siblingsOf(tree, 'nope')).toEqual([]);
    expect(pathToNode(tree, 'nope')).toEqual([]);
  });
});

describe('openNodeId', () => {
  const tree = buildSessionTree(records(['n1', null, 1], ['n2', 'n1', 20], ['n3', 'n2', 30]));

  it('keeps a recorded head that the tree holds', () => {
    expect(openNodeId(tree, 'n2')).toBe('n2');
  });

  it('falls back to the newest node for a missing head', () => {
    expect(openNodeId(tree, null)).toBe('n3');
    expect(openNodeId(tree, 'gone')).toBe('n3');
    expect(openNodeId([], null)).toBeNull();
  });
});

describe('listSessions', () => {
  it('titles a session from its meta title and counts its nodes', async () => {
    await putMeta(SID, 'Fix the parser');
    await putNode(SID, 'n1', null, 10);
    await putNode(SID, 'n2', 'n1', 20);

    const [only] = await listSessions(getStore());
    expect(only).toMatchObject({ id: SID, title: 'Fix the parser', source: 'recr', nodeCount: 2, updatedAt: 20 });
  });

  it('falls back to the first user turn while the title is the placeholder', async () => {
    await putMeta('sess-b');
    await putNode('sess-b', 'n2', null, 30, 'second turn');
    await putNode('sess-b', 'n1', null, 10, 'first turn');

    const [only] = await listSessions(getStore());
    expect(only.title).toBe('first turn');
    expect(only.preview).toBe('first turn');
  });

  it('lists a session whose meta row is unreadable', async () => {
    await putRow('sess-c/meta', 'not json');
    await putNode('sess-c', 'n1', null, 5, 'a turn');

    const [only] = await listSessions(getStore());
    expect(only).toMatchObject({ id: 'sess-c', title: 'a turn', nodeCount: 1 });
  });

  it('orders sessions by their newest row, newest first', async () => {
    await putMeta('old');
    await putNode('old', 'n1', null, 10);
    await putMeta('new');
    await putNode('new', 'n1', null, 50);

    expect((await listSessions(getStore())).map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('keeps a session id out of the list when only other refs exist', async () => {
    await putRow('settings/main', '* temperature: 0.7');
    expect(await listSessions(getStore())).toEqual([]);
  });
});

describe('loadSessionNodes', () => {
  it('reads only the asked session', async () => {
    await putNode(SID, 'n1', null, 10);
    await putNode('other', 'n9', null, 10);

    expect((await loadSessionNodes(getStore(), SID)).map((n) => n.id)).toEqual(['n1']);
  });

  it('skips a node row that is not the JSON the tree reads', async () => {
    await putNode(SID, 'n1', null, 10);
    await putRow(`sess/${SID}/node/broken`, 'not json');
    await putRow(`sess/${SID}/node/noid`, '{"parentId":null}');

    expect((await loadSessionTree(getStore(), SID)).map((n) => n.id)).toEqual(['n1']);
  });
});

describe('metaTitle', () => {
  it('returns the title, or nothing for a placeholder or unreadable row', () => {
    expect(metaTitle('{"title":"Real"}')).toBe('Real');
    expect(metaTitle('{"title":"New Session"}')).toBe('');
    expect(metaTitle('{"title":42}')).toBe('');
    expect(metaTitle('nope')).toBe('');
  });
});

describe('recrRowLabel', () => {
  it('names a session row by its title and a node row by its turn', () => {
    expect(recrRowLabel({ ref: 'sess/a/meta', txt: JSON.stringify({ title: 'Real session' }) }))
      .toBe('Real session');
    expect(recrRowLabel({ ref: 'sess/a/meta', txt: '{"title":"New Session"}' }))
      .toBe('a · session');
    const txt = JSON.stringify({
      id: 'n1', parentId: null, userMessage: { role: 'user', content: 'ask\nmore' },
    });
    expect(recrRowLabel({ ref: 'sess/a/node/n1', txt })).toBe('ask');
  });

  it('falls back to the id for an unreadable node row and to the ref for a config row', () => {
    expect(recrRowLabel({ ref: 'sess/a/node/n1', txt: 'not json' })).toBe('a · n1');
    expect(recrRowLabel({ ref: 'settings/main', txt: '* temperature: 0.7' }))
      .toBe('settings/main');
  });
});

describe('source seam', () => {
  it('merges a registered source and reads trees through it', async () => {
    const fake = {
      id: 'dsh',
      label: 'deepseek-harness',
      listSessions: async () => [{
        id: 'dsh-1', title: 'dsh session', source: 'dsh', updatedAt: 5, nodeCount: 1, preview: '',
      }],
      loadTree: async (): Promise<SessionNode[]> => [{
        id: 'x', parentId: null, timestamp: 1, prompt: 'p', reply: '', depth: 0
        , siblingIndex: 0, siblingCount: 1, siblingIds: ['x'], childCount: 0,
      }],
    };
    const off = registerSessionSource(fake);
    try {
      expect((await listAllSessions(getStore())).map((s) => s.id)).toContain('dsh-1');
      expect((await loadTreeFor(getStore(), 'dsh-1', 'dsh')).map((n) => n.id)).toEqual(['x']);
    } finally {
      off();
    }
    expect((await listAllSessions(getStore())).map((s) => s.id)).not.toContain('dsh-1');
  });

  it('reports an empty tree instead of throwing when a source fails', async () => {
    const bad = {
      id: 'broken',
      label: 'broken',
      listSessions: async () => { throw new Error('source down'); },
      loadTree: async () => { throw new Error('source down'); },
    };
    const off = registerSessionSource(bad);
    try {
      await expect(listAllSessions(getStore())).resolves.toEqual([]);
      await expect(loadTreeFor(getStore(), 'x', 'broken')).resolves.toEqual([]);
    } finally {
      off();
    }
  });
});
