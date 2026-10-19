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

이게 전부다 — 릴레이는 설계상 어드민리스라(SPEC §8) 설정할 것도
관리할 계정도 없다. 다른 머신을 들이는 건 릴레이 URL 과 채널 초대를
건네는 일이다.

URL 을 아는 사람은 누구나 릴레이에 채널을 만들 수 있지만(소스별 rate
limit 으로 제한), 초대 없이는 어떤 채널에도 어떤 세션에도 닿지 못한다.
그 자원 노출이 부담스러우면 유일한 선택적 시크릿으로 릴레이를 닫는다:

```bash
wrangler secret put RELAY_KEY
```

키가 설정되면 채널 생성에 그 키가 필요하고(`Authorization: Bearer`),
`GET /v1/relay` 는 `"closed": true` 를 알린다. 채널을 만드는 사람은 모두
같은 키를 클라이언트 설정의 `relay_key` 에 적는다. 초대는 키 없이도
그대로 통한다 — 키는 여기서 채널을 열 수 있는 사람을 가르지, 채널에
있을 수 있는 사람을 가르지 않는다 — 그리고 교체는 새 키를 설정하고
다시 나눠 주는 일이다. 일부러 공유 키 하나다: 계정도, 사용자별로
회수할 것도 없다. 그 이상이 필요하면 Worker 앞에 접근 계층을 세우는
것이고, 그건 프로토콜이 의도적으로 밖에 남겨둔 영역이다 — 그 계층의 자격은
플러그인 설정의 `relay_headers` 로 싣는다. 로컬에서는
`pnpm dev` 가 `.dev.vars`(gitignore 됨) 에서 키를 읽는다.

이 저장소 어디에도 릴레이 URL 기본값은 없다 — 클라이언트는 당신 배포를
명시적으로 가리킨다. 누군가를 초대하기 전에 [저장소 README](../README.ko.md)
의 신뢰 경고를 먼저 읽을 것.

## 페이지 조회 집계 (선택)

사람이든 에이전트든 누가 릴레이를 찾아오는지 알고 싶은 운영자는 릴레이 자신의
페이지(`/`, `/join`, `/llms.txt`) 요청을 [PostHog](https://posthog.com)
프로젝트로 보내게 할 수 있다. 두 값을 모두 설정해야 켜지고, 기본 호스트는 없다:

```bash
wrangler deploy --var POSTHOG_KEY:<프로젝트 토큰> --var POSTHOG_HOST:<수집 호스트>
```

`POSTHOG_HOST`는 프로젝트의 수집 호스트(`https://us.i.posthog.com` 또는
`https://eu.i.posthog.com`)나 그 앞에 둔 프록시다. 프로젝트 토큰은 웹 페이지에
그대로 넣는 공개 값이라 둘 다 시크릿이 아닌 일반 변수로 둔다. 배포는 넘겨받지
않은 일반 변수를 지운다. 두 플래그를 매번 넘기거나 Cloudflare 대시보드에서
설정하고 `wrangler deploy --keep-vars`로 배포한다. 로컬에서는 `pnpm dev`가
`.dev.vars`에서 두 값을 읽는다. 테스트는 그 파일과 관계없이 집계가 꺼진 상태로
실행된다.

이벤트는 응답을 보낸 뒤 릴레이가 직접 보낸다. 그래서 페이지는 스크립트를
불러오지 않으며 보내기에 실패해도 페이지에는 영향이 없다. 이벤트에 담기는 것은
쿼리 문자열을 뺀 페이지 URL, 들어온 사이트의 origin, User-Agent다. PostHog는
User-Agent로 사람과 크롤러, AI 에이전트를 가른다. IP 주소는 보내지 않고 GeoIP
조회도 끈다. 릴레이는 쿠키를 쓰지 않으며 `/v1` 아래 요청은 어떤 것도 보내지
않는다. 두 요청을 묶을 단서가 없으므로 PostHog는 페이지 조회 하나하나를 각각의
방문자와 세션으로 센다. 집계를 켜 두면 페이지와 `llms.txt`가 그 사실을 알린다.

## 개발

```bash
pnpm dev        # workerd 로컬 릴레이
pnpm typecheck
pnpm test
```

테스트는 `@cloudflare/vitest-pool-workers` 로 Workers 런타임 안에서, 테스트별
격리 스토리지로 돈다 — Cloudflare 계정이 필요 없다.

빌드를 릴레이에 올리기 전에 실제 머신들로 두드려 보려면
`wrangler deploy --env preview` 가 같은 코드를 저장소·시크릿이 독립된 두 번째
Worker 로 배포한다. Durable Object 를 쓰는 Worker 에는 버전 프리뷰 URL 이 생기지
않아서, 프로덕션의 프리뷰가 아니라 온전한 배포로 둔 것이다.
