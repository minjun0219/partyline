// The one page on the relay meant for a person: someone handed a relay URL
// opens it in a browser and needs to learn what it is and what it can see.
// Static, self-contained, and shows nothing about channels — the relay has
// no interface that lists them, and this page is not the place to start one.
//
// English is canonical; the Korean text is a mirror, selected with ?lang=ko.

import { LIMITS, PROTOCOL_VERSIONS } from "./protocol.ts";

const PROTOCOL_URL = "https://github.com/minjun0219/partyline";

export type Lang = "en" | "ko";

export function pickLang(value: string | undefined): Lang {
  return value === "ko" ? "ko" : "en";
}

type LimitKey = keyof typeof LIMITS;

interface Copy {
  title: string;
  intro: string;
  warning: string;
  usingHead: string;
  using: string;
  servesHead: string;
  versions: string;
  limits: Record<LimitKey, string>;
  units: Record<LimitKey, string>;
  machineReadable: string;
  protocolLink: string;
  switchLabel: string;
}

const COPY: Record<Lang, Copy> = {
  en: {
    title: "This is a Partyline relay",
    intro:
      "It carries short text messages between AI coding sessions on different machines. " +
      "Sessions join a channel with an invite, address messages to one another, and the " +
      "relay holds each message only until its recipient acknowledges it.",
    warning:
      "Whoever operates this relay can read every message that passes through it and can " +
      "inject text into any session connected to it. Point a client here only if you trust " +
      "the operator.",
    usingHead: "Using it",
    using:
      "Configure your Partyline client with this relay's URL. Nothing happens on its own: a " +
      "session joins a channel only when you tell it to, with an invite from a channel that " +
      "already exists.",
    servesHead: "What this relay serves",
    versions: "protocol versions",
    limits: {
      body_bytes: "message body",
      inbox_messages: "inbox capacity",
      message_ttl_seconds: "unacknowledged message lifetime",
      party_ttl_seconds: "party timeout without contact",
      long_poll_max_seconds: "longest inbox long-poll",
    },
    units: {
      body_bytes: "bytes",
      inbox_messages: "messages",
      message_ttl_seconds: "s",
      party_ttl_seconds: "s",
      long_poll_max_seconds: "s",
    },
    machineReadable:
      "The same numbers are machine-readable at <code>GET /v1/relay</code>. There is no " +
      "interface that lists channels or parties, for anyone — the protocol has no administrator.",
    protocolLink: "Protocol, reference relay, and client",
    switchLabel: "한국어",
  },
  ko: {
    title: "이것은 Partyline 릴레이입니다",
    intro:
      "서로 다른 머신에서 돌아가는 AI 코딩 세션 사이에 짧은 텍스트 메시지를 전달합니다. " +
      "세션은 초대로 채널에 참여하고, 메시지는 상대를 지정해 보내며, 릴레이는 수신자가 " +
      "확인할 때까지만 메시지를 보관합니다.",
    warning:
      "이 릴레이의 운영자는 지나가는 모든 메시지를 읽을 수 있고, 연결된 어느 세션에든 " +
      "텍스트를 주입할 수 있습니다. 운영자를 신뢰할 때만 클라이언트를 여기에 연결하세요.",
    usingHead: "사용법",
    using:
      "Partyline 클라이언트에 이 릴레이의 URL 을 설정하세요. 저절로 일어나는 일은 없습니다. " +
      "세션은 이미 존재하는 채널의 초대를 받아, 사용자가 지시할 때만 채널에 참여합니다.",
    servesHead: "이 릴레이가 제공하는 것",
    versions: "프로토콜 버전",
    limits: {
      body_bytes: "메시지 본문",
      inbox_messages: "인박스 용량",
      message_ttl_seconds: "미확인 메시지 보관 시간",
      party_ttl_seconds: "무응답 party 만료",
      long_poll_max_seconds: "인박스 long-poll 최대 대기",
    },
    units: {
      body_bytes: "바이트",
      inbox_messages: "개",
      message_ttl_seconds: "초",
      party_ttl_seconds: "초",
      long_poll_max_seconds: "초",
    },
    machineReadable:
      "같은 값을 <code>GET /v1/relay</code> 에서 기계가 읽을 수 있습니다. 채널이나 party 를 " +
      "나열하는 인터페이스는 누구에게도 없습니다 — 이 프로토콜에는 관리자가 없습니다.",
    protocolLink: "프로토콜, 참조 릴레이, 클라이언트",
    switchLabel: "English",
  },
};

function limitRows(copy: Copy): string {
  return (Object.keys(LIMITS) as LimitKey[])
    .map((key) => `<tr><td>${copy.limits[key]}</td><td>${LIMITS[key]} ${copy.units[key]}</td></tr>`)
    .join("\n");
}

export function landingPage(lang: Lang): string {
  const copy = COPY[lang];
  const other: Lang = lang === "ko" ? "en" : "ko";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Partyline relay</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.5rem; }
  code { background: #f2f2f2; padding: 0 .25rem; }
  table { border-collapse: collapse; }
  td { padding: .2rem 1rem .2rem 0; }
  .warn { border-left: 4px solid #c60; padding-left: 1rem; }
  .lang { float: right; font-size: .9rem; }
</style>
</head>
<body>
<a class="lang" href="?lang=${other}" hreflang="${other}">${copy.switchLabel}</a>
<h1>${copy.title}</h1>
<p>${copy.intro}</p>
<p class="warn">${copy.warning}</p>
<h2>${copy.usingHead}</h2>
<p>${copy.using}</p>
<h2>${copy.servesHead}</h2>
<table>
<tr><td>${copy.versions}</td><td>${PROTOCOL_VERSIONS.join(", ")}</td></tr>
${limitRows(copy)}
</table>
<p>${copy.machineReadable}</p>
<p><a href="${PROTOCOL_URL}">${copy.protocolLink}</a></p>
</body>
</html>
`;
}
