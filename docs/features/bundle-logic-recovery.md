# Bundle 逻辑还原：思路与标准

> 本文记录 Inspector 在 Cocos 3.x 试玩包上的**逆向方法论**，以及与「可再编译 / 可运行」传统目标的分岔。  
> 操作细节见 [runtime-dump-reverse.md](./runtime-dump-reverse.md)；单组件草稿见 [script-recover.md](./script-recover.md)。

## 为什么有价值

业界对 Cocos 3.x **资源**有较可用路径（config 按图索骥、cc-reverse 等），对 **业务逻辑脚本**没有公认好方案：

- 3.x 远程包把脚本揉进 `index.js`（多段 `System.register`），cc-reverse 对 3.x 脚本多半整 chunk 拷贝
- 通用 JS 逆向停在「美化 / 拆模块」，不懂 Prefab 引用与 Creator 目录
- 传统目标追求「还原后能编译、能跑」，在丢 sourcemap、装饰器编译、压缩短名的前提下成本极高、成功率差

我们换验收口径后，这条线突然变得可产品化：

**先拿到「人 / LLM 能讲清结构」的逻辑稿，再（可选）由 LLM 修成可运行工程。**

可读结构一旦成立，可运行变成下游问题，而不是第一道门槛。这与「有桥、能进页、能 dump 类名与 bundle」的 Inspector 能力天然契合，是通用离线拆包工具故意不碰的一层。

## 目标对齐（我们到底在还原什么）

| 说法 | 是否主目标 | 说明 |
|------|------------|------|
| 重建 **Asset Bundle**（config + import + native + 包内 JS） | ✅ 主线 | 按包完整、可对照、可分析 |
| 包内 **JS 拆分 / 可读 / 理解** | ✅ 嵌在 Bundle 还原里 | 代码在 `index.js`，不是 Prefab 里 |
| 生成可打开的 **Creator 工程** | ⚪ 可选支线 | 高成功率时很有价值，但不作为理解层验收 |
| 与原 TS 仓逐文件一致 | ❌ 不现实 | 构建后路径与局部变量名大多已丢 |

Prefab **不内嵌**脚本源码；脚本在同包（或依赖包）的 `index.js` / chunks。  
因此：**Bundle 还原 = 资源按图索骥 + 包内脚本处理（含 JS 拆分）**。

## 验收标准（核心分歧）

### 旧标准（传统逆向）

- 成功 = 能再编译 / 能加载运行 / 行为接近
- 改写必须保语义，尽量少动
- 报错 = 失败

### 新标准（本项目采用）

- 成功 = **逻辑结构可读、可讲述**（继承谁、主流程几步、和盘面字段能否对上）
- 允许为可读性做**过激改写**（`class extends`、删 babel helper 形态、猜变量名、加注释）
- 是否可运行、有没有报错 **不计入本层验收**
- 理由：在已理解逻辑的前提下，可由 LLM **快速修复**可编译 / 可运行问题

### 理解层三问（模块级合格线）

1. 这个类 **继承谁、对外暴露什么**？
2. 主流程 / 状态 **几步、谁调谁**？
3. 和盘面相关的 **字段 / 事件** 能否对上（名字不必原样）？

三问能答 → 本轮合格。

## 三层产物（并存，不互相取代）

```text
忠实层  *‑split / *‑readable / *‑restored
        少臆造，可回查原文与 CDN 切片

理解层  *‑logic/（规划中）
        主验收：结构 + 流程 + 注释；可为可读过激改写

工程层  后置可选
        按理解稿生成可编译 TS / 可挂工程；不阻塞理解层
```

过激改写可以，但必须保留忠实层对照，避免改丢信息后无法回查。

## 分层展开工作流（不要一上来全量拆）

对任意一款游戏，固定四步：

```text
① 总览
   · 有哪些 bundle、base URL
   · 主 JS / 各包 index.js 是否已知

② 点开某个 bundle（元信息）
   · config 统计、hasPreloadScript、deps
   · 是否真有业务模块（System.register 数量）

③ Bundle 资源展开（可选、按包）
   · 按 config 下 import/native → 落盘 / 交给 cc-reverse

④ JS 展开（可选、按文件）
   · index.js → System.register 拆分 → 可读化 → 目录提示 →（下一步）理解层
```

对应 Unity「先看 Bundle 里有什么再拆」的思路，但是 **Cocos 远程包 + Inspector 运行时**，不依赖 HAR（HAR 仅作发现 URL 的备选）。

## 变量名与 LLM

| 能力 | 可行性 |
|------|--------|
| setters 导入名（`cclegacy`、类名） | ✅ 规则可做（L3） |
| 装饰器字段名（`background` 等） | ✅ 规则半还原 |
| 局部临时变量「原名」 | ❌ 无 sourcemap 做不到 |
| 按编译套路改角色名（`_this` / `_super`） | ✅ 启发式 |
| LLM 重命名 + 加注释 | ✅ 适合理解层；定位为辅助阅读，非权威原名 |
| LLM 保证可运行 | ❌ 不作为理解层承诺 |

## 雷神 2（PowerOfThor2）试验记录

试玩页：`gameweb3.rsg-games.com` · CDN：`gameresource3.../PowerOfThor2/` · 引擎 **3.8.8**

### Bundle 与代码分布

| Bundle | index.js | System.register | 结论 |
|--------|----------|-----------------|------|
| **resources** | ~1.4MB | ~545 | 代码最多 |
| **slotgame** | ~281KB | ~80 | 主玩法，已试拆 |
| internal | ~8KB | ~3 | 很少 |
| main / freegame | &lt;1KB | ~2 | 空壳级 |

### 已落地工具链（slotgame）

```text
downloads/.../remote/slotgame/index.js
  → split-system-register.mjs     → scripts-split/slotgame/          （80 模块）
  → readableize-system-register.mjs → slotgame-readable/            （execute + prettier）
  → restore-scripts-l3.mjs        → slotgame-restored/              （导入名 + 目录提示）
```

目录线索：

- dump `classes[].className` 含 `/`（如 `widgets/Foo`、`Anim/Bar`）→ 最接近原工程
- 其余：`workers/`、`game/`、`boards/`、`interfaces/` 等启发式（**非原仓保证**）

资源侧：按 config 展开下载 + 临时组装 `assets/<bundle>/` 喂 cc-reverse，Recovered 比例较高；脚本进工程仍弱——符合「资源有把握、逻辑靠自研」的判断。

### 与 cc-reverse / harExplore 的关系

- **cc-reverse**：擅长资源路径归位；3.x 业务逻辑不是它的强项
- **harExplore**：不以生成 Creator 工程为主；本线同样以 Bundle + 逻辑理解为主
- **Creator 工程还原**：有价值，但是「可工作的恢复工程」，且应建立在 Bundle/逻辑稿之上，而不是反过来绑死理解层

## 下一步（文档确认后的工程项）

1. 落理解层输出规格（`class` + 字段注释 + 方法级流程注释；目录 `*-logic/`）
2. 规则改写：`inheritsLoose` → `class extends`；装饰器收成字段声明
3. 样例试跑（如 `AnimationLayerBase`、`PowerOfThor2WinBoard`、GameFlow）后再批跑
4. 可选：LLM 批注 / 重命名流水线（带 deps、exports、dump 类名上下文）
5. 产品化：MCP/UI 按 ①②③④ 分级暴露，避免单次 `dump_runtime` 包办

## 相关实现

- Dump / 下载：[runtime-dump-reverse.md](./runtime-dump-reverse.md)
- 工具：`tools/mcp-cocos-inspector/split-system-register.mjs`、`readableize-system-register.mjs`、`restore-scripts-l3.mjs`
- 试验落盘：`tmp/runtime-dump/gameweb3_rsg-games_com/scripts-split/`
