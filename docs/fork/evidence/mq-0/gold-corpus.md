# MQ-0 证据：gold 事实语料与 strata 方向核对

本文件是 MQ-0 批次“纯数据准备 + 代码核对”的产出，由只读调查生成（2026-09-06），并在 2026-09-07 修正了 `zh-to-en` 查询方向。
范围：为 `packages/memory-core/src/evaluation.ts` 中 `MEMORY_RETRIEVAL_EVALUATION_CASES`
引用的 20 个 fact id 补齐 gold 事实内容；核对 9 个 strata 的定义与实际查询语言方向。
本文件补数据与核对方向；最终存储方案由 MQ-0 实施时决定。

## 语料说明

- 数据性质：这些是**合成 gold 数据**，不是真实用户数据。来源字段统一以
  “合成样本：用户陈述……”开头，并显式标注 `synthetic`，不虚构真实 journal 引用。
- 双语目的：每个 fact id 同时给出**中文内容**与**英文内容**，供
  en-to-zh（英文查询检索中文事实）与 zh-to-en（中文查询检索英文事实）双向跨语言检索。
  概念上每个 fact id 对应**两条记录**（`zh` 一条、`en` 一条），共用同一逻辑 id。
 具体是存为两条独立记录还是一个可派生双语字段，由 MQ-0 实施时决定；本批只补内容。
- 语言字段：`zh` / `en`。下表每个 id 同时列出两语言内容，语言元数据为 `zh + en`。
- 状态：一律 `approved`（可进入生产检索的事实门）。
- 适用时间：区分“长期有效”与“适用于 2026-09 观察期”；temporal 组涉及过去/未来表述，
  时间语义已在相应 id 的“适用时间”列体现。
- 与查询的一致性：每条内容已对照全部指向它的查询逐条核对，尤其是 negation 组
  （`fact-no-*` 表示“否定概念本身成立”的事实）与 near-miss / multi-fact 组的细微语义。

## gold 事实语料表

| id | 概念 | 中文内容 | 英文内容 | 语言 | 来源（synthetic 标注） | 状态 | 适用时间 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `fact-scholarship` | 奖学金申请与材料 | 用户计划申请奖学金，正在准备申请材料（成绩、语言成绩、推荐信与申请时间表）；奖学金申请属于其学习计划的一部分，即使存在助学金等其他选项，用户仍优先考虑奖学金且不打算放弃申请。 | The user plans to apply for a scholarship and is preparing the application materials (grades, language scores, recommendation letters, and an application timeline); the scholarship application is part of their study plan, and even when alternatives such as a grant exist, the user prefers the scholarship and does not intend to give it up. | zh + en | 合成样本：用户陈述“计划申请奖学金并整理申请材料”，synthetic | approved | 长期有效（适用于 2026-09 观察期） |
| `fact-study-abroad` | 出国留学规划 | 用户计划出国留学，正在规划学校选择、语言考试与时间安排；留学是用户近期目标，属于学习计划的一部分，用户对留学相关时间表（含考试准备）有明确需求。 | The user plans to study abroad and is planning university choices, language exams, and a timeline; studying abroad is a near-term goal and part of the study plan, and the user has clear needs for an overseas-study timeline including exam preparation. | zh + en | 合成样本：用户陈述“正在考虑出国留学并整理规划”，synthetic | approved | 适用于 2026-09 观察期（近期规划） |
| `fact-appearance` | 外观改变（换发型） | 用户最近更换了发型，这是新的外观事实，与学习计划无关；该发型是当前外观，用户不希望它被误记为旧外观。 | The user recently changed their hairstyle; this is a new appearance fact unrelated to the study plan. That hairstyle is the current look, and the user does not want it mistaken for an old one. | zh + en | 合成样本：用户陈述“最近换了发型和外观”，synthetic | approved | “最近发生”（约 2026-09 观察期），当前有效 |
| `fact-test-first` | 先跑测试再改接口 | 用户偏好修改接口前先运行测试，以避免协议与实现不一致；对用户而言“先测试”是接口改动前的必要步骤。 | The user prefers to run tests before changing an interface, to avoid a mismatch between the protocol and the implementation; running tests first is a required step before an interface change. | zh + en | 合成样本：用户陈述“修改接口前先跑测试”，synthetic | approved | 长期有效（工作方法偏好） |
| `fact-protocol-first` | 改接口前先核对协议 | 用户修改接口前必须先核对协议，协议核对优先于接口实现；即便只是查看接口文档、未准备修改接口，协议核对仍是必要步骤，协议不能被忽略。 | The user must review the protocol before editing an API; protocol review takes priority over implementation. Even when only reading the API docs without planning to change the API, reviewing the protocol is a required step and must not be ignored. | zh + en | 合成样本：用户陈述“接口修改前要看协议”，synthetic | approved | 长期有效（工作方法偏好） |
| `fact-work-avoidance` | 用工作/代码回避压力 | 用户有时通过工作和写代码来暂时回避现实压力，这个模式会反复出现，近期（2026-09 观察期）再次出现。 | The user sometimes uses work and coding to temporarily avoid real-life stress; this pattern recurs and has shown up again recently (2026-09 observation window). | zh + en | 合成样本：用户陈述“习惯用代码处理压力”，synthetic | approved | 长期有效（反复出现的模式，适用于 2026-09 观察期） |
| `fact-no-startup` | 对创业/成为创业者无兴趣 | 用户对创业方向没有兴趣，即使有机会也不愿成为创业者；创业不是用户的职业目标，用户更看重学习（与职业路径相反）。 | The user is not interested in entrepreneurship or becoming an entrepreneur, even when an opportunity appears; starting a business is not a career goal, and the user values study more. | zh + en | 合成样本：用户陈述“不想成为创业者”，synthetic | approved | 长期有效 |
| `fact-no-study-abroad` | 没有出国留学计划 | 用户没有出国留学的计划；用户更倾向短期旅行而非长期出国留学（“可能有留学规划”这一判断不成立）。 | The user has no plan to study abroad; the user prefers short-term travel over long-term overseas study (any claim that they plan to study abroad is false). | zh + en | 合成样本：用户陈述“没有出国留学的计划”，synthetic | approved | 适用于 2026-09 观察期（当前无计划） |
| `fact-no-work-avoidance` | 不通过工作/代码逃避压力 | 用户避免用工作和代码来逃避压力；用户更倾向用运动等其他方式处理压力，而不是工作和代码。 | The user avoids using work and coding to escape stress; the user prefers other ways such as exercise to handle stress, rather than work and coding. | zh + en | 合成样本：用户陈述“避免用工作逃避压力”，synthetic | approved | 长期有效 |
| `fact-no-appearance` | 外貌没有改变 | 用户的外貌没有改变；换发型（或换新头像）的是别人/其他对象，不是用户本人，用户的外观仍是旧外观。 | The user's appearance has not changed; the person who changed hairstyle (or the new avatar) is someone/something else, not the user; the user's look remains the old one. | zh + en | 合成样本：用户陈述“我没有换发型/外貌未变”，synthetic | approved | 当前有效（外貌未改变） |
| `fact-unrelated-01` | 天气与公交 | 明天的天气预报有雨，公交线路会调整。 | The weather forecast predicts rain tomorrow, and the bus routes will be adjusted. | zh + en | 合成样本：背景事实（天气预报），synthetic | approved | 长期有效（与用户核心记忆无关） |
| `fact-unrelated-02` | 园艺/室内植物书 | 用户想读一本关于园艺和室内植物的书。 | The user wants to read a book about gardening and indoor plants. | zh + en | 合成样本：背景事实（阅读兴趣），synthetic | approved | 长期有效（与用户核心记忆无关） |
| `fact-unrelated-03` | 晚餐采购 | 晚餐需要买米饭、蔬菜和水果。 | Dinner needs rice, vegetables, and fruit to be bought. | zh + en | 合成样本：背景事实（采购），synthetic | approved | 长期有效（与用户核心记忆无关） |
| `fact-unrelated-04` | 电影观感 | 这部电影的摄影风格和配乐都很特别。 | This film's cinematography and soundtrack are both distinctive. | zh + en | 合成样本：背景事实（观影），synthetic | approved | 长期有效（与用户核心记忆无关） |
| `fact-unrelated-05` | 周末家务 | 周末可以整理房间并清洗窗户。 | The weekend is a good time to tidy the room and clean the windows. | zh + en | 合成样本：背景事实（家务计划），synthetic | approved | 长期有效（与用户核心记忆无关） |
| `fact-unrelated-06` | 城市新闻 | 这条新闻讨论城市交通和公共设施。 | This news discusses city traffic and public facilities. | zh + en | 合成样本：背景事实（城市新闻），synthetic | approved | 长期有效（与用户核心记忆无关） |
| `fact-unrelated-07` | 自行车维护 | 用户需要给自行车轮胎充气并检查刹车。 | The user needs to inflate the bicycle tires and check the brakes. | zh + en | 合成样本：背景事实（自行车维护），synthetic | approved | 长期有效（与用户核心记忆无关） |
| `fact-unrelated-08` | 咖啡机维护 | 咖啡机的水箱需要在早上补满。 | The coffee machine's water tank needs refilling in the morning. | zh + en | 合成样本：背景事实（咖啡机维护），synthetic | approved | 长期有效（与用户核心记忆无关） |
| `fact-unrelated-09` | 宠物用品采购 | 猫粮快用完了，宠物用品店今天营业。 | The cat food is almost out, and the pet store is open today. | zh + en | 合成样本：背景事实（宠物用品），synthetic | approved | 长期有效（与用户核心记忆无关） |
| `fact-unrelated-10` | 文件归档 | 桌面上的文件需要按日期分类。 | The files on the desktop need to be sorted by date. | zh + en | 合成样本：背景事实（文件整理），synthetic | approved | 长期有效（与用户核心记忆无关） |

## strata 方向核对（任务 B）

对照 `docs/fork/MEMORY-EVALUATION.md` 的定义（第 16–21 行）逐组核对
`MEMORY_RETRIEVAL_EVALUATION_CASES` 中查询的**实际语言**。方向语义：
en-to-zh = 英文查询对中文事实；zh-to-en = 中文查询对英文事实。

| stratum（fixture 名） | 文档定义 | 实际查询语言 | 结论 |
| --- | --- | --- | --- |
| `short-zh` | 短中文查询 | 全中文 | 一致 |
| `long-zh` | 长中文转述 | 全中文 | 一致 |
| `en-to-zh` | 英文查询对中文事实 | 全英文 | 一致 |
| `zh-to-en` | 中文查询对英文事实 | **全中文** | 一致 |
| `negation` | 否定句 | 全中文 | 一致 |
| `multi-fact` | 多事实长文本 | 全中文 | 一致 |
| `temporal` | 时间变化事实 | 全中文 | 一致 |
| `unrelated-long` | 无关长文本 | 全中文 | 一致 |
| `near-miss` | 相似但错误的事实 | 全中文 | 一致 |

结论：9 组方向一致。2026-09-07 已将 `zh-to-en` 的 10 条查询改为中文，保留其对英文事实的
跨语言评估意图，并新增 memory-core 回归测试锁定该契约。

## 待人工裁决的疑点

1. fact-id 双语方案：20 个 id 是否最终存为两条记录（zh + en）还是一个可派生双语字段，
   涉及 `fact-unrelated-*` 等背景事实是否也需双语。本批仅补内容，最终方案由 MQ-0 决定。
