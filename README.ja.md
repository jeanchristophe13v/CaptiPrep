<h1 align="center">
  <strong>CaptiPrep - AI がサポートする語学学習アシスタント</strong>
</h1>

<p align="center">
  <a href="https://github.com/jeanchristophe13v/CaptiPrep">
    <img src="icon.png?raw=true" alt="CaptiPrep アイコン" width="250" />
  </a>
</p>

<p align="center">
 <a href="README.md">English</a> | <a href="README.zh_CN.md">简体中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <b>日本語</b> | <a href="README.ko.md">한국어</a> | <a href="README.ru.md">Русский</a>
</p>

<p align="center"><em>YouTube の字幕から重要語を事前キャッチ。理解の地盤をつくってから動画を観る新しい学習フロー。</em></p>

**CaptiPrep = Caption + Preparation.** 字幕付き YouTube 動画を「予習素材」に変換し、語彙と表現を先に定着→本編視聴→文脈でさらに記憶を強化。負荷を下げつつ“刺さる”学習体験を提供します。

## 🤔 主な機能
### 1｜字幕の自動取得 & 候補語/フレーズ抽出。
### 2｜AI による一次フィルタ + 手動調整でフラッシュカード自動生成。
### 3｜Wordbook（単語帳）: 学習済み語と動画のログを一元管理し、再学習 & エクスポート。
### 4｜多言語訳設定: 学びたい言語 × 説明したい言語を柔軟に組み合わせ可能。

## ⚙️ 使い方
1. Chrome / Edge ストアから導入、または開発者モードでローカル読み込み。
2. 字幕（例: 英語）つき動画を開き拡張機能アイコンをクリック。
3. フロー: 抽出 → 語を選ぶ → カード生成 → 学習（矢印キー: 切替 / スペース: お気に入り）。
4. 右側メニューから単語帳を開いて復習。
5. エクスポートで語彙データを出力。
6. 推奨モデル: フィルタ gemini-2.5-flash-lite / カード gemini-2.5-flash。

## ❓ 定着しやすい理由
- 予習で“初見負荷”を軽減。
- 例は当該動画の文脈そのもの。
- ログ蓄積で継続的な復習サイクルを回せる。

## 🧾 今後の予定
- [x] 多言語 UI / i18n。
- [ ] プロンプトのカスタム設定。
- [ ] カード拡張（コロケーション等）。

備考: API キー & モデル設定（OpenAI / Claude / Gemini など互換）はオプションページでローカル保存。

## ❤️ 謝辞
字幕抽出部分で参考にしたプロジェクト:
https://github.com/devhims/youtube-caption-extractor
