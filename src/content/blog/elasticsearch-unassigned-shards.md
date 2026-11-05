---
title: "UNASSIGNED 샤드, 데이터는 어디에 있을까?"
description: "Elasticsearch의 UNASSIGNED 상태가 무엇을 뜻하는지, Primary와 Replica에 따라 데이터의 상태를 어떻게 해석해야 하는지 정리합니다."
publishedAt: 2026-11-05
heroImage: "/images/posts/elasticsearch-unassigned-shards/hero.webp"
heroAlt: "세 개의 데이터 노드 바깥에 아직 어느 노드에도 배치되지 않은 샤드 하나가 놓인 모습"
tags: [Elasticsearch, Shard, Cluster]
draft: false
---

Elasticsearch의 클러스터 상태를 확인했는데 `YELLOW` 또는 `RED`가 표시되는 경우가 있습니다.

```json
{
  "cluster_name": "search-cluster",
  "status": "yellow",
  "unassigned_shards": 1
}
```

샤드 상태를 확인하면 `UNASSIGNED`라는 값도 함께 보입니다.

```text
index     shard prirep state
products  0     p      STARTED
products  0     r      UNASSIGNED
```

`UNASSIGNED`라는 이름만 보면 샤드의 데이터가 사라진 것처럼 보입니다. 하지만 이 값만으로 데이터 유실 여부를 판단할 수는 없습니다.

그렇다면 `UNASSIGNED`는 정확히 무엇을 뜻할까요? 그리고 해당 샤드의 데이터는 어디에 있을까요?

## `UNASSIGNED`는 무엇이 비어 있다는 뜻일까?

Elasticsearch는 하나의 인덱스를 여러 샤드로 나누고, 각 샤드를 Data Node에 배치합니다.

`UNASSIGNED`는 클러스터가 필요로 하는 샤드 복사본을 현재 어떤 Data Node에도 배치하지 못한 상태입니다. 데이터가 들어갈 빈 공간이나 별도의 대기 장소를 가리키는 말은 아닙니다.

```text
P0 → Node A
R0 → UNASSIGNED
```

위 상태에서는 샤드 0의 Primary인 `P0`는 Node A에 배치되어 있습니다. 하지만 Replica인 `R0`를 담당하는 노드는 아직 없습니다.

여기서 중요한 것은 `UNASSIGNED`가 원인이 아니라 상태라는 점입니다. 노드가 부족할 수도 있고, 샤드를 배치할 조건을 만족하는 노드가 없을 수도 있습니다. 어떤 이유로 배치되지 않았는지는 별도로 확인해야 합니다.

## 먼저 Primary와 Replica

같은 번호를 가진 Primary와 Replica는 같은 데이터를 보관하는 샤드 복사본입니다.

```text
P0 ─── 복제 관계 ─── R0
```

Primary는 데이터 변경을 먼저 처리하는 샤드 복사본입니다. 검색 요청은 Primary와 Replica 모두 처리할 수 있습니다. Replica는 Primary의 데이터를 복제하고 있다가 Primary를 사용할 수 없을 때 새로운 Primary로 승격될 수 있습니다.

Elasticsearch는 같은 샤드의 Primary와 Replica를 같은 노드에 배치하지 않습니다. 한 노드에 두 복사본을 함께 두면 해당 노드가 사라졌을 때 두 복사본을 모두 잃기 때문입니다.

따라서 `UNASSIGNED`를 발견했다면 먼저 해당 샤드가 Primary인지 Replica인지 구분해야 합니다.

## Replica가 `UNASSIGNED`라면?

Data Node가 하나인데 Replica를 1개로 설정한 인덱스를 생각해보겠습니다.

```text
Node A
------
P0

R0 → UNASSIGNED
```

`R0`를 배치할 두 번째 노드가 없으므로 Replica는 `UNASSIGNED`로 남습니다. 그래도 같은 데이터를 가진 Primary인 `P0`가 동작하고 있으므로 해당 샤드의 데이터는 조회하고 색인할 수 있습니다.

이 경우 클러스터 상태는 `YELLOW`입니다.

```text
Primary  → 모두 할당됨
Replica  → 하나 이상 UNASSIGNED
상태     → YELLOW
```

나중에 배치 가능한 Node B가 추가되면 Elasticsearch는 `P0`의 데이터를 복제해 `R0`를 만듭니다.

```text
Node A                  Node B
------                  ------
P0 ─── 데이터 복제 ───→ R0
                        INITIALIZING
                             ↓
                          STARTED
```

즉 Replica가 `UNASSIGNED`라는 말은 `R0`라는 데이터 묶음이 어딘가에서 노드를 기다리고 있다는 뜻이 아닙니다. 활성 Primary를 원본으로 삼아 Replica를 다시 만들 수 있지만, 현재는 그 복사본을 담당할 노드가 없다는 뜻입니다.

## 그런데 Primary라면?

Primary가 `UNASSIGNED`라면 상황이 달라집니다.

```text
P0 → UNASSIGNED
```

Primary가 할당되지 않은 샤드의 데이터에는 접근할 수 없습니다. 하나 이상의 Primary가 `UNASSIGNED`이면 클러스터 상태는 `RED`가 됩니다.

하지만 `RED`라고 해서 Elasticsearch 전체가 멈췄다는 뜻은 아닙니다. 정상적으로 할당된 다른 샤드는 계속 요청을 처리할 수 있습니다. `UNASSIGNED`인 Primary가 담당하던 일부 데이터에 접근할 수 없는 상태에 가깝습니다.

Primary가 있던 노드가 사라져도 정상 Replica가 남아 있다면 Elasticsearch는 Replica를 새로운 Primary로 승격할 수 있습니다.

```text
Node A 장애          Node B
------------         ------
P0 사용 불가          R0
                      │
                      ▼ 승격
                      P0
```

승격할 Replica가 없다면 Primary는 계속 `UNASSIGNED`로 남을 수 있습니다. 이때는 원래 노드가 다시 참여할 수 있는지, 사용할 수 있는 다른 샤드 복사본이 있는지 확인해야 합니다.

## 그렇다면 데이터는 어디에 있을까?

`UNASSIGNED` 상태만 보고 데이터의 위치를 하나로 단정할 수는 없습니다.

| 상황 | 데이터 또는 복구 원본 |
| --- | --- |
| Replica만 `UNASSIGNED` | 활성 Primary에 같은 데이터가 있음 |
| Primary 노드가 이탈하고 정상 Replica가 남음 | Replica를 Primary로 승격할 수 있음 |
| 노드가 일시적으로 클러스터에서 이탈함 | 이탈한 노드의 디스크에 데이터가 남아 있을 수 있음 |
| 클러스터에 정상 복사본이 없음 | Snapshot이나 원본 데이터로 복구할 수 있는지 확인해야 함 |
| 정상 복사본과 복구 수단이 모두 없음 | 데이터가 실제로 유실되었을 수 있음 |

Snapshot이 있더라도 `UNASSIGNED` 샤드에 자동으로 연결되는 것은 아닙니다. Snapshot Restore를 통해 데이터를 복원해야 합니다.

결국 확인해야 할 것은 `UNASSIGNED`라는 단어가 아니라 정상적인 샤드 복사본과 복구 원본이 남아 있는지입니다.

## `YELLOW`와 `RED`를 다시 보면

클러스터 상태는 Primary와 Replica의 할당 상태를 요약합니다.

| 상태 | Primary | Replica | 의미 |
| --- | --- | --- | --- |
| `GREEN` | 모두 할당됨 | 모두 할당됨 | 필요한 모든 샤드 복사본이 동작함 |
| `YELLOW` | 모두 할당됨 | 하나 이상 `UNASSIGNED` | 데이터에는 접근할 수 있지만 요구한 복제 수준을 충족하지 못함 |
| `RED` | 하나 이상 `UNASSIGNED` | 무관 | 일부 데이터에 접근할 수 없음 |

이 상태는 CPU나 Heap 사용률, 검색 속도를 나타내지 않습니다. 검색이 느리거나 노드의 자원이 부족해도 모든 샤드가 할당되어 있다면 클러스터 상태는 `GREEN`일 수 있습니다.

반대로 `YELLOW` 상태에서 현재 요청이 정상적으로 처리되더라도 안심할 수는 없습니다. Replica가 부족하므로 다른 노드까지 장애가 발생하면 데이터를 사용할 수 없는 범위가 생길 수 있습니다.

## 그런데 왜 할당되지 않았을까?

`UNASSIGNED`는 샤드 복사본을 담당하는 노드가 없다는 상태만 보여줍니다. 노드 수가 부족한지, 디스크 사용량이 기준을 넘었는지, Allocation 설정을 만족하지 못했는지는 알려주지 않습니다.

따라서 다음 단계에서는 어떤 샤드가 `UNASSIGNED`인지 찾고, Elasticsearch가 각 노드에 샤드를 배치하지 않은 이유를 확인해야 합니다.

이 내용은 다음 글에서 `_cat/shards`와 `_cluster/allocation/explain`을 중심으로 살펴보겠습니다.

## 정리

- `UNASSIGNED`는 필요한 샤드 복사본이 현재 어떤 Data Node에도 배치되지 않은 상태입니다.
- Replica가 `UNASSIGNED`이면 Primary를 통해 데이터에 접근할 수 있지만 요구한 복제 수준은 충족하지 못합니다.
- Primary가 `UNASSIGNED`이면 해당 샤드가 담당하는 데이터에 접근할 수 없습니다.
- `UNASSIGNED`만으로 데이터가 남아 있는지 또는 유실되었는지 판단할 수 없습니다.
- 정상 샤드 복사본, 이탈한 노드의 데이터와 Snapshot 등 복구 원본을 따로 확인해야 합니다.

## 참고 자료

- [Red or yellow cluster health status - Elastic Docs](https://www.elastic.co/docs/troubleshoot/elasticsearch/red-yellow-cluster-status)
- [Shard allocation, relocation, and recovery - Elastic Docs](https://www.elastic.co/docs/deploy-manage/distributed-architecture/shard-allocation-relocation-recovery)
- [Cluster health API - Elastic Docs](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-cluster-health)
