---
title: "CompletableFuture에 timeout을 걸었는데 작업은 왜 계속될까?"
description: "CompletableFuture에 timeout을 적용했을 때 결과를 기다리는 코드는 어떻게 끝나고, 실제 작업은 왜 계속 실행되는지 정리합니다."
publishedAt: 2026-10-31
heroImage: "/images/posts/completablefuture-timeout/hero-cartoon.webp"
heroAlt: "알람 시계에서 이어진 선은 끊기고 기어와 컨베이어는 계속 움직이는 모습"
tags: [Java, CompletableFuture, Concurrency, Timeout]
draft: false
---

외부 API를 호출하거나 데이터베이스에서 데이터를 조회할 때, 작업이 언제나 예상한 시간 안에 끝난다는 보장은 없습니다.

평소에는 100ms 안에 끝나던 외부 API가 어느 날 몇 초 동안 응답하지 않을 수도 있고, 데이터베이스의 특정 쿼리가 락이나 부하 때문에 평소보다 오래 걸릴 수도 있습니다. 이때 아무런 제한 없이 결과를 기다리면 요청을 처리하던 스레드와 커넥션 같은 자원도 함께 묶이게 됩니다.

그래서 비동기 작업에 timeout을 적용합니다.

```java
CompletableFuture<String> future =
    CompletableFuture.supplyAsync(() -> externalClient.call());

String result = future.get(1, TimeUnit.SECONDS);
```

코드만 보면 꽤 자연스럽습니다. 외부 API 호출을 비동기로 실행하고, 최대 1초까지만 결과를 기다립니다.

그런데 여기서 한 가지 궁금한 점이 생깁니다.

1초가 지나 `TimeoutException`이 발생하면 `externalClient.call()`도 함께 종료될까요?

직관적으로는 그럴 것 같지만, 실제로는 그렇지 않습니다. 결과를 기다리던 코드는 다음 로직으로 넘어가지만, 비동기 작업은 여전히 다른 스레드에서 실행되고 있을 수 있습니다.

오늘은 `CompletableFuture`의 timeout이 정확히 무엇을 끝내는지 알아보겠습니다.

## CompletableFuture는 작업 스레드가 아닙니다

먼저 `CompletableFuture`가 무엇을 표현하는지부터 살펴보겠습니다.

```java
CompletableFuture<String> future =
    CompletableFuture.supplyAsync(() -> slowOperation());
```

이 코드에는 서로 다른 두 가지 대상이 있습니다.

첫 번째는 `slowOperation()`을 실행하는 실제 작업입니다. 별도의 `Executor`를 전달하지 않았다면 일반적으로 `ForkJoinPool.commonPool()`의 작업 스레드에서 실행됩니다.

두 번째는 `CompletableFuture<String>`입니다. 이 객체에는 비동기 작업의 결과나 예외, 취소 여부가 담깁니다.

```text
작업 스레드
└── slowOperation() 실행

CompletableFuture
└── 결과, 예외, 취소 여부 저장
```

둘은 연결되어 있지만 같은 대상은 아닙니다.

작업이 값을 반환하면 그 결과가 `CompletableFuture`에 저장됩니다. 작업이 예외를 던지면 Future에도 해당 예외가 기록됩니다. 그러면 `get()`이나 `join()`으로 결과를 기다리던 스레드가 다시 실행됩니다.

반대로 Future에 timeout이 발생하면 실행 중인 작업도 자동으로 종료될까요?

Future가 끝나는 것과 실제 작업이 끝나는 것은 별개의 문제입니다.

## `get(timeout)`은 기다리는 시간만 제한합니다

먼저 `get(timeout)`부터 보겠습니다.

```java
CompletableFuture<String> future =
    CompletableFuture.supplyAsync(() -> slowOperation());

try {
    String result = future.get(1, TimeUnit.SECONDS);
} catch (TimeoutException e) {
    // 1초 안에 결과를 받지 못함
}
```

`get(1, TimeUnit.SECONDS)`은 최대 1초 동안 결과를 기다립니다. 1초 안에 Future가 끝나지 않으면 결과를 기다리던 코드에서 `TimeoutException`이 발생합니다.

여기서 멈춘 것은 실제 작업이 아니라 **`get()`으로 결과를 기다리던 코드**입니다.

```text
결과를 기다리는 스레드
    ↓
최대 1초 동안 대기
    ↓
TimeoutException
    ↓
다음 로직 실행
```

반면 `slowOperation()`을 실행하던 작업 스레드는 계속 동작합니다.

```text
작업 스레드
    ↓
slowOperation() 계속 실행
    ↓
3초 뒤 결과 반환
    ↓
Future에 결과 저장
```

`get(timeout)`에서 timeout이 발생해도 Future에는 아직 아무 결과가 저장되지 않았습니다. 작업이 3초 뒤 끝난다면 그때 Future에 결과가 저장됩니다.

이를 간단한 코드로 확인해보겠습니다.

```java
CompletableFuture<String> future =
    CompletableFuture.supplyAsync(() -> {
        sleep(3_000);
        System.out.println("작업 완료");
        return "result";
    });

try {
    future.get(1, TimeUnit.SECONDS);
} catch (TimeoutException e) {
    System.out.println("기다리기 종료");
}

sleep(3_000);
System.out.println(future.join());
```

실행 흐름은 다음과 비슷합니다.

```text
기다리기 종료
작업 완료
result
```

`get()`은 1초 뒤 `TimeoutException`을 던졌지만, 작업은 3초까지 실행됐습니다. 이후 같은 Future에서 작업 결과도 가져올 수 있습니다.

## `orTimeout()`은 Exception을 발생시킵니다

Java 9부터는 `orTimeout()`을 사용할 수 있습니다.

```java
CompletableFuture<String> future =
    CompletableFuture.supplyAsync(() -> slowOperation())
        .orTimeout(1, TimeUnit.SECONDS);
```

`orTimeout()`은 지정된 시간 안에 Future가 끝나지 않으면 `TimeoutException` 예외를 발생시켜 Future를 종료합니다.

`get(timeout)`과 비교하면 차이가 있습니다.

```text
get(timeout)
└── get() 호출에서 TimeoutException 발생
└── Future에는 나중에 실제 작업 결과가 저장될 수 있음

orTimeout()
└── Future에서 TimeoutException 발생
└── 이후 실제 작업이 값을 반환해도 결과는 바뀌지 않음
```

그렇다면 `orTimeout()`을 사용하면 실제 작업도 종료될까요?

아닙니다.

Future에서 예외가 발생한 것과 작업 스레드의 코드가 끝난 것은 별개의 일입니다. 작업은 계속 외부 API를 기다리거나 계산을 수행할 수 있습니다. 다만 작업이 나중에 값을 반환하더라도 Future에는 이미 `TimeoutException`이 기록됐기 때문에 결과가 바뀌지 않습니다.

## `completeOnTimeout()`은 fallback 값을 사용합니다

`completeOnTimeout()`도 Java 9부터 사용할 수 있습니다.

```java
CompletableFuture<String> future =
    CompletableFuture.supplyAsync(() -> slowOperation())
        .completeOnTimeout("fallback", 1, TimeUnit.SECONDS);
```

지정된 시간 안에 작업 결과를 받지 못하면 주어진 fallback 값을 Future의 결과로 저장합니다.

```text
1초 안에 작업 완료
└── 실제 작업 결과 반환

1초 안에 작업 미완료
└── "fallback"을 Future의 결과로 사용
```

여기에서도 실제 작업은 자동으로 종료되지 않습니다. Future에는 이미 `fallback`이 기록됐지만, 실행 중이던 작업은 나중에 외부 시스템을 호출하거나 데이터베이스를 변경할 수 있습니다.

세 가지 방식을 한 번에 비교하면 다음과 같습니다.

| 방식 | timeout 시 Future 상태 | 실제 작업 자동 종료 |
| --- | --- | --- |
| `get(timeout)` | 아직 미완료일 수 있음 | 안 됨 |
| `orTimeout()` | `TimeoutException` 발생 | 안 됨 |
| `completeOnTimeout()` | fallback 값을 결과로 사용 | 안 됨 |

세 방식은 동작이 조금씩 다르지만 공통점이 있습니다.

**어느 방식도 실행 중인 작업을 자동으로 강제 종료하지 않습니다.**

## `cancel(true)`를 호출하면 종료될까요?

그렇다면 timeout이 발생했을 때 `cancel(true)`를 호출하면 어떨까요?

```java
future.cancel(true);
```

일반적인 `Future`의 `cancel(true)`는 실행 중인 작업 스레드에 interrupt를 시도할 수 있습니다. 하지만 interrupt 역시 작업을 강제로 제거하는 기능은 아닙니다. 작업 코드와 사용 중인 라이브러리가 interrupt에 반응해야 합니다.

특히 `CompletableFuture`의 `cancel(boolean)`에서 `mayInterruptIfRunning` 값은 실행 제어에 사용되지 않습니다. 공식 문서에서도 이 구현은 interrupt로 작업을 제어하지 않기 때문에 해당 값이 효과가 없다고 설명합니다.

즉 다음 코드는 Future를 취소 상태로 만들 수 있지만, `supplyAsync()`에서 실행 중인 람다를 중단시킨다고 기대해서는 안 됩니다.

```java
CompletableFuture<String> future =
    CompletableFuture.supplyAsync(() -> slowOperation());

future.cancel(true);
```

Future가 취소됐다고 실제 작업까지 멈추는 것은 아닙니다.

## 응답이 끝난 뒤에도 작업은 성공할 수 있습니다

조회 작업이라면 늦게 끝난 결과를 사용하지 않고 버리는 것으로 마무리할 수 있습니다.

하지만 상태를 변경하는 작업이라면 이야기가 달라집니다.

```java
CompletableFuture<Void> future =
    CompletableFuture.runAsync(() -> updateData());

future.orTimeout(1, TimeUnit.SECONDS)
    .join();
```

1초 뒤 timeout 응답을 반환했다고 가정해보겠습니다. 호출자는 작업이 실패했다고 생각하고 같은 요청을 다시 보낼 수 있습니다.

하지만 첫 번째 `updateData()`가 백그라운드에서 계속 실행되고 있었다면 어떻게 될까요?

```text
첫 번째 요청 timeout
    ↓
호출자는 실패했다고 판단
    ↓
동일 요청 재시도
    ↓
첫 번째 작업이 늦게 성공
    ↓
두 번째 작업도 실행
```

timeout은 실제 작업의 실패를 의미하지 않습니다. 단지 정해진 시간 안에 결과를 확인하지 못했다는 의미일 수 있습니다.

그래서 상태를 변경하는 비동기 작업에서는 timeout만 추가하는 것으로 충분하지 않습니다. 중복 요청을 견딜 수 있는 멱등성, 현재 작업 상태를 확인할 수 있는 방법, 늦게 도착한 성공을 추적하는 설계가 함께 필요합니다.

이 부분은 범위가 크기 때문에 다음 글에서 별도로 다뤄보겠습니다.

## 실제 작업의 시간을 제한하려면

Future의 결과를 기다리는 시간만 제한해서는 시스템 자원을 충분히 보호할 수 없습니다.

외부 API 호출이 30초 동안 끝나지 않는다면 호출자가 1초 뒤 응답을 포기해도 작업 스레드와 HTTP 커넥션은 계속 사용되고 있을 수 있습니다. 이런 작업이 반복되면 Executor의 스레드와 대기열이 쌓이고, 결국 다른 정상 요청까지 처리하지 못할 수 있습니다.

실제 작업의 시간을 제한하려면 작업이 수행되는 계층에도 timeout이 필요합니다.

- HTTP 연결 timeout과 응답 timeout
- 데이터베이스 쿼리 timeout
- 소켓 read timeout
- 락 획득 timeout
- 전체 요청 deadline

```text
Future timeout
└── 결과를 얼마나 기다릴지 결정

실제 I/O timeout
└── 외부 작업이 자원을 얼마나 오래 사용할지 제한
```

두 timeout은 같은 역할을 하는 설정이 아닙니다.

작업을 직접 구현하고 있다면 취소에 협조하도록 만들 수도 있습니다.

```java
String process() {
    while (!Thread.currentThread().isInterrupted()) {
        if (isDone()) {
            return createResult();
        }

        doSmallUnitOfWork();
    }

    throw new CancellationException();
}
```

다만 중간에 호출하는 라이브러리와 I/O가 interrupt에 반응하지 않는다면 이 코드만으로 즉시 종료를 보장할 수 없습니다. 결국 실제 네트워크와 데이터베이스 계층의 timeout이 함께 있어야 합니다.

## 전용 Executor도 timeout과 함께 봐야 합니다

별도의 Executor를 사용하면 느린 작업이 애플리케이션의 공용 실행 자원을 모두 차지하는 문제를 줄일 수 있습니다.

```java
ThreadPoolExecutor executor = new ThreadPoolExecutor(
    20,
    20,
    0L,
    TimeUnit.MILLISECONDS,
    new ArrayBlockingQueue<>(100),
    new ThreadPoolExecutor.AbortPolicy()
);

CompletableFuture<String> future =
    CompletableFuture.supplyAsync(
        () -> externalClient.call(),
        executor
    );
```

여기서는 실행 스레드를 20개, 대기 작업을 100개로 제한했습니다. 한도를 초과하면 무한히 쌓아두지 않고 거부합니다.

그렇다고 Executor가 느린 작업을 자동으로 끝내주는 것은 아닙니다.

전용 Executor는 동시 실행량과 장애 범위를 제한합니다. Future timeout은 결과를 기다리는 시간을 제한합니다. 실제 I/O timeout은 작업이 자원을 점유하는 시간을 제한합니다.

세 가지가 서로 다른 문제를 해결합니다.

## timeout을 조금 다르게 바라보기

처음에는 timeout을 작업의 제한 시간이라고 생각하기 쉽습니다.

하지만 `CompletableFuture`의 timeout은 작업 스레드에 내려지는 강제 종료 명령이 아닙니다. 정해진 시간 안에 결과를 받지 못했을 때 Future에 무엇을 남기고, 결과를 기다리던 코드를 어떻게 끝낼지 정하는 기능에 가깝습니다.

따라서 다음 두 질문을 나눠서 해야 합니다.

1. 결과를 기다리는 코드는 얼마나 기다릴 것인가?
2. 실제 작업은 자원을 얼마나 오래 사용할 수 있는가?

첫 번째 질문에는 `get(timeout)`, `orTimeout()`, `completeOnTimeout()`이 답할 수 있습니다.

두 번째 질문에는 HTTP·DB·소켓 timeout, 협조적 취소, 제한된 Executor와 대기열이 필요합니다.

그리고 데이터 변경이 포함된 작업이라면 질문이 하나 더 생깁니다.

3. timeout 이후 늦게 성공하거나 같은 요청이 재시도돼도 안전한가?

## 정리

`CompletableFuture` timeout을 다음처럼 이해하면 됩니다.

> 작업을 강제로 종료하는 기능이 아니라, 정해진 시간까지만 결과를 기다린 뒤 Future와 다음 로직을 어떻게 처리할지 정하는 기능

정리하면 다음과 같습니다.

- `CompletableFuture`는 작업 스레드가 아니라 결과, 예외, 취소 여부를 담는 객체입니다.
- `get(timeout)`은 결과를 기다리는 시간만 제한합니다.
- `orTimeout()`은 `TimeoutException` 예외를 발생시켜 Future를 종료합니다.
- `completeOnTimeout()`은 timeout이 발생하면 fallback 값을 결과로 사용합니다.
- 세 방식 모두 실행 중인 작업을 자동으로 종료하지 않습니다.
- `CompletableFuture.cancel(true)`도 실행 중인 람다에 interrupt를 전달해 종료시키는 기능이 아닙니다.
- 실제 작업에는 HTTP, DB, 소켓 등 해당 계층의 timeout이 필요합니다.
- 전용 Executor와 bounded queue는 느린 작업이 무제한으로 쌓이는 것을 제한합니다.
- 상태 변경 작업의 timeout은 실패가 아니라 결과를 아직 확인하지 못한 상태일 수 있습니다.

Future가 끝난 것과 실제 작업이 끝난 것을 구분하면 timeout 이후의 동작도 훨씬 명확해집니다.

다음 글에서는 timeout 이후에도 작업이 성공할 수 있는 상황에서 중복 요청과 상태 변경을 어떻게 안전하게 처리할지 알아보겠습니다.

## 참고 자료

- [Java SE 25 CompletableFuture API](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/CompletableFuture.html)
- [Java SE 25 Future API](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/Future.html)
- [Java SE 25 ExecutorService API](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/concurrent/ExecutorService.html)
