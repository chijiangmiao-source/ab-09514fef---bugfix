// 验收测试：17 条长度 8、阈值 2 的条码批次（含一条冲突链的两个同优方案）。
// 按生成规则构造批次，核对总优先权/入选数/同优数/逐条归属/规范位向量，
// 独立穷举复算同优方案与位向量的无互斥、数量与权和，并覆盖 Worker
// 返回消息的字段一致性。
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import {
  normalizeRows,
  auditRecords,
  hamming,
  reverseComplement,
} from '../src/lib/optimizer.js';

// ---- 按规范生成批次 ----
// 恰含四个 C 的八位条码（A 先于 C 的字典序），逐个枚举：
// 以 0/1 掩码按高位到低位生成，mask 递增恰为 A<C 字典序。
function fourCBarcodes() {
  const out = [];
  for (let mask = 0; mask < 1 << 8; mask++) {
    let s = '';
    for (let i = 7; i >= 0; i--) s += ((mask >> i) & 1) ? 'C' : 'A';
    if ((s.match(/C/g) || []).length === 4) out.push(s);
  }
  return out;
}

// 前 11 个满足：不以 CCC 开头、不等于 AAAACCCC、与 CAAACCCC 汉明距离不为 1
function buildFillers() {
  const near = 'CAAACCCC';
  const fillers = [];
  for (const s of fourCBarcodes()) {
    if (s.startsWith('CCC')) continue;
    if (s === 'AAAACCCC') continue;
    if (hamming(s, near) === 1) continue;
    fillers.push(s);
    if (fillers.length === 11) break;
  }
  return fillers;
}

// 位置按 1 起计；固定 6 条，其余 11 个位置按次序填入 fillers，优先权均为 1。
const FIXED = new Map([
  [1, { barcode: 'AAAAAAAA', priority: 1 }],
  [5, { barcode: 'CAAAAAAA', priority: 2 }],
  [9, { barcode: 'CCCAAAAA', priority: 2 }],
  [13, { barcode: 'CCAAAAAA', priority: 3 }],
  [14, { barcode: 'AAAACCCC', priority: 4 }],
  [15, { barcode: 'CAAACCCC', priority: 3 }],
]);

function buildBatch() {
  const fillers = buildFillers();
  assert.equal(fillers.length, 11);
  const rows = [];
  let fi = 0;
  for (let pos = 1; pos <= 17; pos++) {
    const f = FIXED.get(pos);
    if (f) rows.push({ barcode: f.barcode, priority: f.priority, threshold: 2 });
    else rows.push({ barcode: fillers[fi++], priority: 1, threshold: 2 });
  }
  return rows;
}

// 独立互斥判定（不依赖 buildGraph）：
// 自身反向互补距离不足阈值 → 无资格；否则取双向组合最小距离与较大阈值比较。
function isConflict(a, b) {
  return Math.min(hamming(a.seq, b.seq), hamming(a.seq, reverseComplement(b.seq)))
    < Math.max(a.threshold, b.threshold);
}

describe('17 条批次验收', () => {
  const rows = buildBatch();
  let parsed;
  let res;

  test('生成规则：17 条、长度 8、阈值 2、唯一且全部合格', () => {
    assert.equal(rows.length, 17);
    assert.ok(rows.every((r) => r.barcode.length === 8 && /^[AC]+$/.test(r.barcode)));
    assert.ok(rows.every((r) => r.threshold === 2));
    assert.equal(new Set(rows.map((r) => r.barcode)).size, 17);
    parsed = normalizeRows(rows);
    assert.equal(parsed.ok, true, parsed.errors.join('; '));
    assert.equal(parsed.records.length, 17);
    // 四条含四个 C 的固定条码自身反向互补距离为 8，其余 A/C 条码同样自洽
    assert.ok(parsed.records.every((r) => !r.selfConflict));
  });

  test('汇总：总优先权 19、入选 14、同优方案恰为 2', async () => {
    res = await auditRecords(parsed.records);
    assert.equal(res.totalPriority, 19n);
    assert.equal(res.selectedCount, 14);
    assert.equal(res.optimalCount, 2n);
  });

  test('逐条归属：1/5/9/13 可选，15 从不选，其余必选', () => {
    const optional = new Set([1, 5, 9, 13]);
    for (let i = 0; i < 17; i++) {
      const pos = i + 1;
      if (pos === 15) assert.equal(res.status[i], 'never', `第 ${pos} 条`);
      else if (optional.has(pos)) assert.equal(res.status[i], 'optional', `第 ${pos} 条`);
      else assert.equal(res.status[i], 'mandatory', `第 ${pos} 条`);
    }
  });

  test('规范位向量：11110111011111011（输入次序选中优先）', () => {
    const EXPECTED = '11110111011111011';
    assert.equal(res.bitVector, EXPECTED);
    assert.deepEqual(Array.from(res.canonical), [...EXPECTED].map(Number));
    assert.deepEqual(
      res.selectedIndices.map((i) => i + 1),
      [1, 2, 3, 4, 6, 7, 8, 10, 11, 12, 13, 14, 16, 17],
    );
  });

  test('独立复算位向量：选中记录两两不互斥', () => {
    const picked = res.selectedIndices.map((i) => parsed.records[i]);
    for (let a = 0; a < picked.length; a++) {
      for (let b = a + 1; b < picked.length; b++) {
        assert.equal(
          isConflict(picked[a], picked[b]), false,
          `第 ${picked[a].index + 1} 条与第 ${picked[b].index + 1} 条不应互斥`,
        );
      }
    }
  });

  test('独立复算位向量：数量为 14、优先权之和为 19', () => {
    assert.equal(res.selectedIndices.length, 14);
    const sum = res.selectedIndices.reduce((acc, i) => acc + BigInt(rows[i].priority), 0n);
    assert.equal(sum, 19n);
  });

  test('独立穷举全部方案：恰有 2 个双层最优集，且与位向量同为最优', () => {
    const recs = parsed.records;
    const optimal = [];
    let bestW = -1n;
    let bestS = -1;
    for (let mask = 0; mask < 1 << 17; mask++) {
      const chosen = [];
      for (let i = 0; i < 17; i++) if ((mask >> i) & 1) chosen.push(i);
      let ok = true;
      outer:
      for (let a = 0; a < chosen.length; a++) {
        for (let b = a + 1; b < chosen.length; b++) {
          if (isConflict(recs[chosen[a]], recs[chosen[b]])) { ok = false; break outer; }
        }
      }
      if (!ok) continue;
      const w = chosen.reduce((acc, i) => acc + BigInt(rows[i].priority), 0n);
      const s = chosen.length;
      if (w > bestW || (w === bestW && s > bestS)) {
        bestW = w; bestS = s; optimal.length = 0; optimal.push(mask);
      } else if (w === bestW && s === bestS) {
        optimal.push(mask);
      }
    }
    assert.equal(bestW, 19n);
    assert.equal(bestS, 14);
    assert.equal(optimal.length, 2);

    // 两个方案只在冲突链上不同：{1,13} 或 {5,9}；均含 14、不含 15
    const chainA = new Set([1, 13]);
    const chainB = new Set([5, 9]);
    const sigs = optimal.map((mask) => {
      const picked = new Set();
      for (let i = 0; i < 17; i++) if ((mask >> i) & 1) picked.add(i + 1);
      assert.ok(picked.has(14), '两个方案都应选第 14 条');
      assert.ok(!picked.has(15), '两个方案都不应选第 15 条');
      return picked.has(1) && picked.has(13) ? 'A'
        : picked.has(5) && picked.has(9) ? 'B' : null;
    });
    assert.ok(sigs.includes('A') && sigs.includes('B') && sigs.every(Boolean));
    // 两方案除冲突链四位外完全一致（均为 14 条：链上各取 2 条）
    const [m1, m2] = optimal;
    const common = m1 & m2;
    const chainBits = (1 << 0) | (1 << 4) | (1 << 8) | (1 << 12);
    assert.equal((m1 ^ m2) & ~chainBits, 0);
    assert.equal(common & chainBits, 0);

    // 输入次序选中优先 → 第一位选 1，即取链 {1,13} 的方案
    const canonicalMask = res.canonical.reduce((acc, bit, i) => acc | (bit << i), 0);
    assert.ok(optimal.includes(canonicalMask));
    assert.equal(canonicalMask & 1, 1, '选中优先应包含第 1 条');
  });
});

describe('17 条批次经 Worker 返回后的字段一致性', () => {
  const workers = [];
  after(async () => {
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  });

  test('done 消息各字段相互一致且与直接求解吻合', async () => {
    const rows = buildBatch();
    const w = new Worker(new URL('../src/web/worker.js', import.meta.url));
    workers.push(w);
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 Worker done 超时')), 20000);
      w.on('message', (m) => {
        if (m.type === 'progress') return;
        clearTimeout(timer);
        resolve(m);
      });
      w.on('error', reject);
      w.postMessage({ type: 'audit', id: 77, rows });
    });

    assert.equal(msg.type, 'done');
    assert.equal(msg.id, 77);
    const r = msg.result;
    // 任意精度字段为十进制字符串
    assert.equal(typeof r.totalPriority, 'string');
    assert.equal(typeof r.optimalCount, 'string');
    assert.equal(r.totalPriority, '19');
    assert.equal(r.optimalCount, '2');
    // 数量字段与位向量一致
    assert.equal(r.selectedCount, 14);
    assert.equal(r.bitVector, '11110111011111011');
    assert.equal(r.canonical.length, 17);
    assert.equal(r.status.length, 17);
    assert.equal(Array.from(r.canonical).join(''), r.bitVector);
    assert.equal(r.canonical.filter(Boolean).length, r.selectedCount);
    assert.deepEqual(
      r.selectedIndices.map((i) => i + 1),
      [1, 2, 3, 4, 6, 7, 8, 10, 11, 12, 13, 14, 16, 17],
    );
    // 由行数据独立求和，与字符串字段一致
    const sum = r.selectedIndices.reduce((acc, i) => acc + BigInt(rows[i].priority), 0n);
    assert.equal(sum, BigInt(r.totalPriority));
    // 归属标签与位向量相容：必选/从不选者位固定，可选者至少一位两种取值
    for (let i = 0; i < 17; i++) {
      if (r.status[i] === 'mandatory') assert.equal(r.canonical[i], 1, `第 ${i + 1} 条必选`);
      if (r.status[i] === 'never') assert.equal(r.canonical[i], 0, `第 ${i + 1} 条从不选`);
    }
    assert.deepEqual(
      r.status,
      ['optional', 'mandatory', 'mandatory', 'mandatory',
       'optional', 'mandatory', 'mandatory', 'mandatory',
       'optional', 'mandatory', 'mandatory', 'mandatory',
       'optional', 'mandatory', 'never',
       'mandatory', 'mandatory'],
    );
    // eligible / selectedIndices 均为索引数组且后者是前者子集
    assert.ok(r.eligible.length === 17);
    assert.ok(r.selectedIndices.every((i) => r.eligible.includes(i)));
  });
});
