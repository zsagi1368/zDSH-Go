#!/usr/bin/env python3
"""【上下文缓存管理方法】预算表生成器 v2（权威来源，文档表格必须由此脚本输出）。

对应设计文档 CONTEXT-CACHE-MANAGEMENT.md §1。所有公式在本文件单点实现；
v2.2 修订：全 Tier 统一公式（消除 Tier B 固定常数与 10% 硬约束的矛盾 B1′）、
主动触发口径一致化（T1′）、摘要输入上限与压缩成本列（S2′）。
"""

from math import ceil, floor

BATCH_CAP = 2  # 并行工具批上限系数（超 2 时上调，见文档）


def max_tokens(w, cap):
    return min(cap, floor(w * 0.10))


def reserve(mt):
    return ceil(mt * 1.25) + 4096


def tool_cap_tokens(mt, rs):
    return max(1024, floor(0.25 * (rs - mt)))


def r_pess(mt, tool):
    return mt + BATCH_CAP * tool + 4096


def keep_recent(w, trigger):
    floor_kr = min(20000, floor(w * 0.30))
    return min(max(floor(w * 0.12), floor_kr), floor(0.8 * trigger))


def summary_cap(w, cap, mt, rs):
    cap_sum = max(8192, floor(w * 0.01))
    return min(cap, mt, floor(0.8 * rs), cap_sum)


def summary_input_max(trigger, keep):
    return max(0, trigger - keep)


def subagent_return(mt, rs):
    return max(2048, floor(0.25 * (rs - mt)))


def injection_budget(w):
    return max(4096, floor(w * 0.005))


def delta_cap(w):
    return max(8192, floor(w * 0.008))


CASES = [
    ("16k(拒绝域)", 16384, 4096),
    ("32k", 32768, 8192),
    ("64k", 65536, 16384),
    ("128k", 131072, 32768),
    ("200k", 204800, 65536),
    ("1M cap=64k", 1048576, 65536),
    ("1M cap=128k", 1048576, 131072),
]

def r_min(w, mt, tc):
    """稳态主链命中率理论上界下限：轮增量为 maxTokens+2×toolCap 时的最高命中率。"""
    return 1 - (mt + BATCH_CAP * tc) / w


print(f"{'案例':<12}{'maxTok':>7}{'reserve':>8}{'toolCap':>8}{'R_pess':>8}{'触发线':>8}{'触发%':>7}{'keepRec':>8}{'摘要入':>9}{'摘要出':>7}{'回传':>6}{'r_min':>7}")
for label, w, cap in CASES:
    mt = max_tokens(w, cap)
    rs = reserve(mt)
    tc = tool_cap_tokens(mt, rs)
    rp = r_pess(mt, tc)
    tr = w - rp
    keep = keep_recent(w, tr)
    sin = summary_input_max(tr, keep)
    sout = summary_cap(w, cap, mt, rs)
    ret = subagent_return(mt, rs)
    pct = tr / w * 100
    rm = r_min(w, mt, tc)
    print(f"{label:<12}{mt:>7}{rs:>8}{tc:>8}{rp:>8}{tr:>8}{pct:>6.1f}%{keep:>8}{sin:>9}{sout:>7}{ret:>6}{rm*100:>6.1f}%")

print()
print("统一公式（合法域 W>=32768；W<32768 拒绝，16k 行仅作参考——其 r_min 与压缩频率无法满足验收）：")
print("  maxTokens = min(cap, floor(W×0.10))                // 硬约束：输出≤窗口10%，全 Tier 生效（B1′）")
print("  reserve   = ceil(maxTokens×1.25) + 4096            // 主链余量")
print("  toolCap   = max(1024, 0.25×(reserve−maxTokens))    // 单条工具结果 token 上限")
print("  R_pess    = maxTokens + BATCH_CAP×toolCap + 4096   // 主动触发余量（T1′：触发线=此口径，L4 字面同式）")
print("  触发线     = W − R_pess；keepRecent = min(max(W×12%, min(20000, W×30%)), 0.8×触发线)")
print("  摘要输入上限 = 触发线 − keepRecent（超限走 L4 分块；估算按 chars/3）")
print("  摘要输出   = min(cap, maxTokens, 0.8×reserve, max(8192, W×1%))")
print("  回传       = max(2048, 0.25×(reserve−maxTokens))；注入存量=max(4096, W×0.5%)；delta=max(8192, W×0.8%)")
print("  r_min     = 1 − (maxTokens+2×toolCap)/W：稳态命中率 SLO 下限（S1′），SLO = min(90%, r_min+2pp) 逐窗制定")
print("说明：BATCH_CAP 默认 2，首轮生效；会话内滚动观测最近 10 轮最大并行批 N，N>BATCH_CAP 时上调并重算（CI 锁表）。")