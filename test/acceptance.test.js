// 验收测试：按既定生成规则构造 17 条批次，核对汇总、逐条归属与规范位向量，
// 并对位向量做独立复算（无互斥、数量与优先权之和）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hamming,
  reverseComplement,
  normalizeRows,
  auditRecords,
} from '../src/lib/optimizer.js';
import {
  buildAcceptanceRows,
  acceptanceCandidates,
  EXPECTED,
} from './acceptance-batch.mjs';

describe('验收批次：生成规则自检', () => {
  test('候选为字典序前 11 个合法四 C 条码', () => {
    const c = acceptanceCandidates();
    assert.ok(c.length >= 11, `合法候选应不少于 11 个，实际 ${c.length}`);
    // 字典序（A<C）单调递增
    for (let i = 1; i < c.length; i++) assert.ok(c[i - 1] < c[i], `${c[i - 1]} !< ${c[i]}`);
    // 每条恰含四个 C，且满足三条排除规则
    for (const s of c) {
      assert.equal([...s].filter((ch) => ch === 'C').length, 4);
      assert.ok(!s.startsWith('CCC'));
      assert.notEqual(s, 'AAAACCCC');
      assert.notEqual(hamming(s, 'CAAACCCC'), 1);
    }
  });

  test('批次为 17 条、阈值均为 2、特定位次与优先权正确', () => {
    const rows = buildAcceptanceRows();
    assert.equal(rows.length, 17);
    for (const r of rows) assert.equal(r.threshold, '2');
    const expectSpecial = {
      1: ['AAAAAAAA', '1'], 5: ['CAAAAAAA', '2'], 9: ['CCCAAAAA', '2'],
      13: ['CCAAAAAA', '3'], 14: ['AAAACCCC', '4'], 15: ['CAAACCCC', '3'],
    };
    for (const [pos, [barcode, priority]] of Object.entries(expectSpecial)) {
      assert.equal(rows[pos - 1].barcode, barcode);
      assert.equal(rows[pos - 1].priority, priority);
    }
    // 其余位置恰为前 11 个候选，优先权均为 1
    const candidates = acceptanceCandidates();
    let ci = 0;
    rows.forEach((r, i) => {
      if (expectSpecial[i + 1]) return;
      assert.equal(r.barcode, candidates[ci++], `第 ${i + 1} 条候选`);
      assert.equal(r.priority, '1');
    });
    assert.equal(ci, 11);
    // 录入合法
    const parsed = normalizeRows(rows);
    assert.equal(parsed.ok, true, parsed.errors.join('; '));
  });
});

describe('验收批次：审计结论', () => {
  const rows = buildAcceptanceRows();
  const parsed = normalizeRows(rows);

  test('汇总：总优先权 19、入选 14 条、同优方案数恰为 2', async () => {
    const res = await auditRecords(parsed.records);
    assert.equal(res.totalPriority, 19n);
    assert.equal(res.selectedCount, 14);
    assert.equal(res.optimalCount, 2n);
  });

  test('逐条归属：第 1、5、9、13 条可选，第 15 条从不选，其余必选', async () => {
    const res = await auditRecords(parsed.records);
    assert.deepEqual(res.status, [...EXPECTED.status]);
  });

  test('规范位向量为 11110111011111011（选中优先裁决取第 1、13 条方案）', async () => {
    const res = await auditRecords(parsed.records);
    assert.equal(res.bitVector, EXPECTED.bitVector);
    assert.deepEqual([...res.canonical], [...EXPECTED.bitVector].map(Number));
    assert.deepEqual(res.selectedIndices, [...EXPECTED.selectedIndices]);
  });

  test('独立复算：位向量无互斥、数量 14、优先权之和 19，与汇总一致', async () => {
    const res = await auditRecords(parsed.records);
    const recs = parsed.records;
    const chosen = [];
    for (let i = 0; i < recs.length; i++) if (res.canonical[i]) chosen.push(i);

    // 互斥规则的独立实现：正向/反向互补最小汉明距离 < 双方阈值较大者
    for (let a = 0; a < chosen.length; a++) {
      for (let b = a + 1; b < chosen.length; b++) {
        const ra = recs[chosen[a]];
        const rb = recs[chosen[b]];
        const d = Math.min(hamming(ra.seq, rb.seq), hamming(ra.seq, rb.rc));
        const limit = Math.max(ra.threshold, rb.threshold);
        assert.ok(d >= limit, `第 ${chosen[a] + 1} 条与第 ${chosen[b] + 1} 条互斥（d=${d} < ${limit}）`);
      }
      // 自冲突独立复算：自身反向互补距离不得不足阈值
      const self = hamming(recs[chosen[a]].seq, recs[chosen[a]].rc);
      assert.ok(self >= recs[chosen[a]].threshold, `第 ${chosen[a] + 1} 条自冲突`);
    }

    assert.equal(chosen.length, 14);
    const sum = chosen.reduce((acc, i) => acc + recs[i].priority, 0n);
    assert.equal(sum, 19n);

    // 与同一结果的汇总字段一致
    assert.equal(chosen.length, res.selectedCount);
    assert.equal(sum, res.totalPriority);
    assert.equal(res.bitVector, [...res.canonical].join(''));
    // 归属与位向量一致：必选必在位向量中，从不选必不在
    res.status.forEach((st, i) => {
      if (st === 'mandatory') assert.equal(res.canonical[i], 1, `第 ${i + 1} 条必选应在位向量中`);
      if (st === 'never') assert.equal(res.canonical[i], 0, `第 ${i + 1} 条从不选不应在位向量中`);
    });
  });

  test('两种同优方案仅在冲突链上不同：{1,13} 或 {5,9}，均含第 14 条、排除第 15 条', async () => {
    // 独立穷举全部最优方案（2^17 掩码），与算法结论互证
    const recs = parsed.records;
    const m = recs.length;
    const optSets = [];
    let bestW = -1n;
    let bestS = -1;
    for (let mask = 0; mask < (1 << m); mask++) {
      const sel = [];
      for (let i = 0; i < m; i++) if ((mask >> i) & 1) sel.push(i);
      let ok = true;
      for (let a = 0; a < sel.length && ok; a++) {
        if (recs[sel[a]].selfConflict) { ok = false; break; }
        for (let b = a + 1; b < sel.length; b++) {
          const ra = recs[sel[a]];
          const rb = recs[sel[b]];
          const d = Math.min(hamming(ra.seq, rb.seq), hamming(ra.seq, rb.rc));
          if (d < Math.max(ra.threshold, rb.threshold)) { ok = false; break; }
        }
      }
      if (!ok) continue;
      const w = sel.reduce((acc, i) => acc + recs[i].priority, 0n);
      const s = sel.length;
      if (w > bestW || (w === bestW && s > bestS)) {
        bestW = w; bestS = s; optSets.length = 0; optSets.push(sel);
      } else if (w === bestW && s === bestS) {
        optSets.push(sel);
      }
    }
    assert.equal(bestW, 19n);
    assert.equal(bestS, 14);
    assert.equal(optSets.length, 2);
    const common = (sel) => sel.filter((i) => ![0, 4, 8, 12].includes(i));
    // 两方案在冲突链（位次 1、5、9、13）之外完全相同
    assert.deepEqual(common(optSets[0]), common(optSets[1]));
    const chains = optSets.map((sel) => sel.filter((i) => [0, 4, 8, 12].includes(i)).map((i) => i + 1).sort());
    assert.deepEqual(chains.sort((a, b) => a[0] - b[0]), [[1, 13], [5, 9]]);
    // 均含第 14 条、排除第 15 条
    for (const sel of optSets) {
      assert.ok(sel.includes(13), '应含第 14 条');
      assert.ok(!sel.includes(14), '应排除第 15 条');
    }
    // 输入次序“选中优先”裁决应取 {1,13} 方案
    const res = await auditRecords(parsed.records);
    const lexChain = [0, 4, 8, 12].filter((i) => res.canonical[i] === 1).map((i) => i + 1);
    assert.deepEqual(lexChain, [1, 13]);
  });
});
