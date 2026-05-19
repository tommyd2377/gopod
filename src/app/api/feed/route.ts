import { NextRequest, NextResponse } from "next/server";
import { parsePodcastFeed, FeedParseError } from "@/lib/feed-parser";
import { ensurePublicFeedUrl, parseFeedUrl } from "@/lib/feed-security";
import type { ParsedFeed } from "@/lib/types";

export const runtime = "nodejs";

const FEED_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const FEED_RETRY_COUNT = 2;
const RECENT_EPISODE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

class FeedRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "FeedRequestError";
  }
}

export async function GET(request: NextRequest) {
  const validation = parseFeedUrl(request.nextUrl.searchParams.get("url"));

  if (!validation.ok) {
    return errorResponse(validation.error, validation.status);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);

  try {
    const parsedFeed = await loadAndParseFeed(validation.url, controller.signal);
    return NextResponse.json(parsedFeed);
  } catch (error) {
    if (error instanceof FeedRequestError) {
      return errorResponse(error.message, error.status);
    }

    if (error instanceof FeedParseError) {
      return errorResponse(error.message, 422);
    }

    if (error instanceof Error && error.name === "AbortError") {
      return errorResponse("Feed fetch timed out.", 504);
    }

    console.error("[api/feed] Unexpected feed error", {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Unknown",
    });

    return errorResponse("Unable to load this feed.", 500);
  } finally {
    clearTimeout(timeout);
  }
}

async function loadAndParseFeed(url: URL, signal: AbortSignal) {
  let parseError: FeedParseError | null = null;

  for (let attempt = 0; attempt <= FEED_RETRY_COUNT; attempt += 1) {
    const xml = await fetchFeedXml(url, signal);

    try {
      return limitFeedToRecentEpisodes(parsePodcastFeed(xml, url.toString()));
    } catch (error) {
      if (
        error instanceof FeedParseError &&
        error.message === "Invalid RSS/XML feed." &&
        attempt < FEED_RETRY_COUNT
      ) {
        parseError = error;
        continue;
      }

      throw error;
    }
  }

  throw parseError ?? new FeedParseError("Invalid RSS/XML feed.");
}

function limitFeedToRecentEpisodes(feed: ParsedFeed): ParsedFeed {
  const cutoff = Date.now() - RECENT_EPISODE_DAYS * MS_PER_DAY;

  return {
    ...feed,
    episodes: feed.episodes.filter((episode) =>
      isRecentEpisode(episode.pubDate, cutoff),
    ),
  };
}

function isRecentEpisode(pubDate: string | undefined, cutoff: number) {
  if (!pubDate) {
    return false;
  }

  const time = new Date(pubDate).getTime();
  return !Number.isNaN(time) && time >= cutoff;
}

async function fetchFeedXml(url: URL, signal: AbortSignal) {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const publicUrl = await ensurePublicFeedUrl(currentUrl);

    if (!publicUrl.ok) {
      throw new FeedRequestError(publicUrl.status, publicUrl.error);
    }

    const result = await fetchFeedAttempt(currentUrl, signal);

    if (result.redirectUrl) {
      currentUrl = result.redirectUrl;
      continue;
    }

    if (!result.xml.trim()) {
      throw new FeedRequestError(422, "Feed response was empty.");
    }

    return result.xml;
  }

  throw new FeedRequestError(502, "Feed had too many redirects.");
}

async function fetchFeedAttempt(url: URL, signal: AbortSignal) {
  for (let attempt = 0; attempt <= FEED_RETRY_COUNT; attempt += 1) {
    let response: Response;

    try {
      response = await fetch(url, {
        cache: "no-store",
        redirect: "manual",
        signal,
        headers: {
          accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
          "accept-encoding": "identity",
          "user-agent": "GoPod/0.1 (+https://podcast-app-livid.vercel.app)",
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }

      if (canRetryFeedError(error, attempt)) {
        continue;
      }

      throw new FeedRequestError(502, "Feed fetch failed.");
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");

      if (!location) {
        throw new FeedRequestError(502, "Feed redirect was missing a location.");
      }

      return { redirectUrl: new URL(location, url), xml: "" };
    }

    if (!response.ok) {
      throw new FeedRequestError(
        502,
        `Feed fetch failed with status ${response.status}.`,
      );
    }

    try {
      const xml = await response.text();

      if (xml.trim() && !hasCompleteFeedDocument(xml)) {
        if (attempt < FEED_RETRY_COUNT) {
          continue;
        }

        throw new FeedRequestError(502, "Feed response was interrupted.");
      }

      return { redirectUrl: null, xml };
    } catch (error) {
      if (error instanceof FeedRequestError) {
        throw error;
      }

      if (canRetryFeedError(error, attempt)) {
        continue;
      }

      throw new FeedRequestError(502, "Feed response was interrupted.");
    }
  }

  throw new FeedRequestError(502, "Feed fetch failed.");
}

function isRedirect(status: number) {
  return status >= 300 && status < 400;
}

function canRetryFeedError(error: unknown, attempt: number) {
  if (attempt >= FEED_RETRY_COUNT || !(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "TypeError" &&
    (error.message === "terminated" || error.message === "fetch failed")
  );
}

function hasCompleteFeedDocument(xml: string) {
  const normalized = xml.trim().toLowerCase();

  return normalized.includes("</rss>") || normalized.includes("</rdf:rdf>");
}

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}
