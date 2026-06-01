"use client";

/* eslint-disable @next/next/no-img-element */

import {
  type ChangeEvent,
  type FormEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  EpisodePlaybackState,
  ParsedEpisode,
  ParsedFeed,
  SavedFeed,
} from "@/lib/types";

const FEEDS_KEY = "podcastFeeds";
const CACHE_KEY = "podcastEpisodesCache";
const PLAYBACK_KEY = "podcastPlaybackState";
const ALL_EPISODES_VIEW = "all";
const EPISODE_BATCH_SIZE = 40;
const BACKUP_VERSION = 1;
const RECENT_EPISODE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const AUTO_REFRESH_STALE_MS = 15 * 60 * 1000;
const FEED_REFRESH_CONCURRENCY = 4;
const PROGRESS_SAVE_INTERVAL_MS = 10_000;

type FeedCache = Record<string, ParsedFeed>;
type PlaybackMap = Record<string, EpisodePlaybackState>;
type ViewKey = typeof ALL_EPISODES_VIEW | string;

type EpisodeWithShow = ParsedEpisode & {
  feedUrl: string;
  showTitle: string;
  showImageUrl?: string;
};

type ActivePlayback = {
  episode: EpisodeWithShow;
  isPaused: boolean;
  key: string;
};

type PodcastBackup = {
  app: "GoPod";
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  podcastFeeds: SavedFeed[];
  podcastEpisodesCache: FeedCache;
  podcastPlaybackState: PlaybackMap;
};

export function GoPodApp() {
  const [hydrated, setHydrated] = useState(false);
  const [feedInput, setFeedInput] = useState("");
  const [feeds, setFeeds] = useState<SavedFeed[]>([]);
  const [cache, setCache] = useState<FeedCache>({});
  const [playback, setPlayback] = useState<PlaybackMap>({});
  const [selectedView, setSelectedView] = useState<ViewKey>(ALL_EPISODES_VIEW);
  const [episodeLimit, setEpisodeLimit] = useState(EPISODE_BATCH_SIZE);
  const [isAdding, setIsAdding] = useState(false);
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  const [refreshingFeedUrl, setRefreshingFeedUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [isSwitchingView, setIsSwitchingView] = useState(false);
  const autoRefreshStartedRef = useRef(false);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const activeEpisodeRef = useRef<EpisodeWithShow | null>(null);
  const activeEpisodeKeyRef = useRef<string | null>(null);
  const pendingStartTimeRef = useRef<number | null>(null);
  const lastProgressSavedAtRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement>(null);
  const viewSwitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activePlayback, setActivePlayback] = useState<ActivePlayback | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) {
        return;
      }

      setFeeds(readStorage<SavedFeed[]>(FEEDS_KEY, []));
      setCache(
        pruneFeedCacheToRecentEpisodes(readStorage<FeedCache>(CACHE_KEY, {})),
      );
      setPlayback(readStorage<PlaybackMap>(PLAYBACK_KEY, {}));
      setHydrated(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (hydrated) {
      writeStorage(FEEDS_KEY, feeds);
    }
  }, [feeds, hydrated]);

  useEffect(() => {
    if (hydrated) {
      writeStorage(CACHE_KEY, cache);
    }
  }, [cache, hydrated]);

  useEffect(() => {
    if (hydrated) {
      writeStorage(PLAYBACK_KEY, playback);
    }
  }, [playback, hydrated]);

  useEffect(() => {
    if (!hydrated || autoRefreshStartedRef.current) {
      return;
    }

    autoRefreshStartedRef.current = true;

    if (feeds.length === 0) {
      return;
    }

    async function refreshFeedsOnLoad() {
      const staleFeeds = feeds.filter((feed) =>
        feedNeedsAutoRefresh(feed, cache),
      );

      if (staleFeeds.length === 0) {
        return;
      }

      setIsRefreshingAll(true);
      setError(null);

      const result = await refreshSavedFeeds(feeds, cache, staleFeeds);

      setFeeds(result.nextFeeds);
      setCache(result.nextCache);
      setIsRefreshingAll(false);
    }

    void refreshFeedsOnLoad();
  }, [cache, feeds, hydrated]);

  useEffect(() => {
    function updateScrollTopVisibility() {
      setShowScrollTop(window.scrollY > 520);
    }

    updateScrollTopVisibility();
    window.addEventListener("scroll", updateScrollTopVisibility, {
      passive: true,
    });

    return () => {
      window.removeEventListener("scroll", updateScrollTopVisibility);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (viewSwitchTimerRef.current) {
        clearTimeout(viewSwitchTimerRef.current);
      }
    };
  }, []);

  function saveActiveProgress(audio: HTMLAudioElement, force = false) {
    const episode = activeEpisodeRef.current;

    if (!episode) {
      return;
    }

    const now = Date.now();

    if (!force && now - lastProgressSavedAtRef.current < PROGRESS_SAVE_INTERVAL_MS) {
      return;
    }

    lastProgressSavedAtRef.current = now;
    const episodeKey = getEpisodeKey(episode);

    setPlayback((currentPlayback) => ({
      ...currentPlayback,
      [episodeKey]: {
        ...currentPlayback[episodeKey],
        progress: Math.floor(audio.currentTime || 0),
        duration: Number.isFinite(audio.duration)
          ? Math.floor(audio.duration)
          : currentPlayback[episodeKey]?.duration,
        updatedAt: new Date().toISOString(),
      },
    }));
  }

  function pauseAndClearActiveAudio() {
    const player = playerRef.current;

    if (player) {
      saveActiveProgress(player, true);
      player.pause();
      player.removeAttribute("src");
      player.load();
    }

    activeEpisodeRef.current = null;
    activeEpisodeKeyRef.current = null;
    pendingStartTimeRef.current = null;
    setActivePlayback(null);
    clearMediaSession();
  }

  const allEpisodes = useMemo(
    () => buildEpisodeList(feeds, cache),
    [cache, feeds],
  );

  const selectedFeed = feeds.find((feed) => feed.feedUrl === selectedView);
  const visibleEpisodes = useMemo(() => {
    if (selectedView === ALL_EPISODES_VIEW) {
      return allEpisodes;
    }

    return allEpisodes.filter((episode) => episode.feedUrl === selectedView);
  }, [allEpisodes, selectedView]);
  const displayedEpisodes = visibleEpisodes.slice(0, episodeLimit);
  const hasMoreEpisodes = visibleEpisodes.length > displayedEpisodes.length;
  const hasLongFeedList = feeds.length > 8;
  const selectedFeedIsRefreshing = Boolean(
    selectedFeed && refreshingFeedUrl === selectedFeed.feedUrl,
  );
  const isActivelyLoadingEpisodes =
    !hydrated || isRefreshingAll || selectedFeedIsRefreshing || isSwitchingView;
  const selectedFeedNeedsRefresh = Boolean(
    hydrated && selectedFeed && !cache[selectedFeed.feedUrl],
  );
  const allEpisodesNeedRefresh = Boolean(
    hydrated &&
      selectedView === ALL_EPISODES_VIEW &&
      feeds.length > 0 &&
      allEpisodes.length === 0 &&
      feeds.some((feed) => !cache[feed.feedUrl]),
  );
  const showEpisodeLoadingState =
    feeds.length > 0 &&
    visibleEpisodes.length === 0 &&
    isActivelyLoadingEpisodes;
  const showEpisodeLoadingStrip =
    feeds.length > 0 &&
    visibleEpisodes.length > 0 &&
    isActivelyLoadingEpisodes;

  async function playEpisode(episode: EpisodeWithShow) {
    const player = playerRef.current;

    if (!player) {
      setError("Audio player is still loading.");
      return;
    }

    const episodeKey = getEpisodeKey(episode);
    const isSameEpisode = activeEpisodeKeyRef.current === episodeKey;

    setError(null);

    if (!isSameEpisode) {
      saveActiveProgress(player, true);
      player.pause();
      activeEpisodeRef.current = episode;
      activeEpisodeKeyRef.current = episodeKey;
      pendingStartTimeRef.current = playback[episodeKey]?.progress ?? 0;
      lastProgressSavedAtRef.current = 0;
      player.src = episode.audioUrl;
      player.load();
    } else {
      activeEpisodeRef.current = episode;
    }

    setActivePlayback({
      episode,
      isPaused: false,
      key: episodeKey,
    });
    updateMediaSession(episode, player);

    try {
      await player.play();
      updateMediaSessionState(player, "playing");
    } catch {
      setActivePlayback({
        episode,
        isPaused: true,
        key: episodeKey,
      });
      updateMediaSessionState(player, "paused");
      setError("Unable to start playback.");
    }
  }

  function handlePlayerPlay() {
    const player = playerRef.current;
    const episode = activeEpisodeRef.current;

    if (!player || !episode) {
      return;
    }

    const episodeKey = getEpisodeKey(episode);
    activeEpisodeKeyRef.current = episodeKey;
    setActivePlayback({
      episode,
      isPaused: false,
      key: episodeKey,
    });
    updateMediaSession(episode, player);
  }

  function handlePlayerPause(audio: HTMLAudioElement) {
    if (!activeEpisodeRef.current) {
      return;
    }

    saveActiveProgress(audio, true);
    setActivePlayback((currentPlayback) =>
      currentPlayback
        ? {
            ...currentPlayback,
            isPaused: true,
          }
        : currentPlayback,
    );
    updateMediaSessionState(audio, "paused");
  }

  function handlePlayerEnded(audio: HTMLAudioElement) {
    const episode = activeEpisodeRef.current;

    if (episode) {
      const episodeKey = getEpisodeKey(episode);

      setPlayback((currentPlayback) => ({
        ...currentPlayback,
        [episodeKey]: {
          ...currentPlayback[episodeKey],
          played: true,
          progress: Math.floor(audio.duration || 0),
          duration: Math.floor(audio.duration || 0),
          updatedAt: new Date().toISOString(),
        },
      }));
    }

    updateMediaSessionState(audio, "none");
    activeEpisodeRef.current = null;
    activeEpisodeKeyRef.current = null;
    pendingStartTimeRef.current = null;
    setActivePlayback(null);
  }

  function handlePlayerLoadedMetadata(audio: HTMLAudioElement) {
    const episode = activeEpisodeRef.current;

    if (!episode) {
      return;
    }

    const progress =
      pendingStartTimeRef.current ?? playback[getEpisodeKey(episode)]?.progress ?? 0;
    const duration = audio.duration;

    if (progress > 0 && (!duration || progress < duration - 2)) {
      audio.currentTime = progress;
    }

    pendingStartTimeRef.current = null;
    updateMediaSessionPosition(audio);
  }

  function handlePlayerTimeUpdate(audio: HTMLAudioElement) {
    saveActiveProgress(audio);
    updateMediaSessionPosition(audio);
  }

  function toggleActivePlayback() {
    const player = playerRef.current;

    if (!player || !activeEpisodeRef.current) {
      setActivePlayback(null);
      activeEpisodeKeyRef.current = null;
      return;
    }

    if (player.paused) {
      void player.play().catch(() => {
        setError("Unable to resume playback.");
      });
      return;
    }

    player.pause();
  }

  function jumpToActiveEpisode() {
    const activeEpisodeKey = activeEpisodeKeyRef.current;

    if (!activeEpisodeKey) {
      return;
    }

    const scrollToEpisode = () => {
      const episodeElement = document.getElementById(
        getEpisodeElementId(activeEpisodeKey),
      );

      if (!episodeElement) {
        return false;
      }

      episodeElement.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      return true;
    };

    if (scrollToEpisode()) {
      return;
    }

    const activeEpisode = activeEpisodeRef.current;

    if (!activeEpisode) {
      return;
    }

    selectView(activeEpisode.feedUrl);
    window.setTimeout(scrollToEpisode, 220);
  }

  async function addFeed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextFeedUrl = feedInput.trim();

    if (!nextFeedUrl) {
      setError("Paste a podcast RSS feed URL first.");
      setMessage(null);
      return;
    }

    setIsAdding(true);
    setError(null);
    setMessage(null);

    try {
      const parsedFeed = await loadFeed(nextFeedUrl);
      const savedFeed = toSavedFeed(parsedFeed);

      setFeeds((currentFeeds) => {
        const withoutExisting = currentFeeds.filter(
          (feed) => feed.feedUrl !== savedFeed.feedUrl,
        );
        return [...withoutExisting, savedFeed].sort((a, b) =>
          a.title.localeCompare(b.title),
        );
      });
      setCache((currentCache) => ({
        ...currentCache,
        [savedFeed.feedUrl]: parsedFeed,
      }));
      setSelectedView(savedFeed.feedUrl);
      setEpisodeLimit(EPISODE_BATCH_SIZE);
      setFeedInput("");
      setMessage(`Added ${savedFeed.title}.`);
    } catch (feedError) {
      setError(getErrorMessage(feedError));
    } finally {
      setIsAdding(false);
    }
  }

  async function refreshFeed(feedUrl: string) {
    const savedFeed = feeds.find((feed) => feed.feedUrl === feedUrl);

    if (!savedFeed) {
      return;
    }

    setRefreshingFeedUrl(feedUrl);
    setError(null);
    setMessage(null);

    try {
      const parsedFeed = await loadFeed(feedUrl);
      const nextSavedFeed = toSavedFeed(parsedFeed);

      setFeeds((currentFeeds) =>
        currentFeeds.map((feed) =>
          feed.feedUrl === feedUrl ? nextSavedFeed : feed,
        ),
      );
      setCache((currentCache) => ({
        ...currentCache,
        [nextSavedFeed.feedUrl]: parsedFeed,
      }));
      setMessage(`Refreshed ${nextSavedFeed.title}.`);
    } catch (feedError) {
      setError(getErrorMessage(feedError));
    } finally {
      setRefreshingFeedUrl(null);
    }
  }

  async function refreshAllFeeds() {
    if (feeds.length === 0) {
      setError("Add your first podcast RSS feed.");
      setMessage(null);
      return;
    }

    setIsRefreshingAll(true);
    setError(null);
    setMessage(null);

    const result = await refreshSavedFeeds(feeds, cache, feeds);

    setFeeds(result.nextFeeds);
    setCache(result.nextCache);
    setIsRefreshingAll(false);

    if (result.failedFeeds.length > 0) {
      setError(getRefreshFailureMessage(result.failedFeeds.length));
    } else {
      setMessage("All feeds refreshed.");
    }
  }

  function removeFeed(feedUrl: string) {
    const feed = feeds.find((candidate) => candidate.feedUrl === feedUrl);

    if (activePlayback?.episode.feedUrl === feedUrl) {
      pauseAndClearActiveAudio();
    }

    setFeeds((currentFeeds) =>
      currentFeeds.filter((candidate) => candidate.feedUrl !== feedUrl),
    );
    setCache((currentCache) => {
      const nextCache = { ...currentCache };
      delete nextCache[feedUrl];
      return nextCache;
    });

    if (selectedView === feedUrl) {
      setSelectedView(ALL_EPISODES_VIEW);
      setEpisodeLimit(EPISODE_BATCH_SIZE);
    }

    setMessage(feed ? `Removed ${feed.title}.` : null);
    setError(null);
  }

  function updatePlayback(
    episode: ParsedEpisode,
    nextState: EpisodePlaybackState,
  ) {
    const key = getEpisodeKey(episode);

    setPlayback((currentPlayback) => ({
      ...currentPlayback,
      [key]: {
        ...currentPlayback[key],
        ...nextState,
        updatedAt: new Date().toISOString(),
      },
    }));
  }

  function selectView(view: ViewKey) {
    if (viewSwitchTimerRef.current) {
      clearTimeout(viewSwitchTimerRef.current);
    }

    setIsSwitchingView(true);
    setSelectedView(view);
    setEpisodeLimit(EPISODE_BATCH_SIZE);
    viewSwitchTimerRef.current = setTimeout(() => {
      setIsSwitchingView(false);
    }, 180);
  }

  function exportData() {
    const backup: PodcastBackup = {
      app: "GoPod",
      exportedAt: new Date().toISOString(),
      podcastEpisodesCache: cache,
      podcastFeeds: feeds,
      podcastPlaybackState: playback,
      version: BACKUP_VERSION,
    };
    const exportedAt = backup.exportedAt.slice(0, 10);
    const blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `gopod-backup-${exportedAt}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setError(null);
    setMessage(`Exported ${feeds.length} saved feeds.`);
  }

  function openImportPicker() {
    importInputRef.current?.click();
  }

  async function importData(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    setError(null);
    setMessage(null);

    try {
      const backup = parseBackup(await file.text());
      const hasExistingData =
        feeds.length > 0 ||
        Object.keys(cache).length > 0 ||
        Object.keys(playback).length > 0;

      if (
        hasExistingData &&
        !window.confirm("Import this backup and replace local podcast data?")
      ) {
        return;
      }

      setFeeds([...backup.podcastFeeds].sort(sortFeedsByTitle));
      setCache(backup.podcastEpisodesCache);
      setPlayback(backup.podcastPlaybackState);
      setSelectedView(ALL_EPISODES_VIEW);
      setEpisodeLimit(EPISODE_BATCH_SIZE);
      setMessage(`Imported ${backup.podcastFeeds.length} saved feeds.`);
    } catch (backupError) {
      setError(getErrorMessage(backupError));
    }
  }

  function scrollToTop() {
    window.scrollTo({
      behavior: "smooth",
      top: 0,
    });
  }

  return (
    <main className={`app-shell ${activePlayback ? "has-now-playing" : ""}`}>
      <header className="app-header">
        <div>
          <p className="eyebrow">Local RSS player</p>
          <BrandTitle />
        </div>
        <button
          className="button secondary-button"
          disabled={isRefreshingAll || feeds.length === 0}
          onClick={refreshAllFeeds}
          type="button"
        >
          {isRefreshingAll ? "Refreshing..." : "Refresh All"}
        </button>
      </header>

      <form className="feed-form" onSubmit={addFeed}>
        <label className="sr-only" htmlFor="feed-url">
          Podcast RSS feed URL
        </label>
        <input
          autoCapitalize="none"
          autoComplete="url"
          autoCorrect="off"
          id="feed-url"
          inputMode="url"
          onChange={(event) => setFeedInput(event.target.value)}
          placeholder="Paste podcast RSS feed URL"
          type="url"
          value={feedInput}
        />
        <button className="button primary-button" disabled={isAdding} type="submit">
          {isAdding ? "Adding..." : "Add Feed"}
        </button>
      </form>

      <section className="backup-tools" aria-label="Local backup tools">
        <div>
          <p className="eyebrow">Backup</p>
          <h2>Local data</h2>
        </div>
        <div className="backup-actions">
          <button
            className="button secondary-button compact-action"
            disabled={!hydrated}
            onClick={exportData}
            type="button"
          >
            Export
          </button>
          <button
            className="button secondary-button compact-action"
            disabled={!hydrated}
            onClick={openImportPicker}
            type="button"
          >
            Import
          </button>
          <input
            accept="application/json,.json"
            className="sr-only"
            onChange={importData}
            ref={importInputRef}
            type="file"
          />
        </div>
      </section>

      {(error || message) && (
        <p className={error ? "notice error-notice" : "notice success-notice"}>
          {error ?? message}
        </p>
      )}

      <div className="content-grid">
        <aside className="shows-panel" aria-label="Saved shows">
          <div className="panel-heading">
            <h2>Shows</h2>
            <span>{feeds.length}</span>
          </div>

          {hasLongFeedList && (
            <label className="show-picker">
              <span>Jump to show</span>
              <select
                onChange={(event) => selectView(event.target.value)}
                value={selectedView}
              >
                <option value={ALL_EPISODES_VIEW}>
                  All Episodes ({allEpisodes.length})
                </option>
                {feeds.map((feed) => (
                  <option key={feed.feedUrl} value={feed.feedUrl}>
                    {feed.title}
                  </option>
                ))}
              </select>
            </label>
          )}

          <button
            className={`show-button all-episodes-button ${
              selectedView === ALL_EPISODES_VIEW ? "active" : ""
            }`}
            onClick={() => selectView(ALL_EPISODES_VIEW)}
            type="button"
          >
            <span className="show-art text-art">All</span>
            <span>
              <strong>All Episodes</strong>
              <small>{allEpisodes.length} episodes</small>
            </span>
          </button>

          <nav className="show-list" aria-label="Podcast views">
            {feeds.map((feed) => (
              <div className="show-row" key={feed.feedUrl}>
                <button
                  className={`show-button ${
                    selectedView === feed.feedUrl ? "active" : ""
                  }`}
                  onClick={() => selectView(feed.feedUrl)}
                  type="button"
                >
                  <ShowArt feed={feed} />
                  <span>
                    <strong>{feed.title}</strong>
                    <small>{getFeedEpisodeLabel(feed, cache, refreshingFeedUrl)}</small>
                  </span>
                </button>
                <div className="show-actions">
                  <button
                    className="text-button"
                    disabled={refreshingFeedUrl === feed.feedUrl}
                    onClick={() => refreshFeed(feed.feedUrl)}
                    type="button"
                  >
                    {refreshingFeedUrl === feed.feedUrl ? "..." : "Refresh"}
                  </button>
                  <button
                    className="text-button remove-button"
                    onClick={() => removeFeed(feed.feedUrl)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <section className="episodes-panel" aria-live="polite">
          <div className="episodes-heading">
            <div>
              <p className="eyebrow">
                {selectedFeed ? selectedFeed.title : "All Episodes"}
              </p>
              <h2>
                {showEpisodeLoadingState
                  ? "Loading episodes"
                  : visibleEpisodes.length === 1
                  ? "1 episode"
                  : `${visibleEpisodes.length} episodes`}
              </h2>
            </div>
          </div>

          {!hydrated && <EmptyState text="Loading your saved feeds." />}

          {showEpisodeLoadingStrip && (
            <LoadingState text={getLoadingMessage(isRefreshingAll, selectedFeed)} />
          )}

          {hydrated && feeds.length === 0 && (
            <EmptyState text="Add your first podcast RSS feed." />
          )}

          {showEpisodeLoadingState && (
            <LoadingState text={getLoadingMessage(isRefreshingAll, selectedFeed)} />
          )}

          {hydrated &&
            feeds.length > 0 &&
            visibleEpisodes.length === 0 &&
            !showEpisodeLoadingState &&
            (selectedFeedNeedsRefresh || allEpisodesNeedRefresh) && (
              <EmptyState text="Refresh to load episodes." />
            )}

          {hydrated &&
            feeds.length > 0 &&
            visibleEpisodes.length === 0 &&
            !showEpisodeLoadingState &&
            !selectedFeedNeedsRefresh &&
            !allEpisodesNeedRefresh && (
            <EmptyState text="No episodes found." />
          )}

          <div className="episode-list">
            {displayedEpisodes.map((episode) => (
              <EpisodeCard
                activePlayback={activePlayback}
                episode={episode}
                key={`${episode.feedUrl}:${getEpisodeKey(episode)}`}
                onPlayEpisode={playEpisode}
                onPlaybackChange={updatePlayback}
                onToggleActivePlayback={toggleActivePlayback}
                playbackState={playback[getEpisodeKey(episode)]}
              />
            ))}

            {hasMoreEpisodes && (
              <button
                className="button secondary-button load-more-button"
                onClick={() =>
                  setEpisodeLimit((currentLimit) =>
                    Math.min(
                      currentLimit + EPISODE_BATCH_SIZE,
                      visibleEpisodes.length,
                    ),
                  )
                }
                type="button"
              >
                Show more
              </button>
            )}
          </div>
        </section>
      </div>

      {showScrollTop && (
        <button
          aria-label="Scroll to top"
          className={`scroll-top-button ${
            activePlayback ? "with-now-playing" : ""
          }`}
          onClick={scrollToTop}
          type="button"
        >
          Top
        </button>
      )}

      <NowPlayingBar
        activePlayback={activePlayback}
        audioRef={playerRef}
        onAudioEnded={handlePlayerEnded}
        onAudioLoadedMetadata={handlePlayerLoadedMetadata}
        onAudioPause={handlePlayerPause}
        onAudioPlay={handlePlayerPlay}
        onAudioTimeUpdate={handlePlayerTimeUpdate}
        onJump={jumpToActiveEpisode}
        onTogglePlayback={toggleActivePlayback}
      />
    </main>
  );
}

function BrandTitle() {
  return (
    <h1 className="brand-title" aria-label="GoPod">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 64 64" focusable="false">
          <path d="M20 30c8 0 15 7 15 15" />
          <path d="M20 17c16 0 28 12 28 28" />
          <circle cx="20" cy="45" r="5.5" />
        </svg>
      </span>
      <span className="brand-word" aria-hidden="true">
        <span>Go</span>
        <span>Pod</span>
      </span>
    </h1>
  );
}

function EpisodeCard({
  activePlayback,
  episode,
  onPlayEpisode,
  onPlaybackChange,
  onToggleActivePlayback,
  playbackState,
}: {
  activePlayback: ActivePlayback | null;
  episode: EpisodeWithShow;
  onPlayEpisode: (episode: EpisodeWithShow) => void;
  onPlaybackChange: (
    episode: ParsedEpisode,
    nextState: EpisodePlaybackState,
  ) => void;
  onToggleActivePlayback: () => void;
  playbackState?: EpisodePlaybackState;
}) {
  const description = getDescriptionPreview(episode.description);
  const episodeKey = getEpisodeKey(episode);
  const played = Boolean(playbackState?.played);
  const isCurrentEpisode = activePlayback?.key === episodeKey;

  function toggleEpisodePlayback() {
    if (isCurrentEpisode && !activePlayback?.isPaused) {
      onToggleActivePlayback();
      return;
    }

    void onPlayEpisode(episode);
  }

  return (
    <article
      className={`episode-card ${played ? "played-card" : ""}`}
      id={getEpisodeElementId(episodeKey)}
    >
      <div className="episode-meta">
        <span>{episode.showTitle}</span>
        <span>{formatDate(episode.pubDate)}</span>
        {episode.duration && <span>{formatDuration(episode.duration)}</span>}
      </div>

      <h3>{episode.title}</h3>
      {description && <p className="episode-description">{description}</p>}

      <div className="episode-actions">
        <button
          className={`button compact-button ${
            isCurrentEpisode && !activePlayback?.isPaused ? "played-button" : ""
          }`}
          onClick={toggleEpisodePlayback}
          type="button"
        >
          {getEpisodePlayLabel(isCurrentEpisode, activePlayback, playbackState)}
        </button>
        <button
          aria-pressed={played}
          className={`button compact-button ${played ? "played-button" : ""}`}
          onClick={() =>
            onPlaybackChange(episode, {
              played: !played,
            })
          }
          type="button"
        >
          {played ? "Played" : "Unplayed"}
        </button>
        {playbackState?.progress ? (
          <span className="progress-note">
            {formatProgress(playbackState.progress)}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function NowPlayingBar({
  activePlayback,
  audioRef,
  onAudioEnded,
  onAudioLoadedMetadata,
  onAudioPause,
  onAudioPlay,
  onAudioTimeUpdate,
  onJump,
  onTogglePlayback,
}: {
  activePlayback: ActivePlayback | null;
  audioRef: RefObject<HTMLAudioElement | null>;
  onAudioEnded: (audio: HTMLAudioElement) => void;
  onAudioLoadedMetadata: (audio: HTMLAudioElement) => void;
  onAudioPause: (audio: HTMLAudioElement) => void;
  onAudioPlay: () => void;
  onAudioTimeUpdate: (audio: HTMLAudioElement) => void;
  onJump: () => void;
  onTogglePlayback: () => void;
}) {
  return (
    <aside
      aria-hidden={!activePlayback}
      aria-label="Now playing"
      className="now-playing-bar"
      hidden={!activePlayback}
    >
      <div className="now-playing-copy">
        <span>{activePlayback?.episode.showTitle ?? "GoPod"}</span>
        <strong>{activePlayback?.episode.title ?? "No episode selected"}</strong>
      </div>
      <div className="now-playing-actions">
        <button
          className="text-button"
          disabled={!activePlayback}
          onClick={onJump}
          type="button"
        >
          Jump
        </button>
        <button
          className="button compact-button"
          disabled={!activePlayback}
          onClick={onTogglePlayback}
          type="button"
        >
          {activePlayback?.isPaused ? "Resume" : "Pause"}
        </button>
      </div>
      <audio
        className="global-audio-player"
        controls
        onEnded={(event) => onAudioEnded(event.currentTarget)}
        onLoadedMetadata={(event) => onAudioLoadedMetadata(event.currentTarget)}
        onPause={(event) => onAudioPause(event.currentTarget)}
        onPlay={onAudioPlay}
        onTimeUpdate={(event) => onAudioTimeUpdate(event.currentTarget)}
        playsInline
        preload="none"
        ref={audioRef}
      />
    </aside>
  );
}

function ShowArt({ feed }: { feed: SavedFeed }) {
  if (feed.imageUrl) {
    return <img alt="" className="show-art" src={feed.imageUrl} />;
  }

  return <span className="show-art text-art">{feed.title.slice(0, 2)}</span>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

function LoadingState({ text }: { text: string }) {
  return (
    <div className="loading-state">
      <span className="loading-spinner" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

function getLoadingMessage(isRefreshingAll: boolean, selectedFeed?: SavedFeed) {
  if (isRefreshingAll) {
    return "Refreshing feeds...";
  }

  if (selectedFeed) {
    return "Loading episodes...";
  }

  return "Loading all episodes...";
}

function getRefreshFailureMessage(failedFeedCount: number) {
  return failedFeedCount === 1
    ? "Could not refresh 1 feed. Showing saved episodes where available."
    : `Could not refresh ${failedFeedCount} feeds. Showing saved episodes where available.`;
}

function getFeedEpisodeLabel(
  feed: SavedFeed,
  cache: FeedCache,
  refreshingFeedUrl: string | null,
) {
  if (refreshingFeedUrl === feed.feedUrl) {
    return "Refreshing...";
  }

  const episodeCount = cache[feed.feedUrl]?.episodes.length;

  if (typeof episodeCount !== "number") {
    return "Not loaded";
  }

  return episodeCount === 1 ? "1 episode" : `${episodeCount} episodes`;
}

function getEpisodePlayLabel(
  isCurrentEpisode: boolean,
  activePlayback: ActivePlayback | null,
  playbackState?: EpisodePlaybackState,
) {
  if (isCurrentEpisode) {
    return activePlayback?.isPaused ? "Resume" : "Pause";
  }

  return playbackState?.progress ? "Resume" : "Play";
}

async function loadFeed(feedUrl: string) {
  const response = await fetch(`/api/feed?url=${encodeURIComponent(feedUrl)}`);
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;

  if (!response.ok) {
    throw new Error(payload?.error || "Unable to load this feed.");
  }

  return payload as ParsedFeed;
}

async function refreshSavedFeeds(
  allFeeds: SavedFeed[],
  currentCache: FeedCache,
  feedsToRefresh: SavedFeed[],
) {
  const nextCache: FeedCache = { ...currentCache };
  const refreshedFeeds = new Map<string, SavedFeed>();
  const failedFeeds: string[] = [];

  await runWithConcurrency(
    feedsToRefresh,
    FEED_REFRESH_CONCURRENCY,
    async (feed) => {
      try {
        const parsedFeed = await loadFeed(feed.feedUrl);
        const nextSavedFeed = toSavedFeed(parsedFeed);

        refreshedFeeds.set(feed.feedUrl, nextSavedFeed);

        if (feed.feedUrl !== nextSavedFeed.feedUrl) {
          delete nextCache[feed.feedUrl];
        }

        nextCache[nextSavedFeed.feedUrl] = parsedFeed;
      } catch {
        failedFeeds.push(feed.title);
      }
    },
  );

  return {
    failedFeeds,
    nextCache,
    nextFeeds: allFeeds
      .map((feed) => refreshedFeeds.get(feed.feedUrl) ?? feed)
      .sort(sortFeedsByTitle),
  };
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        await worker(item);
      }
    }),
  );
}

function toSavedFeed(feed: ParsedFeed): SavedFeed {
  return {
    feedUrl: feed.feedUrl,
    title: feed.title,
    description: feed.description,
    link: feed.link,
    imageUrl: feed.imageUrl,
    lastFetchedAt: new Date().toISOString(),
  };
}

function sortFeedsByTitle(a: SavedFeed, b: SavedFeed) {
  return a.title.localeCompare(b.title);
}

function buildEpisodeList(feeds: SavedFeed[], cache: FeedCache) {
  const episodesByKey = new Map<string, EpisodeWithShow>();
  const cutoff = getRecentEpisodeCutoff();

  for (const feed of feeds) {
    const parsedFeed = cache[feed.feedUrl];

    if (!parsedFeed) {
      continue;
    }

    for (const episode of parsedFeed.episodes) {
      if (!isRecentEpisode(episode.pubDate, cutoff)) {
        continue;
      }

      const key = getEpisodeKey(episode);

      if (!episodesByKey.has(key)) {
        episodesByKey.set(key, {
          ...episode,
          feedUrl: feed.feedUrl,
          showTitle: feed.title,
          showImageUrl: feed.imageUrl,
        });
      }
    }
  }

  return Array.from(episodesByKey.values()).sort((a, b) => {
    const aDate = getSortableDate(a.pubDate);
    const bDate = getSortableDate(b.pubDate);

    if (aDate !== bDate) {
      return bDate - aDate;
    }

    return a.title.localeCompare(b.title);
  });
}

function pruneFeedCacheToRecentEpisodes(cache: FeedCache) {
  const cutoff = getRecentEpisodeCutoff();
  const nextCache: FeedCache = {};

  for (const [feedUrl, feed] of Object.entries(cache)) {
    nextCache[feedUrl] = {
      ...feed,
      episodes: feed.episodes.filter((episode) =>
        isRecentEpisode(episode.pubDate, cutoff),
      ),
    };
  }

  return nextCache;
}

function getEpisodeKey(episode: Pick<ParsedEpisode, "guid" | "audioUrl">) {
  return episode.guid || episode.audioUrl;
}

function getEpisodeElementId(episodeKey: string) {
  let hash = 0;

  for (let index = 0; index < episodeKey.length; index += 1) {
    hash = (hash * 31 + episodeKey.charCodeAt(index)) >>> 0;
  }

  return `episode-${hash.toString(36)}`;
}

function getSortableDate(pubDate?: string) {
  if (!pubDate) {
    return 0;
  }

  const time = new Date(pubDate).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getRecentEpisodeCutoff() {
  return Date.now() - RECENT_EPISODE_DAYS * MS_PER_DAY;
}

function isRecentEpisode(pubDate: string | undefined, cutoff: number) {
  return getSortableDate(pubDate) >= cutoff;
}

function feedNeedsAutoRefresh(feed: SavedFeed, cache: FeedCache) {
  if (!cache[feed.feedUrl]) {
    return true;
  }

  if (!feed.lastFetchedAt) {
    return true;
  }

  const lastFetchedAt = new Date(feed.lastFetchedAt).getTime();

  return (
    Number.isNaN(lastFetchedAt) ||
    Date.now() - lastFetchedAt >= AUTO_REFRESH_STALE_MS
  );
}

function formatDate(pubDate?: string) {
  const time = getSortableDate(pubDate);

  if (!time) {
    return "Undated";
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(time));
}

function formatProgress(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function formatDuration(duration: string) {
  const trimmedDuration = duration.trim();

  if (!/^\d+$/.test(trimmedDuration)) {
    return trimmedDuration;
  }

  const totalSeconds = Number(trimmedDuration);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function updateMediaSession(episode: EpisodeWithShow, audio: HTMLAudioElement) {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") {
    return;
  }

  const artworkUrl = episode.imageUrl ?? episode.showImageUrl;
  const artwork = artworkUrl
    ? [
        { src: artworkUrl, sizes: "96x96" },
        { src: artworkUrl, sizes: "128x128" },
        { src: artworkUrl, sizes: "192x192" },
        { src: artworkUrl, sizes: "256x256" },
        { src: artworkUrl, sizes: "512x512" },
      ]
    : [];

  navigator.mediaSession.metadata = new MediaMetadata({
    title: episode.title,
    artist: episode.showTitle,
    album: "GoPod",
    artwork,
  });

  updateMediaSessionState(audio, audio.paused ? "paused" : "playing");
  // Keep play/pause on the browser's native media element path so lock-screen
  // controls can resume audio even when the page is backgrounded.
  setMediaSessionHandler("play", null);
  setMediaSessionHandler("pause", null);
  setMediaSessionHandler("seekbackward", (details) => {
    audio.currentTime = Math.max(
      0,
      audio.currentTime - (details.seekOffset ?? 10),
    );
    updateMediaSessionPosition(audio);
  });
  setMediaSessionHandler("seekforward", (details) => {
    const nextTime = audio.currentTime + (details.seekOffset ?? 10);
    audio.currentTime = Number.isFinite(audio.duration)
      ? Math.min(audio.duration, nextTime)
      : nextTime;
    updateMediaSessionPosition(audio);
  });
  setMediaSessionHandler("seekto", (details) => {
    if (typeof details.seekTime !== "number") {
      return;
    }

    audio.currentTime = details.seekTime;
    updateMediaSessionPosition(audio);
  });
}

function updateMediaSessionState(
  audio: HTMLAudioElement,
  playbackState: MediaSessionPlaybackState,
) {
  if (!("mediaSession" in navigator)) {
    return;
  }

  navigator.mediaSession.playbackState = playbackState;
  updateMediaSessionPosition(audio);
}

function updateMediaSessionPosition(audio: HTMLAudioElement) {
  if (
    !("mediaSession" in navigator) ||
    !Number.isFinite(audio.duration) ||
    audio.duration <= 0
  ) {
    return;
  }

  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: audio.currentTime,
    });
  } catch {
    // Some mobile browsers expose Media Session but reject position updates.
  }
}

function clearMediaSession() {
  if (!("mediaSession" in navigator)) {
    return;
  }

  navigator.mediaSession.playbackState = "none";
  navigator.mediaSession.metadata = null;
  setMediaSessionHandler("play", null);
  setMediaSessionHandler("pause", null);
  setMediaSessionHandler("seekbackward", null);
  setMediaSessionHandler("seekforward", null);
  setMediaSessionHandler("seekto", null);
}

function setMediaSessionHandler(
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
) {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // Unsupported lock-screen actions can be ignored; native audio still works.
  }
}

function getDescriptionPreview(description?: string) {
  if (!description) {
    return "";
  }

  const plainText = description
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return plainText.length > 220 ? `${plainText.slice(0, 217)}...` : plainText;
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage<T>(key: string, value: T) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Local persistence is best-effort; playback should keep working in memory.
  }
}

function parseBackup(rawBackup: string): PodcastBackup {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBackup);
  } catch {
    throw new Error("Choose a valid GoPod backup JSON file.");
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.podcastFeeds)) {
    throw new Error("This backup file does not look like GoPod data.");
  }

  const podcastFeeds = parsed.podcastFeeds;

  if (!podcastFeeds.every(isSavedFeed)) {
    throw new Error("This backup has invalid podcast feed data.");
  }

  return {
    app: "GoPod",
    exportedAt:
      typeof parsed.exportedAt === "string"
        ? parsed.exportedAt
        : new Date().toISOString(),
    podcastEpisodesCache: pruneFeedCacheToRecentEpisodes(
      parseFeedCache(parsed.podcastEpisodesCache),
    ),
    podcastFeeds,
    podcastPlaybackState: parsePlaybackMap(parsed.podcastPlaybackState),
    version: BACKUP_VERSION,
  };
}

function parseFeedCache(value: unknown): FeedCache {
  if (!isRecord(value)) {
    return {};
  }

  const nextCache: FeedCache = {};

  for (const [feedUrl, feed] of Object.entries(value)) {
    if (isParsedFeed(feed)) {
      nextCache[feedUrl] = feed;
    }
  }

  return nextCache;
}

function parsePlaybackMap(value: unknown): PlaybackMap {
  if (!isRecord(value)) {
    return {};
  }

  const nextPlayback: PlaybackMap = {};

  for (const [episodeKey, state] of Object.entries(value)) {
    if (isPlaybackState(state)) {
      nextPlayback[episodeKey] = state;
    }
  }

  return nextPlayback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSavedFeed(value: unknown): value is SavedFeed {
  return (
    isRecord(value) &&
    typeof value.feedUrl === "string" &&
    typeof value.title === "string"
  );
}

function isParsedFeed(value: unknown): value is ParsedFeed {
  return (
    isRecord(value) &&
    typeof value.feedUrl === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.episodes)
  );
}

function isPlaybackState(value: unknown): value is EpisodePlaybackState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (typeof value.played === "undefined" ||
      typeof value.played === "boolean") &&
    (typeof value.progress === "undefined" ||
      typeof value.progress === "number") &&
    (typeof value.duration === "undefined" ||
      typeof value.duration === "number")
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
