# partyline-server

> the reference relay for the Partyline protocol, on Cloudflare Workers
> Partyline 프로토콜 참조 릴레이 — Cloudflare Workers 구현.

> English: [README.md](./README.md)

[`SPEC.md`](../SPEC.md) 의 규범 요구사항 전부를 구현한다: capability
모델(§3), 초대와 참가자 주도 파괴가 있는 비공개 채널(§4), 수신자 블록을
돌려주는 지목 발신(§5), 두 가지 수신 전송과 ack 커서(§6), 릴레이
요구사항(§8). 테스트 스위트는 스펙 절 번호 기준으로 짜여 있어 사실상
적합성 스위트를 겸한다.

## 구성

- `src/index.ts` — HTTP 표면(Hono). 파싱, 비인증 입구의 소스별 rate
  limit, 상태 매핑만 하는 얇은 층.
- `src/channel.ts` — 채널당 하나의 Durable Object: 참가자, 초대, 인박스,
  WebSocket 스트림, 롱폴, 스윕 alarm, 파괴.
- `src/gate.ts` — 릴레이당 하나의 Durable Object: 채널 생성·join 시도의
  소스별 rate limit.
- `test/` — 스펙 절 이름을 딴 적합성 스타일 테스트.

## 직접 세우기

```bash
pnpm install
pnpm test          # 적합성 스위트 (로컬, 계정 불필요)
wrangler deploy
```

이게 전부다 — 릴레이는 설계상 어드민리스라(SPEC §8) 설정할 시크릿도
관리할 계정도 없다. 다른 머신을 들이는 건 릴레이 URL 과 채널 초대를
건네는 일이다.

URL 을 아는 사람은 누구나 릴레이에 채널을 만들 수 있지만(소스별 rate
limit 으로 제한), 초대 없이는 어떤 채널에도 어떤 세션에도 닿지 못한다.
그 자원 노출이 부담스러우면 Worker 앞에 접근 계층을 세우면 된다 —
프로토콜이 의도적으로 밖에 남겨둔 운영 선택지다.

이 저장소 어디에도 릴레이 URL 기본값은 없다 — 클라이언트는 당신 배포를
명시적으로 가리킨다. 누군가를 초대하기 전에 [저장소 README](../README.ko.md)
의 신뢰 경고를 먼저 읽을 것.

## 개발

```bash
pnpm dev        # workerd 로컬 릴레이
pnpm typecheck
pnpm test
```

테스트는 `@cloudflare/vitest-pool-workers` 로 Workers 런타임 안에서, 테스트별
격리 스토리지로 돈다 — Cloudflare 계정이 필요 없다.
