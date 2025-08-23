<h1 align="center">
  <strong>CaptiPrep - Your AI-Powered Language Learning Assistant</strong>
</h1>

<p align="center">
  <a href="https://github.com/jeanchristophe13v/CaptiPrep"> 
    <img src="icon.png?raw=true" alt="CaptiPrep Icon" title="CaptiPrep Icon" width="250">
  </a>
</p>


**CaptiPrep = Caption + Preparation。** 它的目标是“看 YouTube 以学习语言”。在看视频之前，先用 CaptiPrep 从字幕中预习单词与表达；完成学习后再观看视频，借助上下文进行强化记忆。这样的 Contextual learning（基于上下文情境的学习）能事半功倍，让学习变得有趣且“无痛”。

## 🤔 能做什么？
### 1｜自动获取字幕：自动从 YouTube 字幕提取关键词/短语
### 2｜智能筛选 & 生成闪卡：让 AI 进行初筛，再在面板中进行手动筛选后自动生成学习卡片，开始学习吧～
<img width="1822" height="1097" alt="image" src="https://github.com/user-attachments/assets/40df55a5-6a7d-4668-b3ad-35d4ba56eec2" />

---

<img width="1822" height="1097" alt="image" src="https://github.com/user-attachments/assets/85b6a8c2-7fd3-4854-b901-47a962b9ddef" />

---

### 3｜单词本：记录所有学过的视频与单词，便于课后复习与导出。
<img width="1822" height="1097" alt="image" src="https://github.com/user-attachments/assets/2dd28b21-6630-4158-9614-ae99ea08e875" />

---
<img width="1822" height="1097" alt="image" src="https://github.com/user-attachments/assets/3db82e90-0ec4-4886-be25-4bbb7b5de356" />

---
### 4｜可设置释义语言，多语言支持，各个国家的人都可以学习各个国家的语言！

<img width="1822" height="1180" alt="Chinese(traditional)" src="https://github.com/user-attachments/assets/543fa9d7-024c-4619-bb55-cec191606b34" />
<img width="1822" height="1180" alt="Chinese(simplified)" src="https://github.com/user-attachments/assets/d14eb772-8679-44e6-9c90-9376567bea4b" />
<img width="1822" height="1180" alt="英语" src="https://github.com/user-attachments/assets/074c2f62-1c93-43d6-b9ee-ceb86a307e3c" />
<img width="1822" height="1180" alt="西班牙语" src="https://github.com/user-attachments/assets/a259136a-9f58-4c0f-9474-c34a7d557940" />
<img width="1822" height="1180" alt="日语" src="https://github.com/user-attachments/assets/4d028322-914a-4171-8a2a-e3d1193cfac7" />
<img width="1822" height="1180" alt="韩语" src="https://github.com/user-attachments/assets/3c51cafe-34c7-4243-8670-5f87be6407fc" />
<img width="1822" height="1180" alt="法语" src="https://github.com/user-attachments/assets/acc893fc-b00c-4d16-ac1a-18e22f5bba96" />
<img width="1822" height="1180" alt="俄语" src="https://github.com/user-attachments/assets/dff198e4-8a04-4282-ad61-7cb0e29a519b" />
<img width="1822" height="1180" alt="德语" src="https://github.com/user-attachments/assets/9ab5b61e-a4c5-4cc8-93ce-a8da446a43c8" />




---

## ⚙️ 使用方法
1. 安装：
chrome 插件商店：https://chromewebstore.google.com/detail/captiprep/jgbcfnmpjaflngdajjjnlehfkfohlmfl?authuser=0
edge 扩展商店：https://microsoftedge.microsoft.com/addons/detail/captiprep/fbfhhgelelmeopkjdihhklkcncbikjem
开发：Chrome → `chrome://extensions` → 打开“开发者模式” → “加载已解压的扩展程序” → 选择本仓库目录。（请先 git clone https://github.com/jeanchristophe13v/CaptiPrep.git）

2. 打开任意带英文字幕的 YouTube 视频，点击扩展图标。
3. 在浮层面板：提取字幕 → 选择要学的词/短语 → 生成卡片 → 学习。**点击小键盘的左右可以切换单词卡，点击空格可以收藏该单词。**
4. 点击右侧入口打开“单词本”，随时回顾已学内容。
5. 点击导出按钮，可将单词打包导出。
6. **模型选择**：请注意，推荐将筛选模型设置为 gemini-2.5-flash-lite，将制卡模型设置为 gemini-2.5-flash。

## ❓ 为什么有效
- 先学再看：提前掌握词汇与表达，视频理解更顺畅。
- 强上下文：例句来自你要看的视频，记忆更牢固。
- 可持续：单词本集中沉淀，复习与迁移更高效。

## 🧾 规划与展望
- [x] 后续将加入多语种支持与 i18n，各国用户都能学习任意语言。敬请期待。
- [ ] 加入提示词自定义
- [ ] 优化单词卡片，提供单词的固定搭配
  
提示：API Key 与模型等设置在“选项页”中配置，并存储在本地。目前支持 OpenAI, Claude, Gemini 和 OpenAI Compatible 的供应商。

## ❤️ 致谢
如果不是这个项目，我将无法做到提取 youtube 字幕，感谢🙏

I wouldn’t have been able to extract YouTube subtitles without this project. Thank you 🙏

https://github.com/devhims/youtube-caption-extractor
