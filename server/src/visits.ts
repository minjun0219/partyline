// Optional page-view counting for the relay's own pages: the front page, the
// invite landing page, and llms.txt. It is the operator's choice and off
// unless both POSTHOG_KEY and POSTHOG_HOST are set — there is no default
// host to report to. The relay sends the event itself, so the pages stay
// free of scripts, and the event carries only what the request already
// showed: the page, the referring site, and the user agent. No IP address,
// no query string, no cookie, and nothing from /v1, where the protocol lives.

export interface PostHog {
  key: string;
  /** Ingestion host without a trailing slash. */
  host: string;
}

/** Both values or nothing: either one alone does not say where to report. */
export function postHogOf(env: { POSTHOG_KEY?: string; POSTHOG_HOST?: string }): PostHog | null {
  const key = env.POSTHOG_KEY?.trim();
  const host = env.POSTHOG_HOST?.trim().replace(/\/+$/, "");
  return key && host ? { key, host } : null;
}

/**
 * The capture call for one page view. With no cookie and no IP address there
 * is nothing that ties two requests together, so each event is its own
 * visitor and its own session.
 */
export function pageview(
  posthog: PostHog,
  request: Request,
  now = Date.now(),
): [string, RequestInit] {
  const url = new URL(request.url);
  const referrer = referringSite(request.headers.get("Referer"));
  const id = uuidv7(now);
  return [
    `${posthog.host}/i/v0/e/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: posthog.key,
        event: "$pageview",
        distinct_id: id,
        properties: {
          $current_url: url.origin + url.pathname,
          $host: url.host,
          $pathname: url.pathname,
          $referrer: referrer?.origin ?? "$direct",
          $referring_domain: referrer?.host ?? "$direct",
          // PostHog tells people from crawlers and AI agents by this.
          $raw_user_agent: request.headers.get("User-Agent") ?? undefined,
          $session_id: id,
          $lib: "partyline-relay",
          $process_person_profile: false,
          // The capture request comes from the relay, so a lookup would place
          // every visitor wherever the relay runs.
          $geoip_disable: true,
        },
      }),
    },
  ];
}

/** The referring site only, never its path or query. */
function referringSite(referer: string | null): { origin: string; host: string } | null {
  if (!referer) return null;
  try {
    const { protocol, origin, host } = new URL(referer);
    return protocol === "https:" || protocol === "http:" ? { origin, host } : null;
  } catch {
    return null;
  }
}

/** RFC 9562 version 7, the form PostHog's own SDKs use for these ids. */
function uuidv7(now: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
