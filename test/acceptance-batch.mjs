// 验收批次构造（共享给 optimizer 验收测试与 Worker 集成测试；非测试文件）。
// 规则：17 条长度 8、阈值均为 2 的记录。
//   第 1、5、9、13 条：AAAAAAAA / CAAAAAAA / CCCAAAAA / CCAAAAAA，优先权 1、2、2、3；
//   第 14、15 条：AAAACCCC / CAAACCCC，优先权 4、3；
//   其余 11 个位置：按 A 先于 C 的字典序取前 11 个恰含四个 C 的八位条码，
//   排除以 CCC 开头、等于 AAAACCCC、或与 CAAACCCC 仅差一位的候选，优先权均为 1。
import { hamming } from '../src/lib/optimizer.js';

export const BATCH_SIZE = 17;
export const THRESHOLD = '2';

// 1 起始的特定位次 -> { barcode, priority }
const SPECIAL = new Map([
  [1, { barcode: 'AAAAAAAA', priority: 1 }],
  [5, { barcode: 'CAAAAAAA', priority: 2 }],
  [9, { barcode: 'CCCAAAAA', priority: 2 }],
  [13, { barcode: 'CCAAAAAA', priority: 3 }],
  [14, { barcode: 'AAAACCCC', priority: 4 }],
  [15, { barcode: 'CAAACCCC', priority: 3 }],
]);

// 恰含四个 C 的八位 A/C 条码，按 A<C 字典序枚举，套用三条排除规则
export function acceptanceCandidates() {
  const out = [];
  for (let mask = 0; mask < 256; mask++) {
    let seq = '';
    let cs = 0;
    for (let i = 0; i < 8; i++) {
      const bit = (mask >> (7 - i)) & 1; // 第 1 位为最高位：数值序即 A<C 字典序
      seq += bit ? 'C' : 'A';
      cs += bit;
    }
    if (cs !== 4) continue; // 恰含四个 C
    if (seq.startsWith('CCC')) continue; // 排除以 CCC 开头
    if (seq === 'AAAACCCC') continue; // 排除与第 14 条相同
    if (hamming(seq, 'CAAACCCC') === 1) continue; // 排除与第 15 条仅差一位
    out.push(seq);
  }
  return out;
}

// 按生成规则构造 17 条录入（UI 录入形态：字段均为字符串）
export function buildAcceptanceRows() {
  const candidates = acceptanceCandidates();
  if (candidates.length < 11) throw new Error(`候选不足：仅 ${candidates.length} 个`);
  const rows = [];
  let ci = 0;
  for (let pos = 1; pos <= BATCH_SIZE; pos++) {
    const sp = SPECIAL.get(pos);
    rows.push({
      barcode: sp ? sp.barcode : candidates[ci++],
      priority: String(sp ? sp.priority : 1),
      threshold: THRESHOLD,
    });
  }
  return rows;
}

// 该批次的期望结论（与算法实现无关的独立事实）
export const EXPECTED = Object.freeze({
  totalPriority: 19n,
  selectedCount: 14,
  optimalCount: 2n,
  bitVector: '11110111011111011',
  // 0 起始：第 1、5、9、13 条可选；第 15 条从不选；其余必选
  status: Object.freeze([
    'optional', 'mandatory', 'mandatory', 'mandatory', 'optional',
    'mandatory', 'mandatory', 'mandatory', 'optional', 'mandatory',
    'mandatory', 'mandatory', 'optional', 'mandatory', 'never',
    'mandatory', 'mandatory',
  ]),
  selectedIndices: Object.freeze([0, 1, 2, 3, 5, 6, 7, 9, 10, 11, 12, 13, 15, 16]),
});
