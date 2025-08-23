<h1 align="center">
  <strong>CaptiPrep - AI 기반 언어 학습 어시스턴트</strong>
</h1>

<p align="center">
  <a href="https://github.com/jeanchristophe13v/CaptiPrep">
    <img src="icon.png?raw=true" alt="CaptiPrep 아이콘" width="250" />
  </a>
</p>

<p align="center">
 <a href="README.md">English</a> | <a href="README.zh_CN.md">简体中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.ja.md">日本語</a> | <b>한국어</b> | <a href="README.ru.md">Русский</a>
</p>

<p align="center"><em>YouTube 자막에서 먼저 핵심 어휘를 익히고, 그다음 영상으로 맥락 학습을 강화하세요.</em></p>

**CaptiPrep = Caption + Preparation.** 자막이 있는 영상을 ‘사전 준비 세션’으로 전환하여 핵심 단어·표현을 먼저 익히고, 본편을 시청하며 자연스럽게 기억을 고착화합니다. 부담은 낮추고 유지율은 높입니다.

## 🤔 주요 기능
### 1｜자막 자동 캡처 & 유용한 단어/구 추출.
### 2｜AI 1차 필터 + 수동 선택 → 플래시카드 자동 생성.
### 3｜Wordbook: 학습한 단어·영상 누적 관리 / 복습 / 내보내기.
### 4｜다국어 의미 설정: 원하는 조합(학습언어 × 설명언어)으로 유연 학습.

## ⚙️ 사용 방법
1. Chrome / Edge 스토어 설치 또는 개발자 모드에서 로컬 로드.
2. (예: 영어) 자막 포함 YouTube 영상 열고 확장 아이콘 클릭.
3. 흐름: 추출 → 선택 → 카드 생성 → 학습 (방향키: 이동 / Space: 즐겨찾기).
4. 우측 메뉴에서 Wordbook 열어 언제든 복습.
5. Export 기능으로 단어 모음 다운로드.
6. 추천 모델: 필터링 gemini-2.5-flash-lite / 카드 생성 gemini-2.5-flash.

## ❓ 효과 이유
- 사전 노출로 시청 부담 완화.
- 문맥 예문이 실제 영상 기반 → 기억 강화.
- 누적 단어장을 통한 반복 & 간격 학습 최적화.

## 🧾 로드맵
- [x] 다국어 UI & i18n.
- [ ] 프롬프트 사용자 정의.
- [ ] 카드 정보 확장(연어/패턴 등).

참고: API 키 및 모델(OpenAI, Claude, Gemini 등)은 옵션 페이지에서 설정되며 로컬 저장.

## ❤️ 감사
자막 추출 참고 프로젝트:
https://github.com/devhims/youtube-caption-extractor
