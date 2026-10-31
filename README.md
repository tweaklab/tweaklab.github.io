# TweakLab Technical Blog

`https://tweaklab.github.io`에 배포되는 정적 기술 블로그입니다.

## 로컬 실행

```bash
npm install
npm run dev
```

## 공개 전 확인

```bash
npm run check
npm run build
```

공개 금지 단어가 있다면 저장소 밖의 `../drafts/.private-terms`에 한 줄에 하나씩 적습니다. `npm run privacy:check`는 이메일·전화번호·개인 메타데이터와 해당 차단어를 검사하되 차단어 자체는 출력하지 않습니다.

`main` 브랜치에 push하면 GitHub Actions가 사이트를 빌드해 GitHub Pages에 배포합니다.
비공개 초안은 이 저장소가 아니라 `../drafts`에서 관리합니다.

## 글 작성

공개가 승인된 글만 `src/content/blog`에 추가합니다.

```yaml
---
title: "글 제목"
description: "검색과 목록에 표시할 한 줄 설명"
publishedAt: 2026-10-31
updatedAt: 2026-10-31
heroImage: "/images/posts/example/hero.webp"
heroAlt: "대표 이미지 대체 텍스트"
tags: [Java, Backend]
draft: false
---
```

대표 이미지는 `public/images/posts/<slug>/`에 둡니다.

## 광고

AdSense 승인 뒤 GitHub Actions의 Variables에 다음 값을 등록합니다.

- `PUBLIC_ADSENSE_CLIENT`: `ca-pub-...`
- `PUBLIC_ADSENSE_SLOT_ARTICLE`: 본문 광고 슬롯 ID

그다음 `public/ads.txt`를 실제 발급값으로 교체합니다.
