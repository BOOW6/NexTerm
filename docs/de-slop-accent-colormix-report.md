# 阶段 5 决策报告：JS accent ramp vs CSS color-mix

> 日期：2026-11-20。数据来源：`ACCENT_MIX_REPORT=1 npx vitest run src/theme/accentColorMixReport.test.ts`（报告测试已入库，默认跳过，随时可重跑）。
> 对比范围：14 个内置基底主题 × 18 个强调色预设 = 252 组。比较 `accent.ts` 现行 JS 派生（`--accent-strong/soft`，`--link`、`--focus-ring` 与其同值）与 `derived-tokens.css` 式 color-mix 派生（strong = mix(primary 82%, foreground)，soft = mix(primary 60%, surface)）在 oklab 空间的 ΔE，并核对"预设前景色文字压混合 strong 填充"的 WCAG AA 对比度。

## 结果

| 指标                 | mean ΔE | max ΔE |
| -------------------- | ------- | ------ |
| strong（= link）     | 21.90   | 48.54  |
| soft（= focus-ring） | 23.18   | 56.11  |

对比度：**128/252 组 AA 不达标**（< 4.5:1）。典型失败组合是暗色主题 + 深色预设（如 sandstone-dark × black，ΔE 45.8、对比度 2.01）——color-mix 向 foreground 混合在暗色下把填充推得过亮/过灰，而 JS ramp 是变体感知的亮度位移（暗色 l+8、亮色 l−12），两者语义不同。

参考：ΔE(oklab) ≈ 1 勉强可辨，2–3 明显，>10 是"另一种颜色"。mean 22 意味着全界面主色调肉眼可见地改变。

## 结论：**不迁移（NO-GO）**

理由：

1. **视觉漂移不可接受**：平均 ΔE 22、最大 56，且 51% 组合对比度跌破 AA——迁移将同时破坏观感与可访问性门禁（`contrast.test.ts` 的设计意图）。
2. **公式不等价**：JS ramp 编码了变体感知逻辑（strong 在暗色变亮、亮色变深；soft 的饱和度衰减 s×0.7）与预设前景/中性化交互；单一 color-mix 表达式无法复现，要复现就得在 CSS 里按 variant 分叉——等于把 JS 逻辑抄进 CSS，没有净收益。
3. **accent.ts 不会消失**：语义色色相偏移、终端 16 色重染、中性化预设（重染 background/border/foreground）都必须留在 JS。迁移 ramp 后仍是双轨，只是 JS 变薄一点。
4. **对照实验证明分工合理**：同一套 color-mix 机制用于渐变/选区派生（阶段 2）时 136 个 stop 中 129 个 ΔE ≤ 3——color-mix 适合"从基准色出发构造新值"，不适合"复现一套已调好的变体感知 ramp"。

## 落地状态

- `accent.ts` 保持现状，`--accent-strong/soft` 等仍由 JS 派生（`accent.test.ts` 继续钉住）。
- `derived-tokens.css` 的 `--primary-*` ramp 定位为**交互态新令牌**（hover/active/subtle/border），不是 `--accent-strong/soft` 的替代品；当前无消费者，后续组件需要"主色系交互色"时从这里取，禁止再写死。
- `accentColorMixReport.test.ts` 留在仓库作为决策依据，若未来有人重提迁移，先重跑它。

## 复跑方式

```bash
ACCENT_MIX_REPORT=1 npx vitest run src/theme/accentColorMixReport.test.ts
```
