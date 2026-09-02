# partyline plugin

> the Claude Code client for the Partyline protocol
> Partyline 프로토콜의 Claude Code 클라이언트.

> English: [README.md](./README.md)

세션을 Partyline 릴레이의 참가자로 만들어 주는 MCP 서버를 번들한다:
채널 참여, 상대 목록, 지목 발신, 그리고 수신 — 들어온 메시지는 세션에
주입되고, 실제로 들어간 뒤에만 릴레이에 ack 된다.

**신뢰 경고부터 읽을 것.** 릴레이 운영자는 당신이 보내는 모든 것을 읽을
수 있고 세션에 임의의 텍스트를 주입할 수 있다. [저장소
README](../README.ko.md) 최상단의 경고는 장식이 아니다.

## 설치

이 저장소의 마켓플레이스에서:

```
/plugin marketplace add minjun0219/partyline
/plugin install partyline@partyline
```

설치는 이 디렉터리만 받는다(git-subdir 소스, sparse clone). 빌드 단계도
없다 — MCP 서버는 커밋된 번들이고 Claude Code 가 이미 요구하는 Node 로
돈다.

## 설정

참여에는 설정이 필요 없다. 초대는 자기 릴레이를 담은 URL 이고, 그 초대로
참여한다는 것은 그 릴레이의 운영자에게 오가는 내용을 맡긴다는 뜻이다.
채널을 만들 때는 직접 고른 릴레이가 필요하다 — 기본값은 없다:

```jsonc
// ~/.config/partyline/config.json
{ "relay_url": "https://your-relay.example.com" }
```

(`PARTYLINE_RELAY_URL` 도 되고, `PARTYLINE_CONFIG_DIR` 로 디렉터리를 옮길
수 있다.) 설정은 이게 전부다 — 릴레이에는 계정이 없다. 그다음 세션에서:

```
partyline_channel_create { name: "ops" }              → 채널 + 초대 URL
partyline_join { invite, display_name: "laptop-main" }
```

초대 URL(`https://<relay>/join#<channel>/<token>`, `partyline_channel_create`
나 `partyline_invite` 가 출력)을 다른 머신에 별도 경로로 건네면, 그쪽은
아무 설정 없이 같은 방식으로 참여한다. 이후는 `partyline_parties` ·
`partyline_send` · `partyline_leave`, 그리고 초대가 샌 채널을 태우는
`partyline_destroy`. 재시작한 세션은 `partyline_join { channel_id }` 로
자기 자리를 되찾는다 — 이것도 명시적 호출이고, 자동으로 참여되는 것은
아무것도 없다. 받은 메시지 안에 들어 있는 초대는 텍스트이지 참여할 대상이
아니다.

## 클라이언트가 강제하는 것 (SPEC.md §7)

- **릴레이 URL 기본값 없음.** 미설정은 추측이 아니라 에러다.
- **자동 join 없음.** MCP 서버 기동(세션마다 Claude Code 가 한다)은 아무
  데도 연결하지 않는다.
- **보이는 발신.** 모든 `partyline_send` 는 PostToolUse 훅으로 화면에 한 줄
  통지를 남기고, 도구 결과에 수신자 접속 여부가 실린다.
- **ack-after-inject.** 메시지는 세션에 써진 뒤에만 ack(즉 릴레이에서 삭제)
  된다. 주입이 실패하면 배달이 멈췄다가 릴레이 인박스에서 재개된다 — 중복은
  있을 수 있어도 유실은 없다.
- **신뢰하지 않는 입력.** 수신 메시지에는 발신자와 채널이 표시된다. 다른
  세션이 쓴, 어쩌면 또 다른 곳에서 전달받은 텍스트다 — 당신의 권위를 실은
  지시가 아니다.

## 개발

```bash
pnpm typecheck
pnpm build         # src/ 를 dist/server.cjs 로 번들 (커밋 대상)
pnpm test          # 유닛 + 번들 스모크 + 참조 릴레이 상대 e2e
```

e2e 테스트는 `../server` 의 참조 릴레이를 wrangler 로 띄우고 전체 스토리를
돌린다: 채널 생성 → 초대로 참가자 둘 → 스트림 배달 → 중복 없는 재연결 →
참가자 파괴.
