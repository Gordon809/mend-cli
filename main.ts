// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One body line of a hunk or chunk: context (in both O and N), old (O only), new (N only), or a `\` marker. */
type BodyKind = 'ctx' | 'old' | 'new' | 'mark';
interface BodyItem {
  kind: BodyKind;
  text: string;
}

/** A file as lines: its line break, its lines, whether it ends with a break. */
interface Doc {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { br, lines, finalBreak };
}

function renderDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.finalBreak ? d.br : '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions at or after `from` where O matches lines at tier. */
function tierOccurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const want = O.map((l) => normLine(l, tier));
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], O: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = tierOccurrences(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The lines replacing O's match at pos: context lines as the file's own, other lines re-indented at tier 2. */
function buildReplacement(O: BodyItem[], N: BodyItem[], fileLines: string[], pos: number, tier: number): string[] {
  const pfx = O.length > 0 ? leadingWS(O[0]!.text) : '';
  const fpfx = leadingWS(fileLines[pos] ?? '');
  const out: string[] = [];
  for (const item of N) {
    if (item.kind === 'ctx') {
      out.push(fileLines[pos + O.indexOf(item)]!);
    } else if (tier === 2) {
      const line = item.text;
      if (line === '' || /^[ \t]*$/.test(line) || !line.startsWith(pfx)) out.push(line);
      else out.push(fpfx + line.slice(pfx.length));
    } else {
      out.push(item.text);
    }
  }
  return out;
}

/** Apply unified hunks to a doc's lines, in order, each to the result of the ones before it. */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const O = h.items.filter((it) => it.kind === 'ctx' || it.kind === 'old');
    const N = h.items.filter((it) => it.kind === 'ctx' || it.kind === 'new');
    if (O.length === 0 && N.length === 0) continue;
    if (O.length === 0) {
      const beforeLen = doc.lines.length;
      const at = Math.min(Math.max(h.a + d, 0), beforeLen);
      const ins = N.map((it) => it.text);
      doc.lines.splice(at, 0, ...ins);
      if (at === beforeLen) doc.finalBreak = !h.backslashAfterLast;
      d += N.length;
      continue;
    }
    const found = findTier(doc.lines, O.map((it) => it.text), strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const beforeLen = doc.lines.length;
    const rep = buildReplacement(O, N, doc.lines, pos, found.tier);
    doc.lines.splice(pos, O.length, ...rep);
    if (pos + O.length === beforeLen) {
      doc.finalBreak = N.length === 0 ? true : !h.backslashAfterLast;
    }
    d += N.length - O.length;
  }
}

/** Apply V4A chunks to a doc's lines, in order, with a cursor starting at line 0. */
function applyV4aChunks(doc: Doc, chunks: V4aChunk[], strict: boolean, path: string): void {
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const tiers = strict ? [0] : [0, 1, 2];
      let foundIdx = -1;
      for (const t of tiers) {
        for (let j = cursor; j < doc.lines.length; j++) {
          if (normLine(doc.lines[j]!, t) === normLine(ch.anchor, t)) {
            foundIdx = j;
            break;
          }
        }
        if (foundIdx >= 0) break;
      }
      if (foundIdx < 0) throw new Fail('no-match', path);
      cursor = foundIdx + 1;
    }
    const O = ch.items.filter((it) => it.kind === 'ctx' || it.kind === 'old');
    const N = ch.items.filter((it) => it.kind === 'ctx' || it.kind === 'new');
    if (O.length === 0) {
      const at = ch.eof ? doc.lines.length : cursor;
      const ins = N.map((it) => it.text);
      doc.lines.splice(at, 0, ...ins);
      cursor = at + ins.length;
      continue;
    }
    const found = findTier(doc.lines, O.map((it) => it.text), strict, cursor);
    if (found === null) throw new Fail('no-match', path);
    let occ = found.occ;
    if (ch.eof) {
      occ = occ.filter((p) => p + O.length === doc.lines.length);
      if (occ.length === 0) throw new Fail('no-match', path);
    }
    const pos = occ[0]!;
    const rep = buildReplacement(O, N, doc.lines, pos, found.tier);
    doc.lines.splice(pos, O.length, ...rep);
    cursor = pos + rep.length;
  }
}

interface Hunk {
  a: number;
  items: BodyItem[];
  backslashAfterLast: boolean;
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface UnifiedSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** A unified `---`/`+++` path: text after the four characters, up to the first tab, trimmed; /dev/null is no file. */
function unifiedPath(raw: string): string | null {
  const tab = raw.indexOf('\t');
  const cut = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (cut === '/dev/null') return null;
  if (cut.startsWith('a/')) return cut.slice(2);
  if (cut.startsWith('b/')) return cut.slice(2);
  return cut;
}

/** Unified diffs (SPEC.md section 6): one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  const newSection = (): UnifiedSection => {
    const s: UnifiedSection = { pairOld: undefined, pairNew: undefined, renameOld: null, renameNew: null, diffOld: null, diffNew: null, isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && cur.pairOld === undefined && cur.pairNew === undefined) {
        cur.pairOld = unifiedPath(l.slice(4));
        cur.pairNew = unifiedPath(lines[i + 1]!.slice(4));
      } else {
        cur = newSection();
        cur.pairOld = unifiedPath(l.slice(4));
        cur.pairNew = unifiedPath(lines[i + 1]!.slice(4));
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i += 1;
      const items: BodyItem[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') items.push({ kind: 'ctx', text: '' });
        else if (b[0] === ' ') items.push({ kind: 'ctx', text: b.slice(1) });
        else if (b[0] === '-') items.push({ kind: 'old', text: b.slice(1) });
        else if (b[0] === '+') items.push({ kind: 'new', text: b.slice(1) });
        else if (b[0] === '\\') items.push({ kind: 'mark', text: b });
        else break;
        i += 1;
      }
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') items.pop();
        else break;
      }
      let backslashAfterLast = false;
      for (let k = items.length - 1; k >= 0; k--) {
        const it = items[k]!;
        if (it.kind === 'ctx' || it.kind === 'new') {
          backslashAfterLast = k + 1 < items.length && items[k + 1]!.kind === 'mark';
          break;
        }
      }
      cur.hunks.push({ a, items, backslashAfterLast });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.pairNew = unifiedPath(l.slice(4));
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameOld = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameNew = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath = s.pairOld !== undefined ? s.pairOld : s.renameOld ?? s.diffOld;
    const newPath = s.pairNew !== undefined ? s.pairNew : s.renameNew ?? s.diffNew;
    const hunks = s.hunks;
    const checkSafe = (op: string | null, np: string | null): void => {
      if (op !== null && !safe(op)) throw new Fail('unsafe', op);
      if (np !== null && np !== op && !safe(np)) throw new Fail('unsafe', np);
    };
    if (oldPath === null || s.isCreate) {
      const np = newPath;
      edits.push((tree) => {
        if (np === null) return;
        checkSafe(oldPath, np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        let lastPlusSlash = false;
        for (const h of hunks) {
          for (let k = 0; k < h.items.length; k++) {
            const it = h.items[k]!;
            if (it.kind === 'new') {
              plus.push(it.text);
              lastPlusSlash = k + 1 < h.items.length && h.items[k + 1]!.kind === 'mark';
            }
          }
        }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastPlusSlash ? '' : '\n'));
      });
      continue;
    }
    if (newPath === null || s.isDelete) {
      const op = oldPath;
      edits.push((tree) => {
        checkSafe(op, newPath);
        if (op === null) throw new Fail('missing', '');
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      });
      continue;
    }
    if (oldPath !== newPath) {
      edits.push((tree) => {
        checkSafe(oldPath, newPath);
        const text = tree.get(oldPath);
        if (text === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const doc = parseDoc(text);
        applyHunks(doc, hunks, strict, oldPath);
        tree.now.set(newPath, renderDoc(doc));
        tree.now.set(oldPath, null);
        tree.moves.push([oldPath, newPath]);
      });
      continue;
    }
    const p = oldPath;
    edits.push((tree) => {
      checkSafe(p, newPath);
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const doc = parseDoc(text);
      applyHunks(doc, hunks, strict, p);
      tree.now.set(p, renderDoc(doc));
    });
  }
  return edits;
}

/** SEARCH/REPLACE blocks (SPEC.md section 7): one edit per block. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (l.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = parseDoc(before);
      const found = findTier(doc.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const O: BodyItem[] = oldLines.map((t) => ({ kind: 'old', text: t }));
      const N: BodyItem[] = newLines.map((t) => ({ kind: 'new', text: t }));
      const repLines = buildReplacement(O, N, doc.lines, pos, found.tier);
      doc.lines.splice(pos, oldLines.length, ...repLines);
      tree.now.set(p, renderDoc(doc));
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** V4A patches (SPEC.md section 8): one edit per section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const m = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(l);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    const start = i + 1;
    let end = start;
    while (end < last) {
      const s = lines[end]!;
      if (s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ')) break;
      end += 1;
    }
    const secLines = lines.slice(start, end);
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) secLines.pop();
    if (kind === 'Add File') {
      for (let k = 0; k < secLines.length; k++) {
        const sl = secLines[k]!;
        if (sl !== '' && !sl.startsWith('+')) throw new Exit2(`error: parse ${start + k + 1}`);
      }
      const fileLines = secLines.map((sl) => (sl === '' ? '' : sl.slice(1)));
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'Delete File') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${start + 1}`);
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (secLines.length > 0 && secLines[0]!.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (; k < secLines.length; k++) {
        const sl = secLines[k]!;
        const lineNo = start + k + 1;
        if (sl.startsWith('@@')) {
          cur = { anchor: sl.slice(2).trim() || null, eof: false, items: [] };
          chunks.push(cur);
          continue;
        }
        if (sl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (sl.startsWith('*** ')) throw new Exit2(`error: parse ${lineNo}`);
        if (sl === '' || sl[0] === ' ' || sl[0] === '-' || sl[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          if (sl === '') cur.items.push({ kind: 'ctx', text: '' });
          else if (sl[0] === ' ') cur.items.push({ kind: 'ctx', text: sl.slice(1) });
          else if (sl[0] === '-') cur.items.push({ kind: 'old', text: sl.slice(1) });
          else cur.items.push({ kind: 'new', text: sl.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const doc = parseDoc(before);
        applyV4aChunks(doc, chs, strict, p);
        const out = renderDoc(doc);
        if (mt !== null) {
          tree.now.set(mt, out);
          tree.now.set(p, null);
          tree.moves.push([p, mt]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
    i = end;
  }
  return edits;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, for the `R` output rows. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      const oi = entries.findIndex((e) => e.key === oldP && e.line === `D ${oldP}`);
      const ni = entries.findIndex((e) => e.key === newP && e.line === `A ${newP}`);
      if (oi >= 0 && ni >= 0) {
        entries.splice(Math.max(oi, ni), 1);
        entries.splice(Math.min(oi, ni), 1);
        entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      }
    }
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
