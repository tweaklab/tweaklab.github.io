---
title: "timeout이 발생했는데 작업은 성공했다면?"
description: "timeout 이후에도 상태 변경 작업이 계속될 때 늦은 성공과 중복 요청을 어떻게 다뤄야 하는지 정리합니다."
publishedAt: 2026-11-03
heroImage: "/images/posts/timeout-late-success/hero.webp"
heroAlt: "timeout 알람이 울린 뒤에도 작업이 계속 진행되어 뒤늦게 성공 상태에 도착하는 모습"
tags: [Java, CompletableFuture, Timeout, Idempotency]
draft: false
---

이전 글에서는 `CompletableFuture`에 timeout을 적용해도 실제 작업은 계속 실행될 수 있다는 내용을 살펴봤습니다.

조회 작업이라면 늦게 받은 결과를 사용하지 않고 버릴 수 있습니다. 하지만 데이터베이스를 수정하거나 외부 시스템에 상태 변경을 요청하는 작업이라면 조금 더 복잡해집니다.

```java
CompletableFuture<Void> future =
    CompletableFuture.runAsync(() -> paymentClient.pay(orderId));

future.orTimeout(1, TimeUnit.SECONDS)
    .join();
```

1초 안에 응답을 받지 못하면 `TimeoutException`이 발생합니다. 호출자는 실패했다고 생각하고 같은 요청을 다시 보낼 수 있습니다.

그런데 첫 번째 작업이 실제로는 계속 실행되고 있었다면 어떻게 될까요?

```text
0초  첫 번째 요청 시작
1초  timeout 응답
2초  같은 요청 재시도
3초  첫 번째 요청 성공
4초  재시도 요청도 성공
```

timeout은 발생했지만 작업은 두 번 성공했습니다.

이번 글에서는 timeout 이후의 늦은 성공을 어떻게 다뤄야 하는지 알아보겠습니다.

## timeout 뒤에 남은 작업

`orTimeout()`은 지정한 시간 안에 결과가 없으면 `CompletableFuture`에서 `TimeoutException`을 발생시킵니다.

```java
CompletableFuture<Void> future =
    CompletableFuture.runAsync(() -> {
        sleep(3_000);
        updateDatabase();
    }).orTimeout(1, TimeUnit.SECONDS);
```

이 코드는 다음과 같이 실행될 수 있습니다.

```text
0초  작업 시작
1초  Future에서 TimeoutException 발생
3초  updateDatabase() 실행
```

1초에 끝난 것은 Future를 기다리던 흐름입니다. `updateDatabase()`를 실행하는 작업 스레드는 별도로 중단되지 않았습니다.

`CompletableFuture.cancel(true)`도 실행 중인 람다를 interrupt로 멈춰준다고 기대하기 어렵습니다. `CompletableFuture` 구현에서는 `mayInterruptIfRunning` 값으로 작업 실행을 제어하지 않습니다.

따라서 Future의 상태만 보고 실제 작업의 성공이나 실패를 확정할 수 없습니다.

## 실패가 아니라 결과 미확인

timeout을 다음처럼 해석하기 쉽습니다.

```text
timeout = 작업 실패
```

하지만 상태를 변경하는 작업에서는 다음 표현이 더 정확합니다.

```text
timeout = 정해진 시간 안에 결과를 확인하지 못함
```

작업이 실패했을 수도 있습니다. 아직 실행 중일 수도 있고, 실제 상태 변경은 끝났지만 응답만 늦게 도착했을 수도 있습니다.

```text
요청 결과 미확인
├─ 실제 작업 실패
├─ 아직 처리 중
└─ 작업은 성공했지만 응답이 늦음
```

이 세 가지 상태를 구분하지 않은 채 바로 `FAILED`로 바꾸면 늦게 도착한 성공과 충돌합니다. 곧바로 재시도하면 같은 작업이 두 번 실행될 수도 있습니다.

## 그렇다면 상태는 어떻게 둘까?

작업 상태를 `PROCESSING`, `SUCCEEDED`, `FAILED`로 관리한다고 가정해보겠습니다.

```text
PROCESSING
    │
    ├─ 성공 확인 → SUCCEEDED
    ├─ 실패 확인 → FAILED
    └─ timeout   → PROCESSING 유지 또는 UNKNOWN
```

timeout만으로는 실패를 확인하지 못했으므로 `FAILED`로 바로 바꾸지 않습니다. 작업의 성격에 따라 `PROCESSING`을 유지하거나 결과를 확인하지 못했다는 의미의 `UNKNOWN` 상태로 둡니다.

그다음 실제 작업 상태를 다시 확인합니다.

```text
timeout 발생
    ↓
실제 상태 조회
    ├─ 성공 확인 → SUCCEEDED
    ├─ 실패 확인 → FAILED
    └─ 여전히 불명확 → 일정 시간 뒤 다시 확인
```

외부 시스템이 작업 조회 API를 제공한다면 처음 요청에서 받은 작업 ID로 상태를 확인할 수 있습니다.

```text
POST /operations
→ 202 Accepted
→ operationId: op-123

GET /operations/op-123
→ PROCESSING | SUCCEEDED | FAILED
```

모든 작업을 이런 비동기 API로 만들 필요는 없습니다. 다만 처리가 오래 걸릴 수 있고 중복 실행의 영향이 크다면 요청 접수와 처리 결과 확인을 분리하는 방식도 검토할 수 있습니다.

## 같은 요청이 다시 들어온다면?

클라이언트는 timeout이 발생하면 재시도할 수 있습니다. 네트워크 연결이 끊겨 응답을 받지 못한 경우도 마찬가지입니다.

이때 같은 요청이 여러 번 실행돼도 결과가 한 번 실행한 것과 같도록 만들어야 합니다. 이를 멱등성이라고 합니다.

상태 변경 요청에 멱등성 키를 함께 보낼 수 있습니다.

```http
POST /payments
Idempotency-Key: payment-order-123
```

서버는 같은 키로 들어온 요청을 새로운 작업으로 만들지 않고 기존 처리 상태나 결과를 반환합니다.

```text
첫 요청
payment-order-123 → 새 작업 생성

재시도
payment-order-123 → 기존 작업 상태 반환
```

이렇게 하면 첫 번째 요청이 늦게 성공한 뒤 재시도가 도착해도 같은 작업을 다시 실행하지 않을 수 있습니다.

## 조회하고 저장하면 충분할까?

멱등성 키를 먼저 조회한 뒤 없으면 저장하는 코드를 생각해볼 수 있습니다.

```java
if (!repository.existsByIdempotencyKey(key)) {
    repository.save(new Request(key));
    execute();
}
```

하지만 두 요청이 거의 동시에 들어오면 둘 다 키가 없다고 판단할 수 있습니다.

```text
요청 A  키 조회 → 없음
요청 B  키 조회 → 없음
요청 A  작업 생성
요청 B  작업 생성
```

애플리케이션의 사전 조회만으로는 동시 요청을 막을 수 없습니다. 데이터베이스의 Unique Constraint처럼 한 요청만 성공할 수 있는 원자적인 제약이 함께 필요합니다.

```sql
CREATE UNIQUE INDEX uk_request_idempotency_key
ON requests (idempotency_key);
```

두 요청이 동시에 저장을 시도해도 하나만 성공합니다. 나머지 요청은 중복 키를 확인한 뒤 기존 작업 상태를 조회합니다.

멱등성 키가 있다고 모든 문제가 해결되는 것은 아닙니다. 키를 얼마나 오래 보관할지, 같은 키에 서로 다른 요청 본문이 들어오면 어떻게 처리할지, 처리 중인 요청에는 어떤 응답을 반환할지도 정해야 합니다.

## 상태가 충돌한다면?

작업 상태를 바꾸는 쿼리에도 현재 상태를 조건으로 넣을 수 있습니다.

```sql
UPDATE operations
SET status = 'SUCCEEDED'
WHERE id = :operationId
  AND status = 'PROCESSING';
```

현재 상태가 `PROCESSING`일 때만 성공으로 바꿉니다. 이미 다른 흐름에서 상태를 변경했다면 영향을 받은 행이 없습니다.

이 경우 성공했다고 가정하지 않고 현재 상태를 다시 조회합니다.

```text
UPDATE 결과 1건 → 상태 변경 성공
UPDATE 결과 0건 → 현재 상태 재조회
```

조건부 갱신은 늦게 도착한 작업과 timeout 후속 처리가 같은 상태를 서로 덮어쓰는 상황을 줄여줍니다.

## 하지만 작업 자체는 언제 끝날까?

Future timeout은 호출자가 기다리는 시간을 제한합니다. 실제 HTTP 요청이나 데이터베이스 쿼리가 실행되는 시간은 별도로 제한해야 합니다.

```text
CompletableFuture timeout
└─ 결과를 얼마나 기다릴지 제한

HTTP·DB timeout
└─ 실제 I/O 작업이 얼마나 실행될지 제한
```

Java HTTP Client를 사용한다면 요청에도 timeout을 설정할 수 있습니다.

```java
HttpRequest request = HttpRequest.newBuilder()
    .uri(uri)
    .timeout(Duration.ofSeconds(1))
    .build();
```

데이터베이스 작업도 Query Timeout, Transaction Timeout, Connection Timeout을 목적에 맞게 설정해야 합니다.

실제 작업의 timeout을 설정해도 이미 외부 시스템에서 처리한 상태 변경까지 되돌려주지는 않습니다. 그래서 작업 시간 제한과 멱등성은 서로 대체하는 기능이 아닙니다.

## 느린 작업이 계속 쌓인다면?

timeout 이후에도 작업이 계속 실행되면 재시도할 때마다 작업 수가 늘어날 수 있습니다.

```text
첫 요청 timeout → 기존 작업 계속 실행
재시도 timeout   → 두 작업 모두 계속 실행
다시 재시도     → 세 번째 작업 추가
```

이런 상황에서는 작업을 실행하는 Executor의 크기와 대기열을 제한해야 합니다.

```java
ExecutorService executor = new ThreadPoolExecutor(
    10,
    10,
    0L,
    TimeUnit.MILLISECONDS,
    new ArrayBlockingQueue<>(100),
    new ThreadPoolExecutor.AbortPolicy()
);
```

제한된 Executor가 기존 작업을 종료해주는 것은 아닙니다. 느린 작업이 시스템 전체에 제한 없이 쌓이지 않도록 장애 범위를 나누는 역할을 합니다.

재시도 횟수에도 제한이 필요합니다. 모든 요청이 같은 간격으로 동시에 재시도하지 않도록 Backoff와 Jitter를 함께 고려할 수 있습니다.

## timeout 뒤에서 확인할 것

상태를 변경하는 작업에서 timeout이 발생했다면 다음 순서로 생각해볼 수 있습니다.

```text
timeout 발생
    ↓
실제 작업이 끝났는지 확인
    ↓
실패가 확인되지 않았다면 FAILED로 확정하지 않음
    ↓
같은 요청의 재실행을 멱등성 키로 방지
    ↓
조건부 갱신으로 상태 충돌 방지
    ↓
실제 I/O timeout과 제한된 Executor로 작업 누적 방지
```

timeout은 응답 시간을 제한하는 데 필요합니다. 하지만 timeout 자체가 작업의 실패를 증명하지는 않습니다.

특히 데이터베이스 수정이나 외부 상태 변경이 포함된 요청이라면 늦은 성공을 정상적인 가능성으로 다뤄야 합니다. 작업 상태를 다시 확인할 수 있어야 하고, 같은 요청이 다시 들어와도 한 번만 처리되도록 보호해야 합니다.

## 참고 자료

- [CompletableFuture (Java API)](https://docs.oracle.com/en/java/javase/11/docs/api/java.base/java/util/concurrent/CompletableFuture.html)
- [RFC 9110 - Idempotent Methods](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)
