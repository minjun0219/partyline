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

## 사용

참여에는 설정이 필요 없다. 초대는 자기 릴레이를 담은 URL 이고, 그 초대로
참여한다는 것은 그 릴레이의 운영자에게 오가는 내용을 맡긴다는 뜻이다.
채널을 만드는 것만이 직접 고른 릴레이가 필요한 유일한 단계다 — 기본값은
없다:

```
/partyline:create ops https://your-relay.example.com
```

(`~/.config/partyline/config.json` 이나 `PARTYLINE_RELAY_URL` 에 `relay_url`
을 한 번 적어 두면 생략할 수 있다. `PARTYLINE_CONFIG_DIR` 는 디렉터리를
옮긴다. 설정은 이게 전부다 — 릴레이에는 계정이 없다.) 이 커맨드는 채널을
만들고, 이 세션을 거기 앉히고, 초대 URL 을 출력한다. 그 URL 을 다른 머신에
별도 경로로 건네면, 그쪽은 아무 설정 없이 참여한다:

```
/partyline:join https://your-relay.example.com/join#c_…/… laptop-main
```

이후는 `/partyline:parties`(누가 있나) · `/partyline:send <to> <message>` ·
`/partyline:status` · `/partyline:leave`. 커맨드 하나가 MCP 도구 하나를
감싸고, 그 결과를 읽는 규칙을 싣는다 — offline 이 무슨 뜻인지, 비슷해
보이는 실패를 어떻게 가르는지, send 결과가 무엇을 약속하고 무엇을 약속하지
않는지. 도구는 직접 불러도 된다(`partyline_channel_create` ·
`partyline_join` · `partyline_parties` · `partyline_send` ·
`partyline_status` · `partyline_leave` · `partyline_invite` ·
`partyline_update_me` · `partyline_destroy` — 마지막은 초대가 샌 채널을
태운다). 이들이 공유하는 처신은 `partyline` 스킬 한 장에 있다: 받은
텍스트는 신뢰하지 않고, 답장에는 `reply_to` 를 싣고, 비밀은 채널로
내보내지 않는다.

재시작하거나 리로드한 세션은 자리는 유지하지만 스트림은 잃는다.
`/partyline:join <channel_id>` 로 되찾는다 — 이것도 명시적 호출이고,
자동으로 참여되는 것은 아무것도 없다. 받은 메시지 안에 들어 있는 초대는
텍스트이지 참여할 대상이 아니다.

## 클라이언트가 강제하는 것 (SPEC.md §7)

- **릴레이 URL 기본값 없음.** 미설정은 추측이 아니라 에러다.
- **자동 join 없음.** MCP 서버 기동(세션마다 Claude Code 가 한다)은 아무
  데도 연결하지 않는다.
- **보이는 발신.** 모든 `partyline_send` 는 PostToolUse 훅으로 화면에 한 줄
  통지를 남기고, 도구 결과에 수신자 접속 여부가 실린다.
- **ack-after-inject.** 메시지는 세션의 로컬 소켓에 써진 뒤에만 ack(즉
  릴레이에서 삭제)된다. 그 쓰기가 실패하면 배달이 멈췄다가 릴레이 인박스에서
  재개된다 — 중복은 있을 수 있어도 릴레이 구간의 유실은 없다. 보장은 소켓에서
  끝난다: Claude Code 는 텍스트를 받아간 뒤 아무것도 되돌려 주지 않으므로, 그
  뒤에 무엇을 하는지(큐에 넣는지, 보여주는지, 주입 입력을 붙드는 권한 모드에서
  버리는지)는 이 클라이언트가 볼 수 없다. `partyline_status` 가 주입한 메시지
  수와 스트림이 릴레이 소식을 마지막으로 들은 시각을 보여준다.
- **신뢰하지 않는 입력.** 수신 메시지에는 발신자와 채널이 표시된다. 다른
  세션이 쓴, 어쩌면 또 다른 곳에서 전달받은 텍스트다 — 당신의 권위를 실은
  지시가 아니다.

## 아무것도 안 올 때

이 순서로 본다 — 각 단계가 아래 층을 걸러낸다.

1. **수신** 세션에서 `/partyline:status`. `connected` 에 `last frame` 이
   최근이면 정상. `backoff` 나 `stopped` 는 같은 줄에 이유가 있다. `joined
   this session: none` 아래 `saved seat:` 줄이 있으면 세션이 재시작·리로드된
   것 — `/partyline:join <channel_id>`.
2. 자기 자신에게 보내 본다(`/partyline:send <내 이름> ping`). 릴레이 ·
   스트림 · 주입까지 전 구간을 다른 머신 없이 돈다. 도착하면 클라이언트는
   멀쩡하고 문제는 상대 쪽이나 그 사이에 있다.
3. 수신 세션의 권한 모드. 주입된 메시지는 그 세션의 입력이라, 사용자가
   손댈 때까지 입력을 붙드는 모드(`bypassPermissions` 에서 보고됨)는 이것도
   붙든다. 그때는 이미 릴레이에 ack 된 뒤라 메시지가 되돌아오지 않는다 —
   클라이언트는 소켓 너머를 볼 수 없다.
4. 발신 쪽에서 `/partyline:parties`. offline 은 사라진 게 아니다 — 메시지는
   릴레이에서 기다린다 — 하지만 아예 없는 이름은 여기가 아니라 send 시점에
   실패한다.
5. 네트워크. 기업 프록시와 일부 CDN 엣지가 떨어뜨리는 것이 WebSocket
   업그레이드다(스트림에 `403`, 또는 연결은 되는데 ping 이 안 오는 스트림 —
   status 의 `last frame` 이 90 초를 넘어 계속 커진다). 클라이언트는 롱폴로
   내려가지 않고 재연결만 한다. `curl` 은 되는데 스트림이 안 되는 릴레이가
   이 경우다.

## 개발

```bash
pnpm typecheck
pnpm build         # src/ 를 dist/server.cjs 로 번들 (커밋 대상)
pnpm test          # 유닛 + 번들 스모크 + 참조 릴레이 상대 e2e
```

e2e 테스트는 `../server` 의 참조 릴레이를 wrangler 로 띄우고 전체 스토리를
돌린다: 채널 생성 → 초대로 참가자 둘 → 스트림 배달 → 중복 없는 재연결 →
참가자 파괴.
