import type { ParsedEpisode, ParsedFeed } from "./types";

export const RECENT_EPISODE_DAYS = 14;
export const EPISODE_BATCH_SIZE = 40;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function episodeTimestamp(pubDate?: string) {
  const time = pubDate ? new Date(pubDate).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

export function recentEpisodes(episodes: ParsedEpisode[], now = Date.now()) {
  const cutoff = now - RECENT_EPISODE_DAYS * MS_PER_DAY;
  return episodes.filter((episode) => episodeTimestamp(episode.pubDate) >= cutoff);
}

export function compareEpisodes(a: ParsedEpisode, b: ParsedEpisode) {
  return episodeTimestamp(b.pubDate) - episodeTimestamp(a.pubDate) ||
    a.title.localeCompare(b.title);
}

export function archivePage(feed: ParsedFeed, offset: number): ParsedFeed {
  const episodes = Array.from(new Map(
    feed.episodes.map((episode) => [episode.guid || episode.audioUrl, episode]),
  ).values()).sort(compareEpisodes);
  const nextOffset = offset + EPISODE_BATCH_SIZE;
  return {
    ...feed,
    episodes: episodes.slice(offset, nextOffset),
    totalEpisodes: episodes.length,
    nextOffset: nextOffset < episodes.length ? nextOffset : null,
  };
}
