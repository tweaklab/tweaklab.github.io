---
title: "UNASSIGNED 샤드는 왜 다시 할당되지 않을까?"
description: "UNASSIGNED 샤드를 찾고 Allocation Explain 응답에서 현재 할당을 막는 조건을 확인하는 순서를 정리합니다."
publishedAt: 2026-11-06
heroImage: "/images/posts/elasticsearch-unassigned-diagnosis/hero.webp"
heroAlt: "배치되지 않은 샤드에서 세 데이터 노드로 이어지는 경로가 각각 막힌 이유를 돋보기로 살펴보는 모습"
tags: [Elasticsearch, Shard, Cluster]
draft: false
---

[이전 글](https://tweaklab.github.io/blog/elasticsearch-unassigned-shards/)에서는 `UNASSIGNED`가 샤드 복사본을 어떤 Data Node에도 배치하지 못한 상태라는 내용을 살펴봤습니다.

모든 Primary가 할당된 상태에서 Replica가 하나 이상 `UNASSIGNED`이면 클러스터는 `YELLOW`가 됩니다. Primary가 하나라도 `UNASSIGNED`이면 해당 샤드의 데이터에 접근할 수 없으므로 `RED`가 됩니다.

그런데 노드가 다시 클러스터에 참여하거나 디스크 공간을 확보했는데도 `UNASSIGNED`가 그대로 남는 경우가 있습니다.

원인과 관계없이 노드를 추가해도 Allocation 조건은 그대로 남을 수 있습니다. 정상 복사본을 확인하지 않고 Primary를 강제로 할당하면 데이터가 유실될 수도 있습니다. 먼저 Elasticsearch가 어느 노드에, 어떤 이유로 샤드를 배치하지 않았는지 확인해야 합니다.

## 먼저 상태 확인

클러스터 상태만으로는 어떤 인덱스의 어떤 샤드가 문제인지 알 수 없습니다. `_cat/shards`에서 `UNASSIGNED`인 샤드를 찾습니다.

```http
GET /_cat/shards?v=true&h=index,shard,prirep,state,node,unassigned.reason&s=state
```

설명을 위해 결과를 줄이면 다음과 같습니다.

```text
index     shard prirep state       node unassigned.reason
products  0     p      STARTED     node-a
products  0     r      STARTED     node-b
products  1     p      STARTED     node-a
products  1     r      UNASSIGNED  -    NODE_LEFT
```

확인할 값은 세 가지입니다.

- `index`와 `shard`: Allocation Explain에 전달할 대상입니다.
- `prirep`: `p`는 Primary, `r`은 Replica입니다.
- `unassigned.reason`: 샤드가 마지막으로 `UNASSIGNED` 상태가 된 계기입니다.

위 결과에서는 `products` 인덱스의 shard 1 Replica가 `UNASSIGNED`입니다. 이제 조사할 대상을 하나로 좁혔습니다.

## 그런데 `unassigned.reason`이면 충분할까?

`NODE_LEFT`를 보면 노드가 클러스터에서 이탈해서 샤드가 `UNASSIGNED`가 되었다는 사실은 알 수 있습니다.

하지만 이 값은 샤드 상태가 마지막으로 바뀐 이유입니다. 지금도 샤드를 할당하지 못하는 이유까지 설명하지는 않습니다.

예를 들어 처음에는 노드 이탈로 Replica를 잃었지만, 이후 다음과 같은 조건이 새 할당을 막고 있을 수 있습니다.

- 남은 노드의 디스크 사용량이 기준을 넘었습니다.
- 같은 샤드의 Primary가 있는 노드밖에 남지 않았습니다.
- 인덱스의 Allocation Filter를 만족하는 노드가 없습니다.
- 복구가 반복해서 실패해 재시도 횟수를 넘었습니다.

따라서 `unassigned.reason`은 조사의 출발점으로 사용해야 합니다. 현재 할당을 막는 조건은 Allocation Explain API에서 확인합니다.

## Allocation Explain으로 넘어가면

대상 샤드를 지정해 API를 호출합니다.

```http
POST /_cluster/allocation/explain
{
  "index": "products",
  "shard": 1,
  "primary": false
}
```

`primary`에는 `_cat/shards`의 `prirep` 값을 기준으로 Primary 여부를 넣습니다. `p`라면 `true`, `r`이라면 `false`입니다.

대상을 지정하지 않고 호출하면 Elasticsearch가 임의의 `UNASSIGNED` 샤드를 선택합니다. 여러 샤드가 할당되지 않은 상황에서는 보고 있던 샤드와 다른 결과를 받을 수 있으므로 대상을 명시하는 편이 좋습니다.

응답 구조만 줄이면 다음과 같습니다. `explanation`에 들어가는 문장은 클러스터 상태에 따라 달라집니다.

```json
{
  "index": "products",
  "shard": 1,
  "primary": false,
  "current_state": "unassigned",
  "unassigned_info": {
    "reason": "NODE_LEFT",
    "last_allocation_status": "no"
  },
  "can_allocate": "no",
  "allocate_explanation": "...",
  "node_allocation_decisions": [
    {
      "node_name": "node-b",
      "node_decision": "no",
      "deciders": [
        {
          "decider": "disk_threshold",
          "decision": "NO",
          "explanation": "..."
        }
      ]
    }
  ]
}
```

필드가 많아 보이지만 읽는 순서를 정하면 어렵지 않습니다.

## 응답은 어디부터 읽을까?

먼저 `unassigned_info`를 확인합니다.

```json
"unassigned_info": {
  "reason": "NODE_LEFT",
  "last_allocation_status": "no"
}
```

`reason`은 앞에서 본 `unassigned.reason`과 마찬가지로 샤드가 `UNASSIGNED`가 된 계기입니다. `last_allocation_status`는 마지막 할당 시도의 결과를 보여줍니다.

다음은 `can_allocate`와 `allocate_explanation`입니다.

```json
"can_allocate": "no",
"allocate_explanation": "..."
```

`can_allocate`는 현재 이 샤드를 할당할 수 있는지 요약합니다.

- `yes`: 할당할 수 있습니다.
- `no`: 현재 조건에서는 어느 노드에도 할당할 수 없습니다.
- `throttled`: 복구나 할당 속도 제한 때문에 기다리고 있습니다.
- `allocation_delayed`: 노드가 다시 참여할 가능성을 고려해 할당을 미루고 있습니다.
- `no_valid_shard_copy`: Primary로 사용할 수 있는 정상 샤드 복사본을 찾지 못했습니다.

마지막으로 `node_allocation_decisions`를 확인합니다. 이 배열에는 각 노드가 샤드를 받을 수 있는지와 그 판단에 참여한 Allocation Decider가 들어 있습니다.

```json
{
  "node_name": "node-b",
  "node_decision": "no",
  "deciders": [
    {
      "decider": "disk_threshold",
      "decision": "NO",
      "explanation": "..."
    }
  ]
}
```

여기서 `decision`이 `NO`인 항목을 먼저 봅니다. 해당 노드에 샤드를 배치하지 않은 구체적인 조건을 찾을 수 있습니다.

## 같은 `NO`라도 이유는 다르다

Allocation Explain에서 자주 확인하는 단서를 정리하면 다음과 같습니다.

| 결과 또는 Decider | 확인할 내용 | 조치 방향 |
| --- | --- | --- |
| `same_shard` | 같은 번호의 Primary 또는 다른 Replica가 이미 해당 노드에 있는가? | 샤드를 받을 수 있는 다른 노드를 확보하거나 의도한 Replica 수인지 다시 확인합니다. |
| `disk_threshold` | 노드의 디스크 사용량이 Allocation 기준을 넘었는가? | 불필요한 데이터를 정리하거나 용량을 확보합니다. 다른 노드도 샤드를 받을 공간이 있는지 함께 확인합니다. |
| `filter` 또는 `data_tier` | 인덱스가 요구하는 노드 속성과 Tier를 만족하는가? | `index.routing.allocation.*`, Data Tier와 노드 역할을 확인합니다. |
| `max_retry` | 복구 실패가 반복되어 재시도를 멈췄는가? | 복구 실패의 원인을 먼저 고친 뒤 `retry_failed`로 다시 시도합니다. |
| `no_valid_shard_copy` | 사용할 수 있는 정상 Primary 또는 Replica 복사본이 있는가? | 이탈한 노드의 복귀 가능성과 Snapshot을 먼저 확인합니다. |

예를 들어 `same_shard`가 `NO`라면 서버 자원이 부족하다는 뜻이 아닙니다. 같은 샤드의 Primary와 Replica를 한 노드에 배치하지 않는 규칙 때문에 거절한 것입니다.

반대로 `disk_threshold`가 `NO`라면 노드 수를 늘리지 않고 기존 노드의 디스크 공간을 확보하는 방식으로 해결할 수도 있습니다. 어떤 조치가 필요한지는 Decider가 거절한 이유에 따라 달라집니다.

## 일단 재시도하면 될까?

할당이 여러 번 실패하면 `max_retry`가 더 이상의 시도를 막을 수 있습니다. 원인을 해결했다면 다음 요청으로 실패한 샤드의 할당을 한 번 다시 시도할 수 있습니다.

```http
POST /_cluster/reroute?retry_failed=true
```

하지만 이 요청은 앞선 실패 원인을 고치지 않습니다. 디스크 공간이나 Allocation 설정이 그대로라면 다시 같은 이유로 실패합니다.

`retry_failed`는 `allocate_stale_primary`나 `allocate_empty_primary`와도 다릅니다. 전자는 실패했던 할당을 다시 시도합니다. 후자의 두 명령은 정상 샤드 복사본이 없을 때 Primary를 강제로 할당하는 명령입니다.

`allocate_stale_primary`와 `allocate_empty_primary`에는 `accept_data_loss: true`가 필요합니다. 빈 Primary를 할당하면 해당 샤드의 기존 데이터를 잃습니다. 원래 데이터를 가진 노드가 나중에 돌아와도 그 노드의 샤드 데이터가 삭제될 수 있습니다. 오래된 복사본을 Primary로 강제 할당한 경우에도 나중에 돌아온 정상 복사본의 데이터가 덮어써질 수 있습니다.

따라서 Primary가 `no_valid_shard_copy` 상태라면 강제 할당부터 실행해서는 안 됩니다. 먼저 다음 순서로 복구 가능성을 확인해야 합니다.

```text
정상 샤드 복사본이 있는 노드 확인
    ↓
이탈한 노드의 복귀 가능성 확인
    ↓
Snapshot 또는 원본 데이터 확인
    ↓
복구할 수 없을 때만 데이터 손실을 전제로 판단
```

## 원인을 고친 다음

설정이나 자원을 수정한 뒤에는 샤드 상태가 실제로 바뀌는지 확인합니다.

```http
GET /_cluster/health?filter_path=status,unassigned_shards,initializing_shards
```

```http
GET /_cat/shards?v=true&h=index,shard,prirep,state,node,unassigned.reason&s=state
```

정상적으로 할당을 시작했다면 샤드는 다음 순서로 바뀝니다.

```text
UNASSIGNED → INITIALIZING → STARTED
```

`UNASSIGNED` 수만 줄었는지 확인하고 끝내지 않습니다. 대상 샤드가 `INITIALIZING`을 거쳐 `STARTED`가 되었는지, 필요한 Replica 수까지 확보되어 클러스터 상태가 의도한 수준으로 돌아왔는지 함께 확인해야 합니다.

## 정리

- `_cat/shards`에서 `UNASSIGNED`인 인덱스, 샤드 번호와 Primary 여부를 확인합니다.
- `unassigned.reason`은 샤드가 `UNASSIGNED`가 된 계기이며, 현재 할당을 막는 이유는 아닙니다.
- Allocation Explain의 `can_allocate`, `allocate_explanation`, `node_allocation_decisions`를 순서대로 확인합니다.
- `decision: NO`를 반환한 Decider에 따라 디스크, 노드 수, Allocation Filter와 샤드 복사본을 점검합니다.
- 실패 원인을 고친 뒤에만 `retry_failed`를 사용합니다.
- 강제 Primary 할당은 데이터 손실 가능성을 확인한 뒤 마지막 수단으로 판단해야 합니다.

## 참고 자료

- [Cat shards API - Elastic Docs](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-cat-shards)
- [Cluster allocation explain API - Elastic Docs](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-cluster-allocation-explain)
- [Diagnose unassigned shards - Elastic Docs](https://www.elastic.co/docs/troubleshoot/elasticsearch/diagnose-unassigned-shards)
- [Cluster reroute API - Elastic Docs](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-cluster-reroute)
- [Cluster-level shard allocation settings - Elastic Docs](https://www.elastic.co/docs/reference/elasticsearch/configuration-reference/cluster-level-shard-allocation-routing-settings)
