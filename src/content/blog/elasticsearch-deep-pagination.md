---
title: "Elasticsearch에서 뒤쪽 페이지로 갈수록 검색이 느려지는 이유"
description: "from과 size가 깊은 페이지에서 처리해야 하는 결과가 늘어나는 이유와 search_after, PIT의 선택 기준을 정리합니다."
publishedAt: 2026-11-02
heroImage: "/images/posts/elasticsearch-deep-pagination/hero.webp"
heroAlt: "쌓인 검색 결과를 건너뛰는 방식과 마지막 정렬값에서 다음 결과로 이동하는 방식을 비교한 그림"
tags: [Elasticsearch, Pagination, Search]
draft: false
---

검색 결과를 페이지로 나눌 때 가장 먼저 떠올리는 방식은 `from`과 `size`입니다.

```json
GET products/_search
{
  "from": 0,
  "size": 20,
  "query": {
    "match": {
      "name": "keyboard"
    }
  }
}
```

첫 번째 페이지에서는 20건을 가져오고, 두 번째 페이지에서는 앞의 20건을 건너뜁니다.

```json
{
  "from": 20,
  "size": 20
}
```

구현도 단순하고 페이지 번호를 계산하기도 쉽습니다. 검색 결과가 많지 않다면 이 방식만으로 충분합니다.

그런데 사용자가 뒤쪽 페이지로 계속 이동하면 이야기가 달라집니다.

```json
{
  "from": 10000,
  "size": 20
}
```

응답에는 여전히 20건만 필요합니다. 그런데 Elasticsearch가 처리해야 하는 결과도 20건일까요?

오늘은 `from/size`가 깊은 페이지에서 부담을 만드는 이유와 `search_after`, PIT를 어떤 경우에 사용해야 하는지 알아보겠습니다.

## `from/size`와 Deep Pagination

RDB의 Offset 페이지네이션처럼 `from`은 앞에서 건너뛸 검색 결과 수를 뜻합니다. `size`는 실제로 반환할 결과 수입니다.

```json
GET products/_search
{
  "from": 40,
  "size": 20,
  "query": {
    "match_all": {}
  },
  "sort": [
    { "createdAt": "desc" },
    { "productId": "asc" }
  ]
}
```

이 요청은 정렬된 결과에서 앞의 40건을 건너뛰고 20건을 반환합니다.

문제는 Elasticsearch의 검색이 여러 Shard에 걸쳐 실행될 수 있다는 점입니다. 각 Shard는 자신이 가진 문서 중 최종 결과에 들어갈 가능성이 있는 후보를 찾습니다. Coordinating Node는 Shard에서 받은 후보를 모아 다시 정렬하고, 그중 요청한 구간만 반환합니다.

```text
각 Shard에서 후보 수집
        ↓
Coordinating Node에서 병합하고 정렬
        ↓
앞의 from건을 제외
        ↓
size건 반환
```

`from`이 10,000이고 `size`가 20이라면 앞의 결과를 건너뛰기 위해 더 많은 후보를 다뤄야 합니다. 응답은 20건이지만 검색 과정에서는 이전 페이지에 해당하는 결과도 필요합니다.

페이지가 깊어질수록 다음 비용이 커질 수 있습니다.

- 각 Shard가 수집하고 정렬하는 후보 수
- Shard 결과를 병합하는 데 사용하는 CPU와 메모리
- Shard와 Coordinating Node 사이에서 전달하는 데이터

Elasticsearch는 이런 부담을 막기 위해 `from + size`를 기본적으로 10,000건까지 허용합니다. 이 범위는 `index.max_result_window`로 바꿀 수 있지만, 제한을 높인다고 처리 비용까지 없어지지는 않습니다.

```text
index.max_result_window를 높인다
≠
깊은 페이지 조회가 저렴해진다
```

단순히 제한값부터 높이기보다 사용자가 정말 500페이지로 바로 이동해야 하는지 확인하는 편이 먼저입니다.

## 그래도 `from/size`가 필요한 경우

`from/size`를 사용하면 안 된다는 뜻은 아닙니다.

검색 범위가 작고 사용자가 특정 페이지로 바로 이동해야 한다면 `from/size`가 가장 단순합니다. 예를 들어 최대 100건만 보여주거나 첫 몇 페이지만 제공하는 화면이라면 Deep Pagination의 부담도 제한할 수 있습니다.

```text
1  2  3  4  5
```

페이지 번호를 클릭해 원하는 구간으로 이동하는 UI도 `from/size`와 잘 맞습니다. `from`만 계산하면 해당 구간을 바로 요청할 수 있기 때문입니다.

반면 수만 건의 결과를 `더 보기`나 무한 스크롤로 계속 내려가야 한다면 앞의 결과를 반복해서 건너뛰는 방식이 어울리지 않습니다. 이때는 `search_after`를 사용할 수 있습니다.

## 하지만 `search_after`라면 어떨까?

![수많은 검색 결과 카드에 맞서 후드를 입은 개발자 옥토끼가 Cursor로 다음 결과를 가리키는 4컷 그림](/images/posts/elasticsearch-deep-pagination/search-after-parody.webp)

`search_after`는 이전 페이지의 마지막 문서가 가진 정렬값을 다음 요청의 시작점으로 사용합니다. Offset을 계산하는 대신 Cursor를 넘기는 방식에 가깝습니다.

먼저 첫 페이지를 조회합니다.

```json
GET products/_search
{
  "size": 20,
  "query": {
    "match": {
      "name": "keyboard"
    }
  },
  "sort": [
    { "createdAt": "desc" },
    { "productId": "asc" }
  ]
}
```

정렬 조건을 지정하면 각 Hit의 `sort`에 실제 정렬값이 포함됩니다.

```json
{
  "_source": {
    "productId": 1832,
    "createdAt": "2026-10-31T10:15:30.000Z"
  },
  "sort": [
    1793441730000,
    1832
  ]
}
```

다음 페이지를 가져올 때는 마지막 Hit의 `sort` 배열을 그대로 `search_after`에 전달합니다.

```json
GET products/_search
{
  "size": 20,
  "query": {
    "match": {
      "name": "keyboard"
    }
  },
  "search_after": [1793441730000, 1832],
  "sort": [
    { "createdAt": "desc" },
    { "productId": "asc" }
  ]
}
```

Elasticsearch는 처음부터 몇 건을 버릴지 계산하지 않고 해당 정렬값 다음의 결과를 조회합니다. 그래서 깊은 결과를 순서대로 탐색하는 데 적합합니다.

다만 `search_after`를 사용할 때는 첫 요청과 다음 요청의 `query`와 `sort`가 같아야 합니다. 정렬 기준이 달라지면 이전 요청에서 받은 Cursor를 해석할 기준도 달라집니다.

## Cursor를 위한 정렬 기준

`createdAt`이 같은 문서가 여러 개라면 어떻게 될까요?

```json
"sort": [
  { "createdAt": "desc" }
]
```

이 조건만으로는 같은 시간에 생성된 문서의 순서를 결정할 수 없습니다. Replica마다 Lucene의 내부 문서 ID가 다를 수 있어서 페이지를 넘기는 동안 같은 정렬값을 가진 문서의 순서가 달라질 수도 있습니다.

그래서 문서마다 고유한 값을 Tie-breaker로 추가해야 합니다.

Tie-breaker는 앞의 정렬 조건이 같을 때 문서의 최종 순서를 결정하는 보조 정렬값입니다.

```json
"sort": [
  { "createdAt": "desc" },
  { "productId": "asc" }
]
```

`createdAt`이 같아도 `productId`로 최종 순서를 결정할 수 있습니다.

여기서 `_id`를 그대로 정렬값으로 사용하면 된다고 생각할 수 있습니다. 하지만 `_id`는 정렬에 필요한 `doc_values`를 지원하지 않습니다. 정렬에 사용할 고유 ID를 별도 필드에 저장하거나 `_id` 값을 `doc_values`가 활성화된 필드로 복사해두는 방식이 필요합니다.

## 정렬값이 바뀐다면?

고유한 Tie-breaker를 추가하면 같은 정렬값 때문에 순서가 흔들리는 문제를 막을 수 있습니다. 그렇다고 모든 중복과 누락이 사라지는 것은 아닙니다.

첫 페이지를 조회한 뒤 새 문서가 추가되거나 기존 문서의 정렬값이 바뀔 수 있습니다.

```text
첫 페이지 조회
        ↓
문서 추가 또는 정렬값 변경
        ↓
이전 페이지의 Cursor로 다음 페이지 조회
```

두 번째 요청은 변경된 인덱스를 검색하지만 Cursor는 첫 번째 요청의 결과에서 가져왔습니다. 두 요청 사이에 문서 순서가 달라지면 일부 문서가 다시 나타나거나 보이지 않을 수 있습니다.

이 문제는 `search_after`가 오래된 데이터를 조회해서 생기는 것이 아닙니다. 최신 상태에서 검색하더라도 이전 정렬값이 같은 위치를 계속 가리킨다는 보장이 없어서 발생합니다.

페이지를 넘기는 동안 같은 시점의 검색 결과를 유지해야 한다면 PIT를 함께 사용해야 합니다.

## 같은 시점을 바라보는 PIT

PIT는 Point In Time의 약자입니다. PIT를 열면 여러 검색 요청에서 특정 시점의 인덱스 상태를 기준으로 결과를 조회할 수 있습니다.

먼저 PIT를 생성합니다.

```http
POST /products/_pit?keep_alive=1m
```

응답으로 받은 PIT ID를 검색 요청에 넣습니다. PIT를 사용할 때는 요청 경로에 Index 이름을 넣지 않습니다.

```json
GET /_search
{
  "size": 20,
  "pit": {
    "id": "PIT_ID",
    "keep_alive": "1m"
  },
  "query": {
    "match": {
      "name": "keyboard"
    }
  },
  "sort": [
    { "createdAt": "desc" }
  ]
}
```

PIT 검색에는 `_shard_doc`이라는 Tie-breaker가 자동으로 추가됩니다. 응답에 포함된 마지막 Hit의 `sort` 배열에는 이 값도 들어갑니다. 다음 요청의 `search_after`에는 일부 값만 골라 넣지 말고 전체 배열을 그대로 전달해야 합니다.

```json
GET /_search
{
  "size": 20,
  "pit": {
    "id": "LATEST_PIT_ID",
    "keep_alive": "1m"
  },
  "query": {
    "match": {
      "name": "keyboard"
    }
  },
  "search_after": [1793441730000, 4294967298],
  "sort": [
    { "createdAt": "desc" }
  ],
  "track_total_hits": false
}
```

검색 응답에서 새로운 PIT ID를 반환할 수 있으므로 다음 요청에는 가장 최근에 받은 ID를 사용합니다.

PIT를 사용하면 탐색을 시작한 시점 이후의 변경은 현재 페이지네이션에 반영되지 않습니다. 최신성을 잠시 미루는 대신 페이지 사이의 기준 시점을 맞추는 방식입니다.

사용이 끝난 PIT는 명시적으로 닫는 편이 좋습니다.

```json
DELETE /_pit
{
  "id": "LATEST_PIT_ID"
}
```

PIT를 오래 유지하면 이전 Segment를 보존해야 하므로 디스크와 File Handle 같은 자원을 사용합니다. `keep_alive`는 전체 조회가 끝날 때까지 넉넉하게 잡는 시간이 아니라, 다음 요청을 처리하는 데 필요한 시간만큼 갱신하는 값으로 보는 편이 좋습니다.

## 페이지 크기와 전체 결과 수

화면에 전체 검색 결과 수를 표시하기 위해 `track_total_hits`를 사용하는 경우도 있습니다.

```json
{
  "size": 20,
  "track_total_hits": true
}
```

`size`는 응답으로 받을 문서 수이고, `track_total_hits`는 Query에 일치하는 문서 수를 어디까지 정확하게 셀지 정합니다. 둘은 서로 다른 설정입니다.

정확한 전체 건수가 필요하지 않은 무한 스크롤이라면 `track_total_hits: false`로 계산을 줄일 수 있습니다. 다음 페이지의 존재 여부만 필요하다면 화면에 보여줄 수보다 1건 더 요청하는 방법도 있습니다.

20건을 보여주는 화면이라면 21건을 조회하고, 21번째 문서가 있는지만 확인합니다. 응답에는 앞의 20건만 전달합니다. 이때 다음 Cursor는 확인용으로 가져온 21번째 문서가 아니라 사용자에게 실제로 전달한 20번째 문서의 `sort` 값으로 만들어야 합니다.

```text
20건 표시 + 1건 확인
        ↓
21번째 문서가 있으면 hasNext = true
        ↓
다음 Cursor는 20번째 문서의 sort
```

## Scroll은 어디에 쓰는가?

Scroll API도 많은 문서를 순서대로 가져올 수 있습니다. 하지만 현재 Elasticsearch 공식 문서에서는 Deep Pagination에 Scroll을 권장하지 않습니다. 10,000건보다 많은 결과를 같은 인덱스 상태에서 탐색해야 한다면 PIT와 `search_after` 사용을 권장합니다.

Scroll은 실시간 사용자 요청보다 Reindex, Export, 배치처럼 많은 데이터를 처리하는 작업에 가깝습니다. 서버에서 Search Context를 유지해야 하므로 일반적인 검색 화면의 다음 페이지 기능으로 선택할 이유가 적습니다.

## 화면에서 시작하는 선택

페이지네이션 방식은 검색 결과 수만 보고 정하기 어렵습니다. 사용자가 결과를 어떻게 이동하는지도 함께 봐야 합니다.

| 요구사항 | 선택할 수 있는 방식 |
| --- | --- |
| 얕은 범위에서 페이지 번호로 바로 이동 | `from/size` |
| 결과를 다음 방향으로 계속 탐색 | `search_after` |
| 데이터가 바뀌어도 같은 시점의 결과를 탐색 | PIT + `search_after` |
| 대량 데이터를 처리하거나 옮기는 작업 | Scroll 또는 목적에 맞는 배치 방식 |

`search_after`는 100페이지로 바로 이동할 수 없습니다. 99페이지의 마지막 정렬값을 모르면 100페이지의 시작점도 알 수 없기 때문입니다. 반대로 `from/size`는 특정 페이지로 이동하기 쉽지만, 이동할 수 있는 범위를 크게 열수록 뒤쪽 페이지의 처리 비용이 커집니다.

결국 중요한 것은 페이지 번호가 필요한지, 다음 결과만 있으면 되는지, 페이지를 넘기는 동안 같은 검색 시점을 유지해야 하는지입니다.

`index.max_result_window`에 막혔을 때 제한부터 높이면 당장의 오류는 사라질 수 있습니다. 하지만 검색 과정에서 앞의 결과를 처리한 뒤 버리는 구조는 그대로 남습니다.

뒤쪽 페이지가 필요해졌다면 설정값보다 먼저 화면의 이동 방식을 다시 살펴봐야 합니다. 페이지 번호가 꼭 필요하지 않다면 마지막 정렬값을 이어가는 방식이 더 자연스러울 수 있습니다.

## 참고 자료

- [Paginate search results](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results)
- [The search API - Track total hits](https://www.elastic.co/docs/solutions/search/the-search-api#track-total-hits)
