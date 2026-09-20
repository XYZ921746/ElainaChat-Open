# 手机 Agent 实现方案

> 目标：让 AI 能看见并操作手机界面（点击、滑动、输入、读控件树、截图）。
> 本文档是**设计基线**，实现前先对齐，避免方向跑偏。
> 标注约定：`[实测]` 表示有源码或运行验证，`[待验证]` 表示尚未证实。

---

## 一、结论先行

**1. 成本比预期低很多。** 上游 `shuixinggangzheng/ElainaChat-Open` 1.3.x 已经把最难的两块地基打好了——**悬浮窗前台服务**和**无障碍服务骨架**，而且是同项目、MIT，可以合法直接取用。

**2. 不需要自己写系统层。** root 那条路直接用现成的开源模块（KSU），我们只写 HTTP 调用层。

**3. `minSdk` 保持 29（Android 10），不做安装门槛。**

**4. 手机操作不新造标签前缀，挂进现有的 `[操作:…]` 家族。**

---

## 二、上游已有的原生资产（实测，可直接复用）

上游 1.3.x 的 `android-app` 里有这些东西，本地精简版没有：

| 文件 | 规模 | 用途 | 对我们的价值 |
|---|---|---|---|
| `ElainaPetService.java` | 384 行 | **悬浮窗 + 前台服务** | 高——Agent 浮层与保活的基础 |
| `ElainaPetPlugin.java` | 219 行 | 能力开关 + 全套引导 | 高——无障碍/悬浮窗/电池/厂商白名单引导 |
| `ElainaAccessibilityService.java` | 146 行 | 读屏（只读） | 中——需扩展成可操作 |
| `ElainaPetBridge.java` | 233 行 | 浮层 WebView 的 JS 桥 | 中——浮层与主应用通信 |
| `FileBridgePlugin.java` | 409 行 | SAF 文件选择/导出/导入 | 中——文件操作兜底 |
| `ElainaBootReceiver.java` | 26 行 | 开机自启 | 低——保活配套 |

### 2.1 悬浮窗前台服务（`ElainaPetService`）

实测它已经实现了：

- `TYPE_APPLICATION_OVERLAY`（API 26+）/ `TYPE_PHONE` 双兼容的悬浮窗
- 浮层内容是一个**内置 WebView**，加载 `file:///android_asset/public/pet.html`
- 拖动（`startDrag` / `endDrag`）、位置持久化（`savePosition`）、边界钳制（`clampToScreen`）
- **点击穿透开关**（`FLAG_NOT_FOCUSABLE` / `FLAG_NOT_TOUCH_MODAL` 动态切换）
- 软键盘处理（`SOFT_INPUT_ADJUST_RESIZE`）
- 前台通知（API 34 用 `FOREGROUND_SERVICE_TYPE_SPECIAL_USE`）
- 通过 `ElainaPetBridge`（`@JavascriptInterface`）与浮层双向通信

**这意味着 Agent 浮层（显示当前动作 + 停止按钮）几乎不用从零写**，复用这套机制，让浮层渲染 Agent 状态即可。

### 2.2 引导能力（`ElainaPetPlugin`）

现成的方法，一个都别重写：

```
openAccessibilitySettings()   跳无障碍设置页
openOverlaySettings()         跳本应用悬浮窗权限页
openBatteryWhitelist()        跳电池优化白名单（带降级路径）
openBrandWhitelist()          跳厂商自启动页（小米/华为/OPPO/vivo 四家）
checkShizuku()                Shizuku 是否运行 + 是否已授权
requestShizuku()              请求 Shizuku 授权
autoEnableAccessibility()     授权后引导开启无障碍
getStatus()                   综合状态查询
```

### 2.3 Shizuku 的地基（重要澄清）

`build.gradle` 已含：

```
implementation 'dev.rikka.shizuku:api:13.1.5'
implementation 'dev.rikka.shizuku:provider:13.1.5'
```

Manifest 已声明 `rikka.shizuku.ShizukuProvider`。

**但要如实说明**：上游对 Shizuku 的用法很浅——`requestShizuku()` 授权后**只是打开无障碍设置页**，`enableKeepAlive()` 是**一个字都没有的空方法**（只留注释）。

也就是说：**依赖、Provider、状态查询、授权请求都是现成的；真正"用 Shizuku 执行命令"必须我们自己写。** 别被方法名骗了。

---

## 三、五个后端

不是五选一，而是**一套工具名 + 多个可切换执行器**，运行时按优先级自动选，设置里可手动切。

### 3.1 架构：两条腿

```
                    ┌── 命令族（执行 shell 命令）
后端实现 ───────────┤     ├── KSU 模块
                    │     ├── su（root）
                    │     ├── Shizuku（UID 2000）
                    │     └── ADB（电脑侧）
                    │
                    └── 无障碍（调原生 API，不执行命令）
                          └── dumpUiTree / dispatchGesture / ACTION_SET_TEXT
```

命令族的四个执行器**共用同一套命令字符串**，只是换个地方执行：

| 动作 | ADB | Shizuku / su |
|---|---|---|
| 点击 | `adb -s <sn> shell input tap x y` | `input tap x y` |
| 滑动 | `... shell input swipe x1 y1 x2 y2 300` | `input swipe x1 y1 x2 y2 300` |
| 按键 | `... shell input keyevent 4` | `input keyevent 4` |
| 控件树 | `... shell uiautomator dump /sdcard/w.xml` | 同命令 |
| 截图 | `adb exec-out screencap -p` | `screencap -p /sdcard/s.png` |
| 启动应用 | `... shell am start -n 包/活动` | `am start -n 包/活动` |

所以**命令构造层只写一份**，产出物四个后端共用。

### 3.2 优先级与探测

| 优先级 | 后端 | 探测方式 | 权限 |
|---|---|---|---|
| 1 | KSU 模块 | `GET 127.0.0.1:3070/api/status` 有响应 | root |
| 2 | su | `su -c id` 拿到 `uid=0`（首次弹授权） | root |
| 3 | Shizuku | `pingBinder()` + `checkSelfPermission()` | shell(2000) |
| 4 | ADB | 电脑侧 `adb devices` 有设备 | shell(2000) |
| 5 | 无障碍 | 查服务是否在运行 | 用户手动开权限 |

前四个都能执行命令，第五个只能调原生 API。**五个都可用时，per-tool 选择最优后端**（见 3.4）。

### 3.3 能力差异（必须体现在 UI）

不同后端能力不同，**不能让模型去调一个不存在的工具**：

| 能力 | 模块 | su | Shizuku | ADB | 无障碍 |
|---|---|---|---|---|---|
| 点击/滑动 | 有 | 有 | 有 | 有 | 有 |
| 输入文字 | 有 | 有 | 有 | 有 | 有 |
| 读控件树 | 有 | 有 | 有 | 有 | 有 |
| 截图 | 有 | 有 | 有 | 有 | 仅 API 30+ |
| 启动应用 | 有 | 有 | 有 | 有 | 受限 |
| 任意 shell | 有 | 有 | 有 | 有 | **无** |
| 不抢前台 | **有** | 无 | 无 | 无 | 无 |

设置页要显示"当前后端支持哪些工具"，提示词也只注入可用工具的说明。

### 3.4 后端选择策略

- **命令族优先**：只要有模块/su/Shizuku/ADB 任一可用，命令类工具走它（比无障碍更稳、能力更全）
- **无障碍兜底**：什么都没有时用它，零安装门槛
- **混合**：无障碍可用而命令族不可用时，点击/输入可走无障碍；同时有命令族时，读控件树优先用 `uiautomator dump`（结构化更完整）

---

### 3.5 选择界面（已实现）

侧边栏底部有「实现方式」入口（`#railBackendBtn`），点开是四个后端的选择面板（`#backendPanel`）：

| 后端 | 门槛标签 | 探测方式 |
|---|---|---|
| 无障碍 | 免 root | 待接入（依赖原生层） |
| ADB | 需要电脑 | 待接入（依赖原生层） |
| Root | 需要 root | 待接入（依赖原生层） |
| 模块 | 需要 KernelSU | **可真探测**：`fetch('http://127.0.0.1:3070/api/status', { mode: 'no-cors' })` |

**默认不预设任何实现方式**（`agentBackend: ''`）。未选择时三件事同时发生：

1. 入口按钮灰显（`.is-unset`，`opacity: .42`）
2. 面板顶部给出提示「还没有选择实现方式，AI 现在不能操作手机」
3. 手机操作被直接拒绝并回灌提示（`runAgentPhoneOperation` 开头检查）

选过之后入口按钮恢复、选择写入设置（随跨设备同步）。

**入口按钮灰显但仍可点** —— 这是刻意的：完全禁用会死锁（进不去面板就永远无法选择）。
灰显表达的是「功能尚未启用」，而不是「按钮不可用」。

**「去设置 / 请求权限」按钮（每个后端一个）**

每个卡片右下角有对应按钮，行为分两层——**渐进增强**：

| 后端 | 按钮 | 原生接入后 | 现在（网页版） |
|---|---|---|---|
| 无障碍 | 去开启无障碍 | `ElainaPet.openAccessibilitySettings()` 真跳转到系统无障碍页 | 说明弹窗（含四家厂商路径差异） |
| ADB | 怎么开启调试 | — | 说明弹窗（开发者选项 / USB 调试 / 无线调试） |
| Root | 请求 root 授权 | `ElainaShell.requestRoot()` 弹系统授权框 | 说明弹窗（含风险提示） |
| 模块 | 怎么刷模块 | — | 说明弹窗（KernelSU / 3070 检测） |

`openBackendSetup()` 先检查 `window.Capacitor?.Plugins?.[plugin]?.[method]` 在不在，
在就真跳转，不在就退化成说明弹窗。于是**网页版、未接入原生的 APK、接入之后的 APK
三种情况都能给出可执行的下一步，而代码只有一份**。

面板底部还有「重新检测」，用于刷完模块 / 开完权限后刷新状态。

**卡片为什么用 `div` 而不是 `button`**：卡片里还要放「去设置」按钮，而 HTML 不允许
button 嵌套 button（浏览器会把结构解析错乱）。所以卡片是 `div[role=button][tabindex=0]`，
点击时用 `closest('[data-backend-setup]')` 判断是否点在设置按钮上——是则不触发选中。

**「模块」为什么能真探测而其他不能**：它的网关在本机 3070 端口。`no-cors` 的 fetch
读不到响应内容，但"有没有响应"足够判断它在不在（连不上会抛错，连得上返回不透明响应）。
另三个依赖 `window.ElainaDevice`，尚未实现，所以显示「待接入」——
接入后把 `detectBackend()` 改成读 `dev.status()` 即可，**UI 一行都不用改**。

## 四、版本门槛

`minSdk = 29`（保持不动）。

| 能力 | 最低 API | 说明 |
|---|---|---|
| 基础（聊天/Live2D/语音） | 29 | 现状 |
| Shizuku 无线调试启动 | **30** | Android 10 需电脑 adb 启动一次，功能不缺失 |
| `AccessibilityService.takeScreenshot` | **30** | Android 10 上无障碍后端无截图，可只读控件树 |
| 前台服务 `specialUse` 类型 | 34 | 已用运行时判断处理 |
| 无线调试（系统功能） | 30 | 同 Shizuku 那条 |

**做法**：API 30 的能力加 `SDK_INT >= 30` 运行时判断；设置页显示"你的系统支持哪些后端"，按版本给不同引导文案。

---

## 五、厂商与权限适配

这一节回答"手机太多，适配会不会炸"。结论分三层：

### 5.1 哪一层不是问题（重要，别自己吓自己）

**Android 是 CTS 认证的，标准 API 的行为在全平台一致。**

`dispatchGesture`、`ACTION_SET_TEXT`、`AccessibilityNodeInfo`、`performGlobalAction`、
`uiautomator dump`、`screencap`、`input tap` —— 这些都是 AOSP 标准接口，
厂商**改的是"允不允许你用"，不是"API 行为不一样"**。

所以"同一个点击代码在小米上点得到、在华为上点歪了"这种事**不会发生**。
真出问题一定出在"权限没给到"或"后台被杀了"，而不是"接口行为不同"。

**这条推论很重要**：它意味着适配工作的性质是**做引导 + 做保活 + 做降级**，
而不是"每个厂商写一套实现"。别一头扎进"厂商适配地狱"里。

### 5.2 真正的问题集中在三处

| 问题域 | 具体表现 | 严重度 |
|---|---|---|
| **① 权限授予路径** | 各家设置页层级不同，有的还多一层独立开关（见 5.3） | 中，可解决 |
| **② 后台保活** | 厂商后台管理会杀前台服务、掐通知、限制自启 | **高**，影响长任务 |
| **③ root / 模块** | 模块写死机型框架包，换机型要改 | 高，但只影响 root 用户 |

### 5.3 已知的厂商坑（社区共识 + 上游代码佐证）

上游 `ElainaPetPlugin.openBrandWhitelist()` 里**硬编码了四家的自启动页 ComponentName**
（小米 / 华为 / OPPO / vivo）—— 这本身就是"适配坑真实存在"的代码级证据，
是作者踩过之后写下来的：

```
com.miui.securitycenter     小米
com.huawei.systemmanager    华为
com.coloros.safecenter      OPPO
com.vivo.permissionmanager  vivo
```

补充已知项：

| 厂商 | 坑 |
|---|---|
| 小米 / POCO（MIUI / HyperOS）| Shizuku 模拟点击需要开发者选项里**额外打开「USB 调试（安全设置）」**（独立开关，不开就是点了没反应）；通知样式要从「通知栏」切成「Android」才能填配对码；还需「后台弹出界面」权限 |
| OPPO / 一加（ColorOS）| 需关闭**「权限监控」**；后台管理激进 |
| 华为 / 荣耀 | 后台清理严格；自启动管理入口深 |
| vivo / iQOO | 同上，另有独立的「后台高耗电」白名单 |
| 三星 | 相对宽松，但「休眠应用」会冻结后台 |
| 通用 | 电池优化白名单、锁屏清理、内存清理都会干掉前台服务 |

**注意**：上表除小米/OPPO 那两条来自 Shizuku 官方文档外，其余是社区经验，
**标注为「已知」而非「实测」**，真要定论得逐台验证。

### 5.4 我们的应对策略（五条）

**① 能力探测，不做版本/机型猜测。**
不写 `if (小米) {...}`。一律运行时问系统：
无障碍服务在不在运行、Shizuku 通不通、`canDrawOverlays()` 有没有、
`su` 拿不拿得到 uid=0。探测到就用，探测不到就走降级。

**② 五后端本身就是最大的适配策略。**
某个后端在这台机器上不通，换一个。这是"多后端"设计除了能力互补之外的第二个价值：

```
无障碍被 ROM 限制 → 试 Shizuku
Shizuku 没装     → 试 ADB（电脑在场时）
都不行           → 明确告知"这台设备暂时不支持"，而不是转圈装死
```

**③ 引导分厂商做。**
`openBrandWhitelist` 的模式是对的（按包名逐个试，试到能用为止），
我们把它从 4 家扩到 8 家左右，并加"都没命中就打开应用详情页"的兜底。

**④ 保活分三层，逐层降级。**
前台服务（已有）+ 电池优化白名单（已有引导）+ 厂商自启动白名单（已有引导）。
三层都做了还被杀，就承认"长任务在这台设备上跑不完"，改成**短任务 + 可恢复**
（把 Agent 状态存盘，回来能接着跑）。

**⑤ 失败必须能诊断 —— 这条我们已经有基础设施了。**
之前做的**启动窗口日志转发**在这里价值极大：手机上的失败原因会被推到电脑的
cmd 窗口。没有这个，适配问题只能靠猜；有了它，"哪一步失败了、系统返回什么"
一目了然。这是整个适配工作能不能收敛的关键。

### 5.5 诚实的结论

- **不搞 root/模块**（只用无障碍 + Shizuku）：适配面**窄很多**，问题集中在引导和保活，
  大量工作是"文案 + 跳转"而不是"实现"。这是主要支持的路径。
- **搞 root/模块**：能力最强，但**适配成本陡增**，而且只服务一小部分用户。
  模块那条路的适配由上游项目承担（它的 `BOOTCLASSPATH` 写死了 ColorOS 框架包，
  非 OPPO 要改）——这也是我们**不自己写模块**的又一个理由。
- **一点实话**：我没法在电脑上验证任何厂商的真实行为。我能做的是
  "让失败可见 + 让降级可行"，具体某台机器行不行，必须真机试。

## 六、需要自己写的部分

只有三块，其余都能复用。

### 5.1 无障碍服务的操作能力扩展

改 `ElainaAccessibilityService` + `res/xml/elaina_accessibility.xml`：

```
xml 里加：android:canPerformGestures="true"
```

服务里新增（`[待验证]` 的是我没法在电脑上跑、必须真机确认的行为）：

| 方法 | 实现要点 |
|---|---|
| `dumpUiTree()` | 遍历 `getRootInActiveWindow()`，输出**扁平元素列表**（每元素一行文本），含文本/ID/可点击/绝对坐标 |
| `tap(x, y)` | `dispatchGesture` 单击（`Path` + `GestureDescription`） |
| `swipe(x1,y1,x2,y2,ms)` | `dispatchGesture` 滑动 |
| `longPress(x, y)` | `dispatchGesture` 长按（800ms） |
| `type(text)` | 找焦点节点 → `ACTION_SET_TEXT`（`Bundle` 带 `ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE`），**不弹输入法** |
| `back()` / `home()` | `performGlobalAction(GLOBAL_ACTION_BACK / HOME)` |
| `clickById(id)` | `findAccessibilityNodeInfosByViewId` → `ACTION_CLICK`，找不到就向上找最近可点击祖先 |

**关键工程细节**（照搬现成经验，别自己拍）：

- **点击目标是"自己可点就用自己，否则找最近的可点击祖先"**，并记录继承层级。现实里大量 App 把可点容器包在文字子节点外层，只看 `clickable` 会漏掉一半可点区域
- **dump 输出扁平文本而非嵌套 JSON** —— 省 token，模型也不容易看错层级
- **字符预算与压缩阈值要配套** —— 若预算 > 触发裁剪的阈值，裁剪器会把 JSON 从数组中间切开，模型收到坏片段，比超长更糟。实测密集界面占用：高德 10403 / 淘宝 11010 / 微信 7319 / 美团 4241 / 设置 3920 字符
- `AccessibilityNodeInfo` 用完 `recycle()`，遍历加深度上限（现有代码是 18 层）

### 5.2 命令执行器

**新增一个 Capacitor 插件**（比如 `ElainaShellPlugin`），对外暴露统一入口：

```
exec(cmd)  →  按后端优先级执行，返回 { ok, stdout, stderr, backend }
status()   →  各后端可用性 + 当前后端 + 支持的工具列表
```

各执行器的实现差异：

| 后端 | 执行方式 |
|---|---|
| 模块 | HTTP POST `127.0.0.1:3070/api/shell`（**网关地址做成可配置**，别写死） |
| su | `Runtime.exec(["su", "-c", cmd])` 或 `ProcessBuilder` |
| Shizuku | **UserService 模式**（AIDL，在 Shizuku 进程里以 UID 2000 跑）——比 `newProcess` 稳 |
| ADB | 交给电脑侧 `serve.mjs` 执行（我们本来就有 Node 服务） |

**Binder 有 1 MB 事务上限**，命令输出要截断（社区做法约 900 KB），截断比崩掉好。

**Shizuku 的坑**（写进引导文案）：

- 非 root 场景**每次重启都要手动启动一次 Shizuku**（不用重新配对），系统限制无解
- 小米/POCO：开发者选项要额外打开「USB 调试（安全设置）」；通知样式切「Android」才能填配对码
- OPPO/一加：关闭「权限监控」
- 通用：加后台白名单、停用 adb 授权超时
- 五状态机必需：没装 / 没启动 / 没授权 / 已就绪 / 已连接

### 5.3 前端工具层

见第六、七节。

---

## 七、工具清单

对齐 `dsh-preset-mobile-use` 实际注册的 **11 个工具**（MIT，可照搬定义结构：`name` / `description` / `parameters` / `properties` / `required`）。

| 工具 | 参数 | 说明 |
|---|---|---|
| `mobile_status` | — | 当前后端、屏幕尺寸、前台应用 |
| `mobile_screenshot` | — | 截图（返回缩放比） |
| `mobile_dump_ui` | — | 控件树，扁平文本 |
| `mobile_click` | `x, y` | 点击 |
| `mobile_swipe` | `x1,y1,x2,y2,duration` | 滑动 |
| `mobile_type` | `text` | 输入文字 |
| `mobile_press_key` | `key` | 返回/主页/回车 |
| `mobile_launch_app` | `package` | 启动应用 |
| `mobile_shell` | `command` | 执行命令（**无障碍后端不支持**） |
| `mobile_switch_mode` | `mode` | 后台/前台模式（模块后端专属） |
| `mobile_wait` | `ms` | 等待（给界面渲染留时间） |

---

## 八、前端对接方式

### 8.1 挂进 `[操作:…]` 家族，不新造前缀

现有体系里 `[操作:…]` 已经是"应用功能入口"，而且已支持带参数形式（`[操作:保存文件 路径|内容]`）。所以手机操作直接加入：

```
[操作:手机状态]
[操作:手机截图]
[操作:手机查看界面]
[操作:手机点击 500 800]
[操作:手机滑动 500 1500 500 500 300]
[操作:手机输入 你好世界]
[操作:手机按键 返回]
[操作:手机打开 包名]
[操作:手机等待 800]
```

好处：复用现有的标签解析、剥离显示、权限检查、错误回灌（失败会以系统消息回灌给模型让它解释）整套链路。

### 8.2 权限模型加一档

现有 `state.settings.agentPermission` 两档，加第三档：

```
'app'      仅应用文件夹内操作
'computer' 允许操作电脑（文件读写）
'phone'    允许操作手机（点击/输入/截图）    ← 新增
```

**实际实现（已落地，与上面的草案不同）**

最终没有把 `agentPermission` 加成三档，而是**拆成两组、按设备形态各显示一组**——
因为手机上看到「允许操作电脑」莫名其妙，电脑上看到「手机操作」也没用。

| 设置键 | 所属组 | 取值 |
|---|---|---|
| `agentPermission` | 电脑侧「电脑操作权限」 | `app` / `computer` |
| `agentPhoneEnabled` | 手机侧「手机操作」总开关 | 布尔 |
| `agentApproval` | 手机侧「敏感操作确认」 | `always` / `run` / `off` |

展示由 `IS_MOBILE_DEVICE` 决定，在 `fillSettingsForm()` 里经 `syncAgentSectionsByDevice()` 应用：

```js
IS_NATIVE_APP                                  // 安卓版 App 一律按手机
|| /Android|iPhone|iPad|iPod|Mobile|.../       // 移动端 UA
|| (/Macintosh/ && maxTouchPoints > 1)         // iPadOS 13+ 伪装成 Macintosh，靠触摸点数区分
```

**这里刻意用「设备本身」而不是窗口宽度**（项目里已有的 `isMobileConversationLayout()` 看的是
860px 断点，那是排版用的）——电脑上把窗口拖窄不该变成"手机"。

总开关关闭时 `runAgentPhoneOperation()` 直接拒绝并回灌，**不弹授权窗**（避免"关了还问"的怪异体验）。

提示词按档位注入对应说明（现有逻辑在 5066-5069 行，照同样的模式加）。

**安全要求**：

- 必须有**浮层显示"正在操作"**，用户能随时看到并停止
- 敏感操作（点击、输入）前不做静默，浮层要有明显提示
- 设置页写清"授权 Shizuku = 把这个 App 提权到 adb 级别"

### 8.3 必须遵守的工程约束

这几条不做会"能用但很糟"：

1. **截图必须把缩放比告诉模型。** 截图会降采样省 token，坐标统一用绝对像素；不传比例会导致点击坐标整体偏移
2. **历史截图必须卸载。** 多轮操作会不断累积截图，到八万 token 时多模态推理延迟飙到 40 秒级。做法：旧图换成占位符，上下文只留最新一张
3. **中文输入不能走 `input text`**（只支持 ASCII）。走无障碍 `ACTION_SET_TEXT`（命令族）/ 剪贴板注入（root），这条必须在实现前定
4. **`node --check` 对 ESM 会误报通过**（按 CommonJS 解析），插件校验要真 import 并跑一遍挂载

---

### 8.4 停止与授权机制（已实现）

这一节记录**已经落地**的部分，代码在 `web/index.html`（另需 `web/live2d-video.js` 的
`handleAgentOperation` 转发）。

**运行状态条**（`#agentRunBar`）：运行期间固定在屏幕上方，`z-index: 100000`（高于 Live2D
通话界面的 99999），显示脉冲点 + 当前步骤与动作名 + 「停止」按钮。

**`window.agentRuntime` 接口**

| 接口 | 作用 |
|---|---|
| `beginBatch()` | 每条 AI 回复开始时调用：开启新批次、解除上一批的「已停止」状态 |
| `beginRun()` | 进入运行态，显示状态条 |
| `setStep(n, action)` | 更新步骤号与当前动作 |
| `requestStop(reason)` | 请求停止：设标志 + 中断在途请求 + 关掉等待中的确认弹窗 |
| `assertNotStopped()` | 执行点自检，已停止则抛 `agentAborted` 错误 |
| `track(controller)` | 登记 AbortController，停止时统一 abort |
| `requestApproval(action, detail)` | 敏感操作授权，返回是否允许 |
| `isHalted()` / `endRun()` | 批次是否已被停止 / 结束运行 |

**停止为什么必须有「批次」概念（容易踩的坑）**

如果每一步都调 `beginRun()` 而 `beginRun()` 会清掉停止标志，那么用户点停止后，
同一条回复里剩余的步骤会各自重新开始——**停止等于失效**。所以停止做成**粘性**的
（`halted` 标志），只由 `beginBatch()` 在新的一批开始时解除。

**风险分级与授权策略**

| 等级 | 动作 | 行为 |
|---|---|---|
| safe | 手机状态 / 查看界面 / 截图 / 等待 | 直接放行，不打扰 |
| sensitive | 点击 / 滑动 / 输入 / 按键 / 打开 | 按设置里的策略 |
| dangerous | 手机命令（任意 shell） | 无论策略如何都单独询问 |

策略存在 `state.settings.agentApproval`，三档：`always`（默认，每次都问）/
`run`（同一次运行内允许过就不再问）/ `off`（不询问）。**非法值一律回落到 `always`**。

**被拒绝或被停止时结果会回灌对话**（`insertAgentResult`），模型能看到并换方式，
不会静默失败或卡住。这也是"拒绝"能成为一种有效交互而不是死路的原因。

**已验证**：56 项回归全通过——状态条显隐与文案、停止（含**打断等待中的确认弹窗**）、
三种策略、风险分级、脏数据回落、端到端链路（`[操作:手机点击 …]` → 授权 → 拒绝/允许 → 回灌）、
停止拦截同批次后续动作、解析容错、无 JS 异常。

**尚未接入**：原生设备能力。执行层调用 `window.ElainaDevice.exec({ action, args })`，
该对象还没实现，所以现在走到执行层会明确提示「设备能力还没接入」——
**这是刻意保留的诚实状态**：机制已就绪，接入原生后上层逻辑一行都不用改。

## 九、分片计划

| 片 | 内容 | 能否本地验证 |
|---|---|---|
| **1** | 无障碍操作能力：`canPerformGestures` + `dumpUiTree` + `tap` + `type` + `back/home`；新增 `ElainaShellPlugin`（先只接 Shizuku/ADB 两个执行器）；前端加权限档 + 9 个工具的标签解析 | 编译通过 + JS 侧桩测试；交互只能真机 |
| **2** | 悬浮窗状态显示（复用 `ElainaPetService` 机制）：当前动作 + 停止按钮；截图 + 视觉定位的缩放比链路 | 编译 + 桩测试 |
| **3** | 模块后端（HTTP 映射到 3070）；su 执行器；`mobile_switch_mode` / `mobile_wait` | 需真机 + 已刷模块 |
| **4** | 可靠性：循环搬到前台服务（避免 WebView 后台被节流）；标签协议升级为正规 Tool Calling（JSON Schema 校验） | — |

**建议从第 1 片开始。** 它不需要用户手机上装任何东西（无障碍是系统自带），做完能立刻真机看到效果。

---

## 十、验证方式与诚实边界

**我能保证的**：

- 编译通过（Gradle + JDK 21 环境已就绪）
- JS 侧逻辑用桩测试覆盖（模拟原生插件的返回值）
- 提示词与标签解析的正确性

**我保证不了的（必须你真机验证）**：

- 无障碍的 `dispatchGesture` 在具体机型/ROM 上是否被拦
- Shizuku 的 `input` 命令在各 ROM 是否都可用（小米「安全设置」开关可能拦截）
- 浮层在各厂商后台管理下的存活情况
- 中文输入法的实际表现

**一条铁律**：任何会打开页面的自动化测试，**必须先拦掉 `/api/store`**，否则测试数据会推到服务端污染真实数据（这个坑已经踩过一次）。

---

## 十一、可复用的外部资产

| 来源 | 许可 | 怎么用 |
|---|---|---|
| 上游 `shuixinggangzheng/ElainaChat-Open` | MIT | 直接取原生文件（同项目血缘） |
| `AcidGr/agent-mobile-use` | MIT | 设备层**不写代码**，让用户刷现成模块，我们只当 HTTP 客户端 |
| `AcidGr/dsh-preset-mobile-use` | MIT | 搬 11 个工具定义 + 缩放比/图片卸载的纯函数 |
| `Mangi-11/Eta` | PolyForm Noncommercial | **只读文档学思路**（尤其 `ROOTLESS_SUPPORT.md`），代码与文字都不能搬 |
