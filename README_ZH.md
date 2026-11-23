# 🧠 Open Detector —— 学术论文AI检测器

<div align="center">

![License](https://img.shields.io/badge/License-MIT-blue.svg)
![Python](https://img.shields.io/badge/Python-3.11-green.svg)
![PyTorch](https://img.shields.io/badge/PyTorch-2.15_CPU-orange.svg)
![Hugging Face](https://img.shields.io/badge/HuggingFace-2_models-yellow.svg)

**Language / 语言**: [English](README_EN.md) | [中文](README_ZH.md)

</div>

> 🖥️ **新增本地 Web 应用与双模型对比 / Local web application and dual-model comparison added.** 本仓库新增了一个完全在本机运行的 Web 界面（八个模块：仪表盘、检测工作室、文档分析、批量分析、历史记录、统计分析、报告中心、模型信息，另有一个双模型对比页 `#/dual`），可对同一文本同时运行 **Followsci BERT** 与 **Fakespot RoBERTa** 两个独立检测器。安装、运行方式、评估数据与已知局限请见 [README.md](README.md)、[README_EN.md](README_EN.md#️-open-detector-web-application-final-year-academic-prototype) 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。AI 文本检测只是概率性信号，不能证明作者身份，请勿作为处分的唯一依据；本检测器**不能可靠地识别所有 AI 生成的文本**。

**Open Detector**是一个 BERT 二分类模型，用于识别学术论文更接近**人类写作**还是**AI写作风格**。它可作为 Turnitin 等高昂商业检测器的**开放替代方案**，适合学生、个人科研者、本地部署用户。

![Demo](images/demo.png)

## 🧪 双模型检测（Followsci BERT + Fakespot RoBERTa）

| | Followsci BERT | Fakespot RoBERTa |
|---|---|---|
| Hugging Face 标识 | `followsci/bert-ai-text-detector` | `fakespot-ai/roberta-base-ai-text-detection-v1` |
| 基础模型 / 参数量 | `bert-base-uncased`，1.095 亿 | `roberta-base`，1.246 亿 |
| 许可证（模型卡） | MIT | Apache-2.0 |
| 使用范围 | 整个应用（行为保持不变） | 仅双模型对比页及其 API |
| 加载方式 | 服务启动时加载；首次使用时自动下载 | 首次双模型请求时加载，**只从本地缓存读取** |

* 两个模型对**完全相同**的文本，经由现有的 `analyze_document` 评分，段落一一对应。
* **每个模型使用各自独立的阈值，独立给出判断。不对概率取平均，也不给出“综合结论”。** 页面只标注一致或分歧（逐段与整篇）：*两者均为 AI*、*两者均为人类*、*两者均不确定*、*一方不确定*、*分歧*。
* 任一模型加载或运行失败时，只在其自己的区块显示错误，另一模型的结果照常返回。
* 双模型结果不会保存到历史记录。检测工作室、历史、批量分析、统计与报告仍只使用 Followsci。
* **Fakespot 不会被应用自动下载。** 请在联网时先缓存一次：`.\.venv\Scripts\hf.exe download fakespot-ai/roberta-base-ai-text-detection-v1`；若未缓存，双模型页只会提示该模型出错，其余功能不受影响。
* **阈值**由 `evaluation/dual_eval.py` 在验证集上分别为每个模型选定，并在独立的测试集上测量（保存于 `detector/thresholds.json`）：*AI* = 验证集误报率不超过 5% 的最低分；*人类* = 仍能保留至少 95% 验证集 AI 文本的最高分；两者之间为“不确定”。

| 模型 | P(AI) 低于此值判为“更可能是人类” | P(AI) 不低于此值判为“更可能是 AI” | 测试集中“不确定”的比例 |
|---|---|---|---|
| Followsci BERT | 0.000002128 | 0.9927 | 71.0% |
| Fakespot RoBERTa | 0.4333 | 0.9941 | 18.6% |

对 Followsci，页面还会显示现有应用对同一文本给出的结论（区间 0.35 / 0.65），它可能与按验证阈值得到的结论不同。

内存与缓存（开发机实测，仅 CPU）：服务进程仅加载 Followsci 时约 0.83 GB，两个模型都加载时约 1.4 GB；Hugging Face 缓存约 418 MB（Followsci）+ 481 MB（Fakespot）。

### 实测结果（正类 = AI）

**1. 公开基准（非目标领域）HC3 + MAGE，测试集 n = 1,653，各模型使用各自的验证阈值**（`evaluation/results/dual_report.md`）：

| 模型 | 准确率 | 精确率 | 召回率 | F1 | AUROC | 误报率 | 漏报率 |
|---|---|---|---|---|---|---|---|
| Followsci BERT | 65.5% | 90.3% | 34.7% | 50.2% | 78.1% | 3.7% | 65.3% |
| Fakespot RoBERTa | 90.7% | 94.8% | 86.1% | 90.2% | 95.8% | 4.7% | 13.9% |

**2. 领域内数据集：236 条教育/技术文本**（人类 118、AI 118；简明英语、正式、技术、对话四种风格），按主题划分为训练 116 / 验证 46 / **测试 74**，另有 56 篇人机混合文档。人类文本均来自 2022-06-01 之前（Simple English / English Wikipedia 历史版本、CPython 文档、Stack Exchange 回答）；AI 文本全部由同一个助手（Claude）针对相同主题撰写。详见 [evaluation/indomain/README.md](evaluation/indomain/README.md)。测试集（人类 37、AI 37；95% 置信区间约宽 10–20 个百分点）：

| 模型与工作点 | 准确率 | 精确率 | 召回率 | F1 | AUROC | 误报率 |
|---|---|---|---|---|---|---|
| Followsci，默认 0.5 | 63.5% | 91.7% | 29.7% | 44.9% | 65.9% | 2.7% |
| Followsci，第一阶段阈值 | 62.2% | 90.9% | 27.0% | 41.7% | 65.9% | 2.7% |
| Fakespot，默认 0.5 | 62.2% | 58.2% | 86.5% | 69.6% | 78.4% | 62.2% |
| Fakespot，第一阶段阈值 | 71.6% | 83.3% | 54.1% | 65.6% | 78.4% | 10.8% |
| Fakespot，在领域内验证集上重选阈值 | 66.2% | 100% | 32.4% | 49.0% | 78.4% | 0.0% |

按风格（全部 236 条，第一阶段阈值），AUROC / 召回率：Followsci 正式 95.8% / 72.2%、简明英语 59.3% / 2.8%、对话 59.4% / 0.0%、技术 52.8% / 4.8%；Fakespot 正式 93.4% / 86.1%、简明英语 86.9% / 72.2%、对话 77.1% / 32.0%、技术 53.5% / 4.8%。

### ⚠️ 已知弱点（均为实测，不是假设）

* **简明英语、对话和技术类文本是薄弱环节**：Followsci 对这些风格的 AI 文本几乎召回为零；Fakespot 召回更多，但在默认阈值下会把大量人类文本误判为 AI（人类的 Simple English Wikipedia 文本有 75% 被误判）。两个模型在技术类文本上都接近随机。正式、百科式文本处理较好。
* **人机混合文档**：使用第一阶段阈值时，56 篇混合文档中，Followsci 没有一篇被判为“更可能是 AI”，Fakespot 为 2 篇。逐段标记比整篇结论更有参考价值。
* 仓库中的学习指南 PDF 样例（据项目称为 AI 撰写，未经独立验证）：Followsci 为 0.1%，Fakespot 为 19.3%，两者都没有标记为 AI。
* 未测量：改写/“人性化”处理过的 AI 文本、非英语母语者与学生写作、其他 AI 生成器。领域内数据的 AI 文本来自单一生成器，样本量较小。

### 🗺️ 路线图（计划中，尚未实现）

扩充领域内数据集（更多 AI 生成器、真实学生写作、改写文本）；仅在此之后才考虑微调（目前**没有**产出或使用任何微调模型）；决定双模型页如何呈现 Followsci 的结论；保持各文档同步。

## 🌐 在线体验与全文检测平台（XYZ SCIENCE）

我们已将学术 AIGC 检测模型与去 AI 痕迹学术改写模型全面升级为一站式在线平台 —— **[XYZ SCIENCE（学术论文 AIGC 检测与降 AI 率平台）](https://www.xyzscience.com/)**：

- 🔍 **[免费中英文论文 AIGC 检测](https://www.xyzscience.com/detection)**：登录后不限次数完全免费使用，支持段落粘贴与上传 Word（`.docx`）文档进行全文 AI 率检测，提供逐句 AI 特征概率高亮标注及 PDF 详细检测报告下载（检测标准对标知网、维普、Turnitin 等主流系统）。
- ✍️ **[免费论文降 AI 率与学术改写](https://www.xyzscience.com/rewrite)**：基于 700 万+ 篇中英文纯学术论文语料自研训练的专用改写模型（非通用大模型套壳提示词），支持中文标准、中文强力及英文模式，在完整保留原文语义、专业术语与学术严谨风格的基础上精准消除 AI 写作痕迹。
- 🚀 **[模型技术架构介绍](https://www.xyzscience.com/features)** & **[企业级 API 与高校私有化部署](https://www.xyzscience.com/enterprise)**：支持标准 RESTful API 接入与机构本地化部署。
---

## 🧩 背景与立场

### 💡 为什么做这个项目？

Turnitin 等商用学术检测服务价格昂贵，对学生、研究者和自费科研人员不够友好。**论文检测应当透明、公平、可解释，而不是商业黑箱**。所以我们开放模型，为社区提供透明、低成本方案。

### ⚠️ 对 AI 文本检测的哲学立场

AI 的使命是提高效率，而不是让人回到手写时代。

AI 写作在词汇选择、句法结构、逻辑连贯性上远超大部分人类写作者。

❌ **"写得像 AI" ≠ 学术不端。**

学术诚信不应依靠语言风格裁决，而应该回到内容真实性。

仅凭风格判断论文质量非常荒谬。

我们真正应该关注的不是"你有没有用 AI"，而是内容是否真实、可靠、没有虚假生成。

换句话说：**我们应该检测的是 AI 幻觉，而不是 AI 写作。**

⚠️ **注意**：本项目目前仅属于**风格检测（stylometric detection）**，未来目标是构建学术内容真实性检测与AI幻觉识别体系。

---

## 🤖 模型介绍

### ✨ 特性

使用约140万条数据进行训练

- **高准确率**：在学术文本检测上达到 99.57% 的准确率和 99.58% 的 F1 分数
- **低误报率**：仅 0.82% 的误报率，最大程度减少错误指控
- **极高召回率**：99.94% 的召回率确保AI生成内容很少被遗漏
- **专为学术文本优化**：专门针对学术写作模式进行优化
- **基于BERT架构**：基于 BERT-base-uncased 构建，具有强大的语义理解能力

---

## 🎯 性能指标

<img src="images/fig1_performance_comparison.png" width="600" alt="性能对比">

<img src="images/fig2_confusion_matrix.png" width="500" alt="混淆矩阵">

> ℹ️ **关于上图。** 这些数字是上游模型作者在其未公开的领域内测试集上的自报结果，本仓库**未能复现**。我们在其他数据上的实测结果（见上文“双模型检测”）要低得多。

---

## 🚀 快速开始

模型文件已保存到 [https://huggingface.co/followsci/bert-ai-text-detector](https://huggingface.co/followsci/bert-ai-text-detector)

### 安装

```bash
pip install transformers torch
```

### 运行

```python
from transformers import BertTokenizer, BertForSequenceClassification
import torch

model_name = "followsci/bert-ai-text-detector"
tokenizer = BertTokenizer.from_pretrained(model_name)
model = BertForSequenceClassification.from_pretrained(model_name)
model.eval()

text = "Your academic paragraph here..."
inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=512)

with torch.no_grad():
    outputs = model(**inputs)
    probs = torch.nn.functional.softmax(outputs.logits, dim=-1)
    ai_prob = probs[0][1].item() * 100
    human_prob = probs[0][0].item() * 100
    
    print(f"AI生成概率: {ai_prob:.1f}% | 人类写作概率: {human_prob:.1f}%")
```

### 参数说明

- **标签**：`0 = 人类`, `1 = AI`
- **最大长度**：512 tokens

---

## 🚧 我们正在做的事

### 研究方向

| 未来方向 | 说明 |
|---------|------|
| 事实一致性验证 | 引用链检查、文献检索对比 |
| AI 幻觉检测 | 重点区分真实 vs 虚构内容 |
| 引用真实性 | 防止"假引用"与"模型编造文献" |
| 学术逻辑一致性 | 结构与推理校验 |
| 扩展到多语言 | 支持中文、日文等多语言检测 |

### 最终目标

构建"AI辅助真实学术"的检测框架，而不是"反AI写作"工具。

---

## ✨ 关于人性化改写模型

我们还训练了一个学术论文人性化改写模型：

- 保持学术表达风格
- 消除 AI 写作痕迹
- 避免被风格检测误判

📌 该模型可以通过网站 [https://www.xyzscience.com/](https://www.xyzscience.com/) 免费使用。

---

## 📌 最后

> **AI 不应成为被审判者，而应成为支持知识创造的工具。**  
> **我们的目标不是惩罚 AI，而是保护学术真实。**

感谢阅读。欢迎 Star ⭐ 支持开放学术工具生态。

---

> 💡 **提示**：该模型目前仅支持英文，体验中文功能可以访问 [https://www.xyzscience.com/](https://www.xyzscience.com/)

