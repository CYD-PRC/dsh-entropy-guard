# 熵守卫 · Entropy Guard

**把 `entropy-sdk` 的档位安全控制层接进 DeepSeek Harness 的工具调用链。**

上游 [`entropy-sdk`](https://github.com/CYD-PRC/entropy-sdk) 是 EntropyRuntime 论文
（[arXiv:2607.00334](https://arxiv.org/abs/2607.00334)）的零依赖可嵌入版，纯 Python。
本插件是它的**等义 ESM 移植**（`lib/core.js` 与 SDK 抽象一一对应）**加上 Harness 绑定**
（`lib/config.js` / `lib/controller.js` / `index.js` / `client.js`）。
不引入任何 `@deepseek-ai/*` 包，只用 Node 内置模块与浏览器原生能力。

> 论文的一句话主张——**让 AI 的自主程度可观测、可治理、可问责**——就是本插件的功能清单：
> 档位与 σ 实时可见、门是唯一调度通道、每次判定落进只追加审计链并且能导出成论文级数据。

---

## 一、为什么值得装

1. **档位是动态的，不是预设。** DSH 原生的 sandbox / approval 是**会话级静态**选择：选定就不动。
   这里每次工具调用都在改变状态——不稳定 → σ 上升 → **立刻降档**；干净周期攒够了才**逐级挣回**。
   「慢升快降」在 DSH 里此前没有对应物。
2. **自主权变成模型自己看得见的变量。** 每轮运行时上下文里会多一行：
   `Entropy guard: gear G3 Execute · sigma=0.00 · clean streak 0/3 · ...`，
   agent 在**选动作之前**就知道自己现在被允许做什么。另有 Web UI 实时显示档位阶梯与集群视图。
3. **只追加的审计链 + 论文级导出。** 每个判定、迁移、执行、挂起都落 JSONL；
   `/entropy export` 直接产出「门接受率 / 档位迁移直方图 / σ 轨迹 / 分工具判定统计」的
   JSON + Markdown（对应论文 §8 的实证要求）。
4. **零风险试用。** `enforcement: observe` 下**什么都不拒绝**，只计算、只审计、只统计
   「本来会拒绝什么」。先观测跑一段，看过 `/entropy export` 的数字再决定是否切到 `gate`。

---

## 二、一次工具调用 = 一个控制周期

| SDK 抽象 | 在本插件中的落点 |
|---|---|
| `Gear` G0–G4 档位阶梯（定义 1） | `lib/core.js`；动作空间单调嵌套 |
| `UtilityGate` `U(s,a) ≥ θ`（定义 2–3、定理 2） | 每次调用都过门，门是唯一调度通道 |
| `GearPolicy` 慢升快降（§4） | 每 `patience` 个干净周期升一档，不稳定即降 |
| `FallbackConfig`（定理 4） | `maxConsecutiveRejections` 次拒绝 → 挂起在 G0 等人工复核 |
| `RuntimeState` ρ=(g,σ,ϵ)（定义 4） | 每个 agent 一份，按 agent id 隔离（子 agent 有各自的自主权） |
| `AuditLog`（§5/§8） | `$DSH_HOME/entropy-guard/<agent>.jsonl`，只追加 |
| `EntropyRuntime`（算法 1） | `guard()` 过门 + `tools/result` 结清，等价于 `step()` |

周期映射：**观察/读档位 → 动作生成（分类到档位并打分）→ 效用门 →
执行与反馈**。拒绝通过 `ctx.tools.guard()` 返回——这是**单调、与顺序无关**的注册表否决，
其他插件无法把它翻回放行，所以**被拒绝的调用绝不执行**。

效用函数按论文推荐形态注入（SDK 不内置 U，必须由部署方给出）：

```
U(s,a) = task·gain(a) + safety·(1 − risk(a)) − cost·cost(a)
```

---

## 三、安装

```text
plugin_manager  action: install_bundle  target: <本包目录的绝对路径>
```

或在本包已发布到 npm 后：

```text
plugin_manager  action: install_bundle  target: dsh-entropy-guard
```

安装返回里的 `application` 字段决定它是否已经生效。安装后**建议先跑观测模式**：把
`cordis.patch.yml`（或插件行配置）里的 `enforcement` 设为 `observe`，工作一段时间，
`/entropy export` 看数字，再改回 `gate`。

---

## 四、你在界面上会看到什么

- **工具** `entropy_status`（只读，**豁免于守卫本身**，即使挂起也能回答）：
  档位、σ、连续干净周期、连续拒绝、挂起状态、执行模式、门接受率、档位直方图、最近判定。
- **命令** `/entropy`：

  | 子命令 | 作用 |
  |---|---|
  | `status`（默认） | 完整报告：档位、σ、周期数、接受率、直方图、最近链上条目 |
  | `fleet` | 集群视图：所有受治 agent 的档位/σ/挂起 + **集群最低档** |
  | `export [目录]` | 写出论文级 JSON + Markdown 报告 |
  | `resume` | 解除挂起。**σ 故意不清零**：档位必须重新挣 |
  | `gear <0-4>` | 人工直接设定档位（同时解除挂起），记 `gear_manual` |
  | `reset` | 重建该 agent 的运行时 |

- **Web UI 两处**（`ui.dock` / `ui.settings` 可关）：
  1. 输入框上方一条**实时徽章**：档位阶梯 + σ + 干净周期 + 接受率；挂起时红字提示。
     能拿到会话 id 时显示本会话，否则显示**集群最低档**（G4 的定义是系统级协调，
     所以集群真正可信的档位是**最弱**那个，不是最强那个）。
  2. 设置里的 **Entropy Guard 页**：档位阶梯、控制量、受治 agent 表、分工具判定表、档位迁移历史。
  样式只用 `--dsw-alias-*` 主题令牌，明暗主题自动跟随；不引入任何客户端 SDK 包。

- **运行时上下文一行**：每个 agent 一行，和 DSH 文件策略那行并排。

---

## 五、配置参考

每个字段都可省略。完整形状：

```yaml
config:
  enabled: true
  enforcement: gate          # gate | observe（observe = 只测量，不拒绝）
  initialGear: 3             # 0-4；G3 Execute 让普通会话保持原有自主权
  theta: 1                   # 门阈值，有限且 >= 0
  weights: { task: 1, safety: 2, cost: 0.5 }
  tools:                     # 逐工具口供；`null` 删除某个默认项
    read:  { gear: 0, risk: 0.05, cost: 0.2 }
    write: { gear: 3, risk: 0.55, cost: 0.5 }
  defaultTool: { gear: 3, risk: 0.5, cost: 0.5 }   # 陌生工具按 G3 有副作用处理
  rules:                     # 正则；取 max(risk)、max(cost)
    - { label: recursive-force-delete, match: '...', dangerousTarget: '...', risk: 1, cost: 0.8 }
  contentKeys: [content, old_string, new_string]    # 这些参数键永不参与规则扫描
  policy:
    sigmaLow: 0.3            # 低于它才允许升档
    sigmaHigh: 1.0           # 高于它立刻降档
    patience: 3              # 升一档所需的连续干净周期
    sigmaDecay: 0.1
    sigmaStep: 0.1
    fastDown: error          # error = SDK 原律；overflow = 先累积 σ 再降档
  fallback:
    maxAlternatives: 0       # Harness 无法改写待执行调用，见「有意偏离」
    maxConsecutiveRejections: 8
    countGearDenials: false  # true = SDK 原样的「连续拒绝」计数
  audit: { dir: null, includeArguments: false }     # null = $DSH_HOME/entropy-guard；"" = 只留内存
  suspendedBehavior: observe-only                   # 或 deny-all
  controlTools: [entropy_status]
  promptContext: true
  humanCommands: true
  ui: { dock: true, settings: true }
```

非法值在**激活时直接抛错**，不会静默降级——与 Python SDK 的构造期 fail-closed 校验一致。

### 档位阶梯

| 档位 | 名称 | 允许的动作 |
|---|---|---|
| G0 | Observe | 只读观察、安全保持 |
| G1 | Suggest | 无副作用的候选计划 |
| G2 | Plan | 有界、可逆的恢复动作 |
| G3 | Execute | 可独立选择的有副作用动作 |
| G4 | Integrate | 系统级协调（多智能体下为涌现属性） |

随包规则里，两条递归删除规则额外用 `dangerousTarget` 收窄：**只对绝对路径、家目录、
工作目录本身或裸通配符触发**；对相对路径的定向删除是日常工作，仍然放行。
其余规则（历史改写、管道进 shell、磁盘级操作、fork 炸弹、凭据库访问、注册表/系统改动、
全局可写根）在任意档位都会把 U 压到阈值之下，直接否决。

---

## 六、与 Python SDK 的四处有意偏离（都可配置）

1. **`enforcement: observe` 可选，且推荐作为首次安装。** 判定照算、照审计、照统计，
   只是不拒绝。`/entropy export` 会告诉你**本来会拒绝什么**。
2. **`fallback.maxAlternatives` 默认 0**（关闭 fallback——SDK v0.1.2 起明确合法的配置）。
   Harness 无法把一个待执行的调用改写成另一个调用，提议者的备选**没有地方派发**；
   拒绝理由本身就是 agent 下一轮的动作依据，这与上游适配器的说明一致。
   提议者逻辑本身在 `lib/core.js` 中完整实现并有测试覆盖。
3. **`fallback.countGearDenials` 默认 false**：挂起端点对准的是**被拒绝的动作**，
   而不是阶梯自身的拒绝。否则一个暂时低于工作档位的 agent，会因为继续调用它本职工作
   需要的工具而把自己送进挂起。
4. **`suspendedBehavior` 默认 `observe-only`**：挂起期间保留 G0 只读工具——
   这是论文定理 4 的恢复路径，也让被嵌入的 agent 还能读自己的审计链和要修的代码。
   设 `deny-all` 可得到 SDK 的 `suspended_skip` 原样语义。

---

## 七、威胁模型边界

**继承上游：**

1. 门只是**经过 Harness 工具注册表**的调用上的唯一调度通道；进程内持有原始 callable 的一方绕开它。
2. `requiredGear` 是**调用方口供**。本插件由部署方自己的表推导，而不是相信模型；
   但表是策略不是证明——真实爆炸半径超出表项的工具就是被低标了，扩充 `tools`/`rules` 是部署方责任。
3. 门管**调用**，不管**事务**：已执行工具内部的副作用不会回滚。
4. `resume()` 故意不清 σ：人工复核不等于信任立即恢复。
5. 审计文件被删除时读作空（读路径 fail-open），而写失败是 fail-closed 且会拒绝调用；
   链文件消失本身就是该告警的事件。
6. `includeArguments` **默认关闭**：每条决策仍会记录规范化参数的 SHA-256 摘要（`args_digest`），
   所以链能点名"判定的对象"、能证明它判定的是哪一次调用；但载荷本身只在部署显式开启时存储
   （`audit.includeArguments: true`，每个字符串上限 2000 字符）。

**本绑定额外提醒——控制面：**

守卫管的是**工具调用**，管不到**管理守卫的那些工具**。`plugin_manager` 默认被归到
**G4 Integrate**（安装/卸载插件本来就是系统级协调，也正是 G4 的定义），
所以在 G4 以下无法用它卸载本插件；到达 G4 后该调用会被放行（`U = 1.0`）。
如果希望彻底不可绕过，把它继续抬高到阈值之上即可：

```yaml
tools:
  plugin_manager: { gear: 4, risk: 0.95, cost: 0.65 }   # U = 0.775 < 1 → 恒拒绝
```

请像 SDK 的威胁模型对待门一样对待本插件：它是**它所治理的执行路径内部**的控制层，不是内核。

---

## 八、实测验证（真实读数，不是推断）

在 `danger-full-access` 桌面 profile 上安装本包后实测：

- `install_bundle` → `application: applied`；每 agent 的运行时上下文行出现在模型上下文里。
- 只读调用以 `U = 2.80`（读文件）/ `U = 2.89`（搜索）放行，被登记为 pending，
  再由 `tools/result` 结清为干净周期：σ = 0、耐心计数推进、门接受率 1.0。
- 一条**文本**命中破坏性规则的 shell 调用在派发前被拒：
  `U = 0.6000 < theta = 1.0000`，`flagged [recursive-force-delete]`，
  档位 G3 → G2、σ = 0.10，**该调用从未到达 shell**。
- 阶梯靠 3 个干净 G0 周期把 G3 挣回，并在持续干净工作下升到 G4 Integrate。
  一次中途读数：41 周期、门接受率 0.878、档位直方图 `{"2":3,"3":6,"4":4}`。
- 每个判定、迁移、拒绝、挂起候选都在只追加的 JSONL 链里。

---

## 九、已知限制

1. **已安装包的模块不会热重载。** 本包自身代码的改动不会被运行中的 Host 加载，
   旧一代逻辑会继续生效，直到重启 Harness 载入新一代。
   （对已安装包重复 `install_bundle` 会返回 `ambiguous-install`，并不会重载。）
2. **任何报错的工具结果都算一次被拒绝的周期。** 这是 SDK 的 ϵ=1 语义，
   但在 Harness 层面多数工具报错并不是安全事件——搜索没找到、edit 锚点过期都算。
   **默认保持 `fastDown: error`，因为默认值就是论文原律的指纹**：在这里换掉它，
   evaluation 节的采样口径就永久分叉。交互式编码场景**推荐 `overflow`**——
   一次失败调用只花 0.1 的 σ，阶梯不再因为一个过期锚点就换挡。
   本 profile 实测：`error` 下 2 次失败调用 + 3 次被阶梯拒绝的重试，把会话从 G4 一路打到 G0。
3. **规则是启发式，不是分类器。** 它对内容不敏感，控制自己载荷的 agent 总能换种说法绕开；
   这也正是为什么扫描面排除了文件内容、而否决权放在执行边界。
4. **守卫只看得到进入注册表的调用**，也无法改写待执行的调用（故 `maxAlternatives: 0`）。
5. Web UI 的视觉验证需要浏览器页面；无浏览器控制时只能验证 JS 语法、清单与槽位注册。

---

## 附：给运行 agent 的人一条注意（血泪账）

**失败的工具调用同样是一次被拒绝的周期**，哪怕失败原因与 agent 的判断无关。
最典型的一种：把「读文件」和「改同一个文件」放进**同一批调用**——fs 观察策略是**按轮**要求的，
同一批里并行执行时读还没生效，改就失败；在忠实的 `fastDown: error` 下这要掉一档。
本 profile 实测：两次这样的失败，加上随后三次被阶梯拒绝的重试，**一个回合把会话从 G4 打到 G0**。

给 agent 一句明确的行为规范就能省掉这些：**一轮只读，下一轮才改。**

（守卫本身不替宿主策略做预检——它记录的是后果，不是意图。这条边界是有意的。）

## 十、测试

```
node --test test/core.test.mjs      # 71 项，无依赖
```

覆盖移植契约（fail-closed 口供与门校验、慢升快降、挂起端点与 `resume()` **不**做什么、
审计链的消毒/深拷贝隔离/文件模式缓存与坏行计数、`admit()`/`settle()` 与 `step()` 的等价性、
备选提议器）以及绑定规则（观测模式不拒绝、`fastDown` 两种语义、
阶梯拒绝对挂起计数的影响、可执行的拒绝理由、导出报告、`plugin_manager` 归 G4、配置校验）。

---

## 十二、审计链可验证性与读数纪律

**链是防篡改的，不是"有日志"。** 每条记录都带单调 `seq` 与前一条的 SHA-256 `hash`，
每次报告与导出要么校验通过，要么点名被改写的那个 `seq`。校验是**分级**的：

- `tampered`——链化区间内有记录被改写 / 链路被重接 / 有记录消失（`seq` 出现缺口）。**这才是告警。**
- `forked`——`seq` 重复或回退：两个写入者从同一个尾部各自追加，历史分叉。属运维问题而非攻击，
  而且**除了这里没有任何地方能看见它**（另给 `forks` 计数）。
- `discontinuity`——链化记录之间夹着未链化记录。这正是**原地升级时两代同写一条链**的样子，
  是每次升级都会走的正常路径，因此按软提示处理（另给 `interleaved` 计数与 `chainedRange`）。
- `verified`——干净。

把升级路径和篡改报成同一个信号，警报就会失去意义（哨兵刷屏）。v0.1 时期写下的旧记录（没有链字段）
会被如实计成"未链化的 legacy 前缀"，而不是默默当成可信。

**关于上游能力的准确说法**：`entropy-sdk` 的 `src/entropy_sdk/state.py` 用「只追加写入 + 读取深拷贝
隔离 + 坏行计数」保证审计链完整；源码里没有任何摘要或校验逻辑（其 `tests/test_v016.py`、`test_v017.py`
中的 tamper 用例针对的是**返回值被涂改**的隔离性，而不是写入被改写）。本实现额外加了 `seq` + `prev-hash`
自校验，用来回答"日志本身有没有被改写"——**这是新增能力，不是对上游的否定**。

**`/entropy seal [备注]`**：把当前条目之前的运维历史**在链内**封存。封存本身是一条普通记录——
可审计，而不是谁都能随手翻的配置开关；被封存的计数仍然照报，只是不再参与当前状态判级；
**篡改级别的发现永远不会被封存掩盖**。这条命令只有人能敲（模型够不到命令处理器），
所以"自己把自己的历史洗白"在结构上不成立。
适合的场景：一次原地升级留下了几个历史分叉，你不希望它永久污染本会话的当前读数。

**离线校验器**（不需要跑 Harness 就能复核问责性）：

```bash
node tools/verify-chain.mjs <chain.jsonl>          # 校验 + 打印 Markdown 报告
node tools/verify-chain.mjs <chain.jsonl> --json   # 完整 JSON 报告
node tools/verify-chain.mjs --demo                 # 用副本演示篡改检测
```

在一条真实的、已原地升级过的链上实测（先追加两条链化记录，再改写最后一条）——分级后的形态：

```
after appending two chained entries: DISCONTINUITY · entries 254 · chained 53 · unchained legacy 194 · interleaved 7 · corrupt lines 0 · 7 unchained entries among chained ones (two plugin generations wrote this chain)
after editing the last entry on disk: TAMPERED · entries 254 · chained 53 · unchained legacy 194 · interleaved 7 · corrupt lines 0 · seq 246 was modified after it was written
```

**读数纪律：两种模式分账，绝不混算。**

- `gateAcceptanceRate` 只统计**执行模式（gate）**下的判定；观测模式（observe）那批判定单独计入
  `observedDecisions`，对应的指标是 `wouldDenyRate`（"本来会拒绝的比例"）。
- 观测期**不会**稀释执行期的实证效力；跨部署比较不会混口径。
- `fastDown`（`error` / `overflow`）**字段级写进导出的 `policy`**，与 `theta` 并列——
  两次在不同降档语义下采样得到的数字本来就不可比，所以语义必须跟着数字走。

**`denials: actionable | terse`**（可观测性 vs 策略保密）：默认 `actionable`，会把
"当前允许的工具清单"和"还差几个干净周期能挣回哪一档"直接告诉模型——这正是本插件的卖点；
但规则是启发式的，把阈值和仍被允许的动作集公布出去，会让探边界更便宜。把策略当敏感资产的部署
应设为 `terse`（只报拒绝与实时状态）。这个取舍属于部署方。

**包名与行名**：本包已改名为 **`@cyd-prc/dsh-entropy-guard`**（与 upstream 的 GitHub org 对齐，
发布溯源链为 org → 仓库 → 包 → 论文）。安装时 `install_bundle` 的 target 用新名或本包绝对路径；
客户端模块 id 为 `@cyd-prc/dsh-entropy-guard`，补丁行 id 为 `cyd-prc-entropy-guard`。
**行 id 是故意不沿用旧值的**：改名后若继续用 `entropy-guard`，新旧两个 bundle 会声明同一个
`entryId`，旧 bundle 就无法 `remove_bundle`（DSH 返回 `bundle-in-use`，实测确认）。

## 0.2.1

- **规则改为逐语句匹配（缺陷 8）。** Windows 递归删除规则的两个前瞻扫的是**整条命令**，
  于是"一处列目录带一个开关、另一处删单个文件带另一个开关"的脚本被判成一次递归强删——
  它在 0.2.0 的发布过程中否掉了本包自己的发布命令。现在按语句切分匹配（`;`、`&&`、`||`、转义换行），
  管道保持完整（`|` 是一条流水线）。测试 66 项（0.2.0 里这里印的是 51）。

## 0.2.2

- **两个平台画同一条灾难性根线（缺陷 9）。** Unix 目标模式读作"任何以路径分隔符开头的 token"，
  于是**每个绝对路径都被否决**——`/tmp/build` 要花掉一档和一次拒绝；而 Windows 侧只否决盘符绝对路径，
  `C:\tmp\build` 直接放行。**同一操作因平台得到相反判定，而这个差别哪儿都没写下来过。**
  现在两边都只列**根**（`/`、`/etc`、`/home`、`C:\`、`C:\Windows`、`C:\Users`、用户配置文件根、裸通配符）；
  限定子树（`/tmp/...`、`$env:TEMP\...`、`C:\tmp\...`、`./build`）在两边都是普通工作。
  `bash` 也以与 `pwsh` 相同的基线进入工具表，Linux 部署不再因为表是在 Windows 上写的而继承更低的定级。
- **链开始记录"判定的对象"（缺陷 10）。** 每条 `gate_decision` 现在带 `args_digest`
  （对规范化参数取 SHA-256，键序不影响结果）与 `tool_source`（`table` 或 `default`）。
  `audit.includeArguments: true` 现在**真的**存储参数的限量副本；此前这个开关在本文件与
  `cordis.patch.yml` 里都有文档，**却没有任何代码读取它**——开了等于没开。
  理由就是账本自己的：模式表判不了一个不透明的载荷（`python3 -c exec(base64…)` 对它不可见），
  所以能把它点名出来的必须是记录。
- **凭据目录，而不是某一个文件名（缺陷 11）。** 规则原先点名 `.ssh/id_*`，于是**读**私钥被否决，
  而**装** `authorized_keys`（影响更大——它是授予持久访问，而不是仅仅暴露一个密钥）不被否决。
  现在目标是凭据目录本身，目录里哪个文件被碰都一样。
- `status` 与 `/entropy status` 新增 `defaultedTools`：统计落到 `defaultTool` 的判定数，
  于是宿主改工具名会变成一个**数字**，而不是从显式条目静默漂移到通用基线。

## 0.2.3

- **发布的包现在带上它自己的补丁行（缺陷 12）。** `package.json` 声明了
  `dsh.bundle.patch: "./cordis.patch.yml"`，而 `files` 没有列这个文件——于是 npm 包只装了 13 个文件，
  **元数据指向的补丁行不在里面**：走**注册表**安装（用包规格而不是本地路径）会解析到一个没有行可应用
  的包，只有本地路径安装能用。这是把已发布的 0.2.2 实件与其提交逐文件比对时发现的。
  修复是 `files` 里加一行；本次发布的校验会断言 `package.json` 引用的每个路径
  （`icon`、`exports`、`dsh.bundle.patch`）都存在于 tarball 内。

## 0.2.4

- **发布的包现在带上自己的测试。** `test/` 进了 `files`，于是认证一次发布的套件可以被任何安装它的人**重跑**——
  这一点是在**已发布的 tarball 内部**跑出来验证的（71/71）。在此之前，包里有一个验链器，却要求读者对测试数**凭信**，
  这与本项目其余部分所遵循的标准相矛盾。代价约 42 KB。
- **探针与审计脚本进 `tools/`**：`coverage-audit.mjs`（用 PRE-GHR XLI 语料跑规则表）、`probe-boundary.mjs`、
  `probe-encoded.mjs`、`probe-filewrite.mjs`。本文里那些数字就是它们产出的，因此也是它们可以被重算的原因。
- `node --test test/core.test.mjs` —— 传**文件**而不是目录：Node 24 下 `node --test test/` 什么都不报，
  这一点已经被误当成"套件坏了"两次。套件自己的文件头现在写明了。

## 0.3.0

- **阶梯状态在激活时从链上折回（缺陷 13）。** 状态原本只作为轨迹存在于条目里，于是每次重启阶梯都从 `initialGear`
  重来，而链仍在描述一个已经爬升过的会话——在真实 profile 上实测为 **413 decisions 而 `cycles 0`**。
  现在一次新的激活会把 gear、σ、cycle、clean streak、连续拒绝数与挂起状态按"最后写入者胜"折回来、应用它，
  并记一条 `restore` 条目说明应用了什么。`init` 是激活标记、**不是**原点——这正是自主权能跨重启存活的原因。
  `reset` **是**原点，所以人工重置仍意味着白纸一张。**被篡改**的链永不作为状态来源；`restoreState: false`
  恢复此前"每次全新会话"的行为。`tool_error` 现在带转移后的状态，所以"报错后的 settle"折得精确。
  有界的保留说明：折算是精确到**最后一条带状态的条目**——最后一条决策之后的**成功** settle 本身不是条目，
  因此 σ 与 clean streak 可能相差一个周期。

## 十三、缺陷账（v0.1 → v0.3.0）

以下每一条都是在真实 profile 上跑出来的，并注明关闭它的修复。规律本身就是结论：
缺陷集中在"Python 形状的控制律撞上工具注册表"的地方，其中三条是守卫**误判了自己的维护动作**。

| # | 缺陷 | 观察到的后果 | 修复 |
|---|---|---|---|
| 1 | 规则扫描了文件**内容** | 本包拒绝了自己的源码编辑——改自己的规则表恰好触发正在被改的那条规则，被治理的 agent 无法修复线上那一代 | `contentKeys` 把"内容型参数"移出扫描面；否决权归于执行边界，shell 工具的命令参数仍全量扫描 |
| 2 | 规则只匹配操作、不匹配目标 | 清理本插件自己的临时目录被当成擦盘否决 | `dangerousTarget` 把两条递归删除规则收窄到绝对路径、家目录、工作目录本身或裸通配符 |
| 3 | 任何报错的工具结果都掉一整档 | edit 锚点过期、搜索无结果、网络调用被拒，都会掉一档并短暂拿走恢复所需的工具 | `policy.fastDown`（`overflow` 只花 σ）＋ `fallback.countGearDenials: false` |
| 4 | 阶梯自身的拒绝计入挂起 | 暂时低于工作档位的 agent 会因为继续调用本职工具而**自我挂起** | `countGearDenials: false` 与更高的 `maxConsecutiveRejections` |
| 5 | 审计字段名 `kind` 覆盖事件类型 | 链上每条 `would_deny` / `call_rejected` 都丢了事件类型（Python 会直接报错，JS 静默覆盖） | 事件类型最后展开，调用方字段再也无法改写记录类型 |
| 6 | 已安装包不热重载 | 磁盘上已修好的代码继续按旧逻辑执行——包括缺陷 1、2 | 记为固定限制 1；重复 `install_bundle` 返回 `ambiguous-install` 且不重载 |
| 7 | 守卫管工具调用，却管不到管理守卫的工具 | G3 会话可以用守卫给的自主权卸载守卫 | `plugin_manager` 归入 G4 Integrate |
| 8 | 规则跨整条命令匹配，而不是逐语句 | 一处列目录带一个开关、另一处删单个文件带另一个开关的脚本被判成一次递归强删——它否掉了本包自己的发布命令 | 规则逐语句匹配（`;`、`&&`、`\|\|`、转义换行），管道保持完整（`\|` 是一条流水线） |
| 9 | 销毁性目标线在两个平台上画得不同 | Unix 否决 `rm -rf /tmp/build`，Windows 放行 `C:\tmp\build`——同一操作、相反判定，而这个差别哪儿都没写 | 两边都只列灾难性根；限定子树在两边都是普通工作；`bash` 以 `pwsh` 的基线入表 |
| 10 | `audit.includeArguments` 有文档却从未被读取，且决策条目不记录对象 | 打开载荷记录的部署得到的是沉默；一次编码 `exec` 调用在链里只留下"shell admitted, U=…"，既没有载荷也没有目标 | 每条决策带 `args_digest`，旁边带 `tool_source`，开关现在真的存限量副本 |
| 11 | 凭据规则点名 `.ssh/id_*` | 读私钥被否决，而写 `authorized_keys`（持久访问）不被否决 | 目标是凭据目录，目录里哪个文件被碰都一样 |
| 12 | 包元数据指向一个 tarball 里不存在的文件 | `dsh.bundle.patch` 指向补丁行而 `files` 没列它，于是注册表安装解析到没有行可应用的包——社区路径坏了，而本地路径却能用 | 补丁行进 `files`，并在发布校验中断言元数据引用的每个路径都在 tarball 内 |
| 13 | 链记录了会话，而会话在每次重启时把自己的状态丢掉 | 真实 profile 实测：**413 decisions 而 `cycles 0`**——一个爬升过、又被拒绝打回 G2 的会话，重启后按 `initialGear` 反而**更宽松**，而"本可以做得更好"的证据就躺在链里 | 新激活从链上折回 gear/σ/cycle/clean streak/连续拒绝/挂起，记一条 `restore` 条目，并拒绝把被篡改的链当作状态来源 |

## 十一、溯源与许可

上游 `entropy-sdk` 为 MIT 许可，作者王苗生（ORCID: 0009-0003-2767-2421）。
本包移植其公开的核心语义，是该作者的 SDK 到 DeepSeek Harness 的独立绑定。
