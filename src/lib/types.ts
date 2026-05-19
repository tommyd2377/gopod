export type ParsedFeed = {
  feedUrl: string;
  title: string;
  description?: string;
  link?: string;
  imageUrl?: string;
  episodes: ParsedEpisode[];
};

export type ParsedEpisode = {
  guid: string;
  title: string;
  description?: string;
  pubDate?: string;
  duration?: string;
  audioUrl: string;
  audioType?: string;
  imageUrl?: string;
  episodeUrl?: string;
};

export type SavedFeed = {
  feedUrl: string;
  title: string;
  description?: string;
  link?: string;
  imageUrl?: string;
  lastFetchedAt?: string;
};

export type EpisodePlaybackState = {
  played?: boolean;
  progress?: number;
  duration?: number;
  updatedAt?: string;
};
