修复两个问题:标签栏溢出 UI 与"恢复滚动缓冲"提示覆盖历史

## 问题 1:标签占满后出现原生滚动条 → 滚动按钮 + 渐隐

根因:dockview 自带的 `.dv-tabs-container` 是 `overflow-x: auto` + `scrollbar-width: thin` 的滚动容器,占满后出现原生细滚动条并挤压 28px 高的标签条;应用层没有任何溢出处理(无滚动按钮/渐隐/自动滚入)。

改动:

1. **`src/index.css`**(dockview 覆盖区,约 88 行后新增)
   - 对 `:root .dockview-theme-dark .dv-tabs-and-actions-container .dv-tabs-container` 设 `scrollbar-width: none` 并 `::-webkit-scrollbar { display: none }`,隐藏原生滚动条(容器仍可编程滚动)。注意 holo/eclair 皮肤段(index.css:218、378)只改了装饰背景,不冲突,但完成后需在两套皮肤下目检。

2. **新建 `src/components/layout/TabStripOverflow.tsx`**:按 dockview group 注入溢出控件的增强组件(纯 DOM 注入 + 自清理,不影响布局持久化)。
   - `DockLayout.tsx` 的 `onReady` 中:遍历 `api.groups` + 订阅 `api.onDidAddGroup` / `onDidRemoveGroup`(disposable 存入现有 `disposablesRef`),对每个 group 的 `.dv-tabs-and-actions-container` 注入一个绝对定位 overlay。
   - overlay 内容:左右两个 lucide `ChevronLeft`/`ChevronRight` 按钮(28px 高、主题 token 配色、背景渐变到 surface-header 保证可读)+ 左右 16px 渐隐遮罩;仅在对应方向可滚动(`scrollLeft > 0` / `scrollLeft + clientWidth < scrollWidth`)时显示。按钮 `pointer-events: auto`,overlay 其余部分 `pointer-events: none`,不遮挡 `.dv-void-container` 拖拽区。
   - 交互:按钮点击 → `tabs.scrollBy({ left: ±160, behavior: 'smooth' })`;`.dv-tabs-container` 上监听 `wheel`(`{ passive: false }`,可横滚时 `preventDefault` 并把 deltaY 转为横向滚动);`scroll` 事件 + `ResizeObserver`(覆盖分屏尺寸变化)实时更新按钮/渐隐可见性。
   - 激活标签自动滚入视野:订阅 `api.onDidActivePanelChange`(DockLayout 已有订阅,可复用同一回调),在对应 group 内查 `.dv-tab.dv-active-tab`,用 offsetLeft 与容器 `scrollLeft/clientWidth` 手动计算并设置 `scrollLeft`(不用 `scrollIntoView`,避免滚动外层祖先)。
   - 清理:group 移除或组件卸载时断开 observer、移除注入 DOM。
   - 按钮 `aria-label` 走 i18n,新增 `layout.scrollTabsLeft` / `layout.scrollTabsRight`(zh/en)。

## 问题 2:「[已恢复上次会话的滚动缓冲]」覆盖历史内容

根因(已对照 xterm.js 源码确认):`XtermCanvas.tsx` 的 `writeScrollbackNotice`(541-606 行)placeAtBottom 路径依赖"回放结束后光标停在内容末尾"这一假设,但该假设不成立:
- reset 串中的 `\x1b[?1049l` 在 xterm.js 中会**无条件** `restoreCursor()`,新终端无保存光标 → 光标跳回 (0,0)(截图里提示覆盖到历史行首、残留 "e 会话的窗口标题。" 即由此类错位导致);
- 序列化快照尾部会用相对光标移动(CUU/CUD)把光标放到上一个会话的光标位置,与本次回放几何不一致时同样失准;
- 提示行错位后 `noticeRow` 小于实际内容末行,随后的 `\x1b[2J` 会把仍在视口内的**其余历史一并擦除**——即"恢复缓冲被覆盖"。

改动(用"绝对定位"替换"相对光标推断",整类问题一起消除):

3. **新建 `src/lib/terminalNotice.ts`**(纯函数,可单测):`computeNoticePlacement(getLineText, cursorRow, rows)` → 从视口底部向上扫描最后非空行 L,目标行 T = max(L, cursorRow) + 1;若内容占满视口则先 `\r\n` 滚动一行再取 T = rows-1。返回 `{ scrollFirst, targetRow }`。

4. **`XtermCanvas.tsx` 重写 placeAtBottom 恢复路径**:
   - reset 串去掉 `\x1b7`/`\x1b8`(DECSC/DECRC 不再需要),保留 `?1049l`、模式复位与 DECSTBM 重置(`\x1b[r`);
   - 回调内 `scrollToBottom()` 后用 buffer 逐行扫描调用纯函数算出 T,绝对 CUP `\x1b[T+1;1H\x1b[2K` 写提示,再按 `noticeRow = T` 执行现有滚动清屏(此时 T = 内容末行 + 1,`\x1b[2J` 只会清到空行,历史零丢失);
   - 提示多段写入全程用现有 `writeFrozen` 机制包住(等解冻 → flush → freeze → 写 → 解冻唤醒 waiter),消除直写与 16ms 批量队列的双通道插队(重连提示 `[正在重连]` 等同路径受益);
   - 新增 `restoreInProgress` 标志:`runResize` 检测到时暂存最新目标尺寸、恢复完成后再应用,堵住"快照直写不计入 writesIssued → 恢复期间 resize 触发 mid-replay reflow"的竞态。

5. **新增 `src/lib/terminalNotice.test.ts`**(沿用 `src/lib/*.test.ts` 惯例):用 headless `Terminal` 回放快照 + 提示,断言:历史行内容逐字保留、提示独立成行、滚动后提示位于 scrollback 末行、`\x1b[2J` 后视口为空。

## 验证

- `npm run check`(typecheck + lint + format + vitest)
- 手动验证:开 6+ 个会话触发溢出 → 按钮滚动/滚轮横滚/激活滚入;分屏后每组独立生效;holo/eclair 皮肤目检;运行 `help` 后关闭应用重开 → 历史完整、提示独立成行且位于 scrollback 末行、无内容被覆盖。

不改动:布局持久化格式、dockview 标签默认 min-width(75px)、`placeAtBottom=false` 的重连提示定位逻辑(仅包 freeze)。

涉及文件:`src/index.css`、`src/components/layout/TabStripOverflow.tsx`(新)、`src/components/layout/DockLayout.tsx`、`src/i18n/index.ts`、`src/lib/terminalNotice.ts`(新)、`src/lib/terminalNotice.test.ts`(新)、`src/components/terminal/XtermCanvas.tsx`。