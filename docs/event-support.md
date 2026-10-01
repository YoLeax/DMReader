# Event Bridge 字段与验证记录

核对日期：2026-10-01。依据 LAPLACE 官方 TypeDoc 与官方发布的 `@laplace.live/event-types@2.0.21`，运行时仅校验与本应用有关的字段，其余展示字段不参与朗读。

## 字段约定

| 类型 | 使用字段 | 去重依据 / 文案 |
| --- | --- | --- |
| message | id、origin、uid、username、message | 房间 + 类型 + id；UID 必须通过原有校验；读正文 |
| effect-message | id、origin、uid、username、message | 房间 + 类型 + id；读 message 的纯文本，不读 messageRaw 特效对象 |
| gift | id、origin、uid、username、giftName、giftAmount、giftId、receiver.uid | 保留完整 id（包括连击后缀）；读单条 giftAmount，不累计连续通知 |
| superchat | id、origin、uid、username、message、deleted | id 已包含上游 SC 唯一标识；scId 不是此标识。发送者 + 正文；deleted=true 跳过 |
| toast | id、stableKey、origin、uid、username、toastType、message、toastAmount、toastAmountUnit | 优先 stableKey；旧事件回退 id + 等级 + 数量 + 单位，区分赠送天数。1 总督 / 2 提督 / 3 舰长 |
| interaction | id、origin、uid、username、action | 房间 + 类型 + id + action；1 进场 / 2 关注 / 3 分享 / 4 特别关注 / 5 互相关注 |
| entry-effect | id、origin、uid、username | 房间 + 类型 + id；生成欢迎语，不读特效 message / effectId |
| like-click | id、origin、uid、username | 房间 + 类型 + id；感谢点赞。没有可靠数量字段，不推算次数 |

普通弹幕缺少有效 UID 时拒绝关联与播报。其他事件的有效文案可以使用默认声音；匿名事件不会通过昵称关联档案。点赞的 username 可能为空：有可靠 UID 且已有档案时使用保存的名字，否则称“一位观众”。

`toastType` 表示大航海等级，不表示开通或续费。Toast 没有结构化 action 字段，官方展示实现也是从 message 提取开通 / 续费。本服务只提取紧接等级前的动作，不直接朗读带标记的整条文案；无法判断时称“支持舰长 / 提督 / 总督”，不冒称开通。`toastAmountUnit=*8天` 等按数量换算天数，未知单位不朗读。

## 礼物数量与防刷屏

官方 Gift 类型提供 `giftAmount`，但类型说明没有保证各事件来源的连击增量 / 累计语义；连击信息只在 id 的说明中提到。不能把 ID 中的 `combo_total_coin` 当作礼物数，也不能假定连续 `giftAmount` 可相加。因此采用**冷却方案**：读第一条被接受通知的数量，冷却内后续通知只记录、不累加，不宣称播报的是整段连击总量。即使通知序列为 1、2、3，也不会误读成 6。此设计保留单条数量，同时明确放弃整段连击总量统计。

- 同一 UID、同种礼物、同一接收方：默认冷却 10 秒，可配置 1～300 秒。
- 同一 UID 点赞：默认 30 秒，可配置 1～300 秒。
- 同一 UID 的 interaction/action=1 与 entry-effect 共用默认 60 秒欢迎冷却，可配置 10～600 秒。先到且开启的事件被接受；关闭的事件不占冷却。
- 同一 UID 关注 / 分享 / 特别关注 / 互相关注：按行为分别固定冷却 10 秒。
- 缺少 UID 时按匿名事件组冷却，不根据昵称推断同一个人。
- 冷却使用最多 3,000 项的内存表，重启清空；事件去重仍保存在 SQLite，保留 7 天。

## 处理与开关

事件接收、字段校验、结构查看不依赖播报开关。活动日志包括事件类型，以及已排队、关闭播报、重复事件、字段异常、冷却跳过、身份回退、静音 / 长度 / 屏蔽 / 队列等跳过原因。日志总容量仍为最近 3,000 条。

“最近事件结构”按八种类型各保存最近一条，包含字段名称、必要字段值、来源与处理结果；重启清空结构快照。来源 `bridge` 是 WebSocket 接收，`simulation` 是本地模拟。过滤 SC 举报 token 等非必要字段。

保存开关后无需重启。关闭类型后，尚未开始合成的相应队列任务会在取出和取得合成锁时复核并跳过；已经发往云端的调用无法撤回。所有声音仍由 DM Reader 播放，沿用队列、缓存、预算和静音规则。

## 指令反馈

默认开启独立的“指令语音反馈”开关。设置成功后播报确认，不读原始 `#...` 文本。#音色、#风格、#语速、#重置、#定制 均有简短反馈；#查询 和 #我的音色 播报有效音色、语速及非空风格。#音色列表 和 #帮助 只展示后台结果。

关闭普通弹幕不会禁用这些指令和确认声音。查询反馈每人至少间隔 10 秒（若修改指令冷却更长则跟随更长值）。反馈使用个人声音，遵循单条字数上限；长风格文案截短。静音用户不执行指令；锁定偏好的用户仍可查询。总暂停 / 未开启播放器时保存设置但不积压反馈。

## 验证

自动化测试在独立临时数据库和模拟语音服务中运行，没有使用云端额度：

- 八种事件的开关、文案、个人音色 / 风格 / 语速与无 UID 回退。
- 五种 interaction 行为、缺失 / 错误字段、标记清理、未知 action、删除的 SC。
- 完整礼物 ID、SC ID、Toast stableKey 与赠送天数、互动 action 去重、重建 Engine 后持续去重。
- 礼物 / 点赞冷却、跨来源进场冷却、关闭的进场不阻挡开启的进场特效。
- 设置迁移 / 持久化、房间隔离、3,000 条日志容量。
- 指令语音确认、#查询、默认配置、缓存、冷却、关闭普通弹幕后仍可修改；关闭反馈后设置仍生效。
- 已排队及等待合成锁期间关闭类型，均不调用上游。
- 使用真实 WebSocket producer 协议与模拟语音服务，接收全部类型，检查管理 API、部分设置合并、异常记录、结构查看。

现有服务真实联调（2026-10-01）：

- LAPLACE 自动重连成功，真实房间 659719 的 message 含可靠 UID、username、message、id、origin、timestampNormalized。
- 临时关闭普通弹幕后，在真实直播间发送 #查询：按小何音色成功合成，云端返回 28 字，合成耗时 1,314 ms。
- 发送“关闭播报测试”：收到并记录为关闭播报，没有进入合成。
- 发送 #音色 小何：成功合成“YoLeax开始使用小何音色。”，云端返回 15 字，耗时 773 ms。
- 本轮真实合成共 43 字。本地累计计数从 47 到 90；测试后恢复普通弹幕开启，新增七类与互动子开关保持关闭，播放器恢复开启。
- 截至此次联调，没有通过现有桥收到其他七种类型的新事件；它们均只完成官方字段核对与模拟验证。刷新直播间也未收到可确认的进场通知。不能把旧页面里的礼物展示当作本次新解析器的真实验证。

## 官方来源

- [LaplaceEvent](https://chat.laplace.live/event-types/types/LaplaceEvent.html)、[类型索引](https://chat.laplace.live/event-types/modules.html)
- [Message](https://chat.laplace.live/event-types/interfaces/Message.html)、[EffectMessage](https://chat.laplace.live/event-types/interfaces/EffectMessage.html)
- [Gift](https://chat.laplace.live/event-types/interfaces/Gift.html)、[SuperChat](https://chat.laplace.live/event-types/interfaces/SuperChat.html)
- [Toast](https://chat.laplace.live/event-types/interfaces/Toast.html)、[Interaction](https://chat.laplace.live/event-types/interfaces/Interaction.html)
- [EntryEffect](https://chat.laplace.live/event-types/interfaces/EntryEffect.html)、[LikeClick](https://chat.laplace.live/event-types/interfaces/LikeClick.html)
- [官方展示实现的动作提取](https://github.com/laplace-live/chat-overlay/blob/master/src/utils/event-copywriting.ts)
